import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseService } from "../src/database.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { AuthService } from "../src/auth.service.js";
import { users } from "../src/db/schema.js";
import { parseProperties } from "../src/config/properties.js";

test("system management enforces permissions, durable statistics, bounded logs and revisioned configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-system-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  await writeFile(path.join(root, "package.json"), '{"version":"0.1.0"}');
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const db = app.get(DatabaseService),
    config = app.get(ConfigurationService),
    auth = app.get(AuthService),
    server = app.getHttpAdapter().getInstance();
  const tokens: Record<string, string> = {};
  for (const role of ["system_admin", "operation_admin", "user"] as const) {
    const row = db.db
      .insert(users)
      .values({ username: role, displayName: role, role })
      .returning()
      .get();
    tokens[role] = (await auth.issue(row)).token;
  }
  const request = (
    role: string,
    method: string,
    url: string,
    payload?: unknown,
  ) =>
    server.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer " + tokens[role] },
    });
  const admin = (method: string, url: string, payload?: unknown) =>
    request("system_admin", method, url, payload);
  try {
    await t.test(
      "all management endpoints enforce roles even for forged mutations",
      async () => {
        for (const url of [
          "/api/records/statistics",
          "/api/records/jobs",
          "/api/system/logs",
          "/api/system/logs/server.log/download",
        ])
          assert.equal(
            (await request("user", "GET", url)).statusCode,
            403,
            url,
          );
        for (const url of [
          "/api/system/configuration",
          "/api/system/business-settings",
          "/api/system/runtime",
          "/api/platform-connections",
        ])
          assert.equal(
            (await request("operation_admin", "GET", url)).statusCode,
            403,
            url,
          );
        for (const [method, url, payload] of [
          ["PATCH", "/api/records/jobs/1", { note: "x", handled: true }],
          ["PATCH", "/api/system/configuration", {}],
          [
            "PATCH",
            "/api/system/business-settings",
            { ttlDays: 5, deleteRemote: false },
          ],
          ["PATCH", "/api/platform-connections/feishu-calendar", {}],
          ["DELETE", "/api/system/logs/server.log", undefined],
          ["POST", "/api/system/runtime/operations", { action: "restart" }],
        ] as const)
          assert.equal(
            (await request("operation_admin", method, url, payload)).statusCode,
            403,
            url,
          );
      },
    );
    await t.test(
      "successes survive retries and record deletion; Beijing midnight boundaries are exclusive",
      async () => {
        db.recordMeetingSuccess(1001, "created", "2030-05-01T15:59:59Z");
        db.recordMeetingSuccess(1001, "created", "2030-05-01T16:00:01Z");
        db.recordMeetingSuccess(1002, "created", "2030-05-01T16:00:00Z");
        db.recordMeetingSuccess(1001, "cancelled", "2030-05-01T16:30:00Z");
        const id = Number(
          db.connection
            .prepare(
              "INSERT INTO jobs(type,status,created_at) VALUES('meeting.provision','failed','2030-05-01 16:00:01')",
            )
            .run().lastInsertRowid,
        );
        let result = (
          await admin(
            "GET",
            "/api/records/statistics?from=2030-05-02&to=2030-05-02",
          )
        ).json();
        assert.equal(result.created, 1);
        assert.equal(result.cancelled, 1);
        assert.equal(result.failed, 1);
        const previous = (
          await admin(
            "GET",
            "/api/records/statistics?from=2030-05-01&to=2030-05-01",
          )
        ).json();
        assert.equal(previous.created, 1);
        assert.equal(
          (await admin("DELETE", "/api/records/jobs/" + id)).statusCode,
          200,
        );
        result = (
          await admin(
            "GET",
            "/api/records/statistics?from=2030-05-02&to=2030-05-02",
          )
        ).json();
        assert.equal(result.created, 1);
        assert.equal(result.cancelled, 1);
        assert.equal(result.failed, 0);
        assert.equal(
          (await admin("GET", "/api/records/statistics?from=2030-99-01"))
            .statusCode,
          400,
        );
        assert.equal(
          (
            await admin(
              "GET",
              "/api/records/statistics?from=2030-02-02&to=2030-02-01",
            )
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      "filters are parameterized, annotations cannot alter execution results, and active jobs are retained",
      async () => {
        const id = Number(
          db.connection
            .prepare(
              "INSERT INTO jobs(type,status,error,payload_json) VALUES('meeting.cancel','failed','temporary error','{\"secretKey\":\"hidden\"}')",
            )
            .run().lastInsertRowid,
        );
        const active = Number(
          db.connection
            .prepare(
              "INSERT INTO jobs(type,status) VALUES('meeting.cancel','running')",
            )
            .run().lastInsertRowid,
        );
        assert.equal(
          (
            await admin("PATCH", `/api/records/jobs/${id}`, {
              note: "已核对",
              handled: true,
              status: "success",
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await admin("PATCH", `/api/records/jobs/${id}`, {
              note: "已核对",
              handled: true,
            })
          ).statusCode,
          200,
        );
        const filtered = (
          await request(
            "operation_admin",
            "GET",
            "/api/records/jobs?type=meeting.cancel&status=failed&q=" +
              encodeURIComponent("已核对"),
          )
        ).json();
        assert.equal(filtered.total, 1);
        assert.equal(filtered.items[0].status, "failed");
        assert.equal(filtered.items[0].handled, 1);
        assert.equal("payloadJson" in filtered.items[0], false);
        assert.equal(
          (
            await admin(
              "GET",
              "/api/records/jobs?q=" + encodeURIComponent("' OR 1=1 --"),
            )
          ).json().total,
          0,
        );
        assert.equal(
          (await admin("DELETE", "/api/records/jobs/" + active)).statusCode,
          409,
        );
        await admin("POST", "/api/records/jobs/clear", {
          throughId: active,
          filters: { type: "meeting.cancel", status: "failed" },
        });
        assert.equal(
          db.connection.prepare("SELECT 1 FROM jobs WHERE id=?").get(id),
          undefined,
        );
        assert.ok(
          db.connection.prepare("SELECT 1 FROM jobs WHERE id=?").get(active),
        );
        assert.equal(
          db.connection
            .prepare(
              "SELECT 1 FROM record_annotations WHERE kind='jobs' AND record_id=?",
            )
            .get(id),
          undefined,
        );
      },
    );
    await t.test(
      "log listing never reads bodies and tail/download reject symlinks, traversal and nonlogs",
      async () => {
        const log = path.join(root, "logs", "server.log"),
          history = path.join(root, "logs", "server.log.1");
        await writeFile(
          log,
          Array.from({ length: 1500 }, (_, i) => "line-" + i).join("\n") + "\n",
        );
        await writeFile(history, "history");
        await writeFile(path.join(root, "secret.txt"), "private");
        await symlink(
          path.join(root, "secret.txt"),
          path.join(root, "logs", "linked.log"),
        );
        const listing = (
          await request("operation_admin", "GET", "/api/system/logs")
        ).json();
        assert.equal(listing.length, 2);
        assert.equal(listing[0].text, undefined);
        const tail = (
          await request("operation_admin", "GET", "/api/system/logs/server.log")
        ).json();
        assert.equal(tail.text.split("\n").length, 200);
        assert.ok(tail.text.startsWith("line-1300"));
        assert.equal(tail.truncated, true);
        assert.equal(
          (await admin("GET", "/api/system/logs/server.log?lines=300"))
            .statusCode,
          400,
        );
        for (const name of ["linked.log", "secret.txt", "..%2Fsecret.txt"])
          assert.notEqual(
            (await admin("GET", "/api/system/logs/" + name)).statusCode,
            200,
          );
        assert.equal(
          (
            await request(
              "operation_admin",
              "GET",
              "/api/system/logs/server.log.1/download",
            )
          ).body,
          "history",
        );
        const inode = (await stat(log)).ino;
        await admin("DELETE", "/api/system/logs/server.log");
        assert.equal((await stat(log)).ino, inode);
        assert.equal((await stat(log)).size, 0);
        await admin("DELETE", "/api/system/logs/server.log.1");
        assert.equal(
          (await admin("GET", "/api/system/logs/server.log.1")).statusCode,
          404,
        );
        await writeFile(log, "x".repeat(2 * 1024 * 1024) + "\nlast line\n");
        const large = (
          await admin("GET", "/api/system/logs/server.log?lines=1000")
        ).json();
        assert.ok(Buffer.byteLength(large.text) <= 1024 * 1024);
        assert.ok(large.text.endsWith("last line"));
      },
    );
    await t.test(
      "configuration preserves secrets, rejects races, shows effective values and migrates recording independently",
      async () => {
        const jwt = config.get("auth.jwt-secret");
        let view = (await admin("GET", "/api/system/configuration")).json();
        assert.equal(view.values["auth.jwt-secret"], undefined);
        assert.equal(view.effective["auth.jwt-secret"], undefined);
        assert.equal(view.encryptionKeyConfigured, true);
        const saved = await admin("PATCH", "/api/system/configuration", {
          revision: view.revision,
          values: {
            "web.port": "25321",
            "feishu.login.app-secret": "test-private-secret",
          },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        view = saved.json();
        assert.equal(view.values["web.port"], "25321");
        assert.equal(view.effective["web.port"], "15173");
        assert.deepEqual(view.pendingRestart, ["web.port"]);
        assert.equal(view.values["feishu.login.app-secret"], "********");
        const concurrent = await Promise.all([
          admin("PATCH", "/api/system/configuration", {
            revision: view.revision,
            values: { "platform.name": "A" },
          }),
          admin("PATCH", "/api/system/configuration", {
            revision: view.revision,
            values: { "platform.name": "B" },
          }),
        ]);
        assert.deepEqual(
          concurrent.map((r) => r.statusCode).sort(),
          [200, 409],
        );
        view = (await admin("GET", "/api/system/configuration")).json();
        await admin("PATCH", "/api/system/configuration", {
          revision: view.revision,
          values: { "feishu.login.app-secret": "********" },
        });
        assert.equal(
          config.get("feishu.login.app-secret"),
          "test-private-secret",
        );
        assert.equal(config.get("auth.jwt-secret"), jwt);
        assert.equal(
          (
            await admin("PATCH", "/api/system/configuration", {
              revision: view.revision,
              values: { "auth.jwt-secret": "bad" },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await admin("PATCH", "/api/system/business-settings", {
              ttlDays: 90,
              deleteRemote: false,
            })
          ).statusCode,
          200,
        );
        assert.deepEqual(db.recordingSettings(), {
          ttlDays: 90,
          deleteRemote: false,
        });
        const file = parseProperties(await readFile(config.filePath, "utf8"));
        assert.equal(file["recording.ttl-days"], undefined);
        assert.equal(file["recording.delete-remote"], undefined);
        const runtime = (await admin("GET", "/api/system/runtime")).json();
        assert.equal(
          runtime.mode,
          runtime.maintenance.available ? "systemd" : "standalone",
        );
        assert.equal(runtime.worker.enabled, false);
        assert.ok(runtime.bootId);
        assert.equal(
          (
            await admin("POST", "/api/system/runtime/operations", {
              action: "exec",
              command: "id",
            })
          ).statusCode,
          400,
        );
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.AGENDA_LINK_WORKSPACE;
  }
});

test("historical success backfill and recording migration preserve confirmed data only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-backfill-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  let db: DatabaseService | undefined;
  try {
    let config = new ConfigurationService();
    const jwt = config.get("auth.jwt-secret");
    await writeFile(
      config.filePath,
      (await readFile(config.filePath, "utf8")) +
        "recording.ttl-days=73\nrecording.delete-remote=false\n",
    );
    config = new ConfigurationService();
    db = new DatabaseService(config);
    assert.deepEqual(db.recordingSettings(), {
      ttlDays: 73,
      deleteRemote: false,
    });
    db.setState(
      "recording.settings",
      JSON.stringify({ ttlDays: 55, deleteRemote: true }),
    );
    db.connection
      .prepare(
        "DELETE FROM system_state WHERE key='management.events.migrated'",
      )
      .run();
    // 模拟尚未执行管理记录迁移的旧库，重新打开时应该补跑一次。
    db.connection.prepare("DELETE FROM schema_migrations WHERE version=3").run();
    db.connection
      .prepare(
        "INSERT INTO audit_logs(action,detail) VALUES('meeting.provisioned','{\"id\":73}'),('meeting.provisioned','{\"id\":73}'),('meeting.cancelled','73'),('meeting.provisioned','bad')",
      )
      .run();
    db.onModuleDestroy();
    db = undefined;
    config = new ConfigurationService();
    db = new DatabaseService(config);
    assert.deepEqual(db.recordingSettings(), {
      ttlDays: 55,
      deleteRemote: true,
    });
    assert.equal(config.get("auth.jwt-secret"), jwt);
    const rows = db.connection
      .prepare("SELECT * FROM meeting_success_events")
      .all();
    assert.equal(rows.length, 2);
    db.onModuleDestroy();
    db = undefined;
    config = new ConfigurationService();
    db = new DatabaseService(config);
    assert.equal(
      db.connection
        .prepare("SELECT count(*) AS n FROM meeting_success_events")
        .get()!.n,
      2,
    );
  } finally {
    db?.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
    delete process.env.AGENDA_LINK_WORKSPACE;
  }
});
