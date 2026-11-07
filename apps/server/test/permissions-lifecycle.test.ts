import {PlatformConnectionService} from "../src/platform-connection.service.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { AuthService } from "../src/auth.service.js";
import { DatabaseService } from "../src/database.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { MeetingService } from "../src/meeting.service.js";
import { CalendarService } from "../src/calendar.service.js";
import { WorkerService } from "../src/worker.service.js";
import { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { PlatformError } from "../src/platforms/shared/http.js";
import {
  auditLogs,
  calendarEvents,
  jobs,
  meetingAccounts,
  meetingAttendees,
  meetings,
  recordings,
  syncRuns,
  users,
} from "../src/db/schema.js";

test("management permissions, record cleanup and schedule lifecycle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-permissions-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication(),
    db = app.get(DatabaseService),
    auth = app.get(AuthService);
  const server = app.getHttpAdapter().getInstance(),
    booking = app.get(MeetingService),
    calendar = app.get(CalendarService),
    worker = app.get(WorkerService);
  app.get(PlatformConnectionService).update("tencent-meeting",{appId:"app",sdkId:"sdk",secretId:"key",secretKey:"secret",operatorId:"operator"});
  app.get(PlatformConnectionService).update("feishu-calendar",{appId:"app",appSecret:"secret",calendarId:"calendar"});
  const actors: Record<string, { id: number; token: string }> = {};
  for (const [name, role] of [
    ["admin", "system_admin"],
    ["operator", "operation_admin"],
    ["owner", "user"],
    ["stranger", "user"],
  ] as const) {
    const row = db.db
      .insert(users)
      .values({ username: name, displayName: name, role })
      .returning()
      .get();
    actors[name] = { id: row.id, token: (await auth.issue(row)).token };
  }
  const request = (
    actor: string,
    method: string,
    url: string,
    payload?: unknown,
  ) =>
    server.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer " + actors[actor]!.token },
    });
  const startAt = "2035-01-01T01:00:00.000Z",
    endAt = "2035-01-01T02:00:00.000Z";
  const account = db.db
    .insert(meetingAccounts)
    .values({
      name: "主持账号",
      accountId: "host",
      verifiedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  const meeting = (status: typeof meetings.$inferInsert.status = "scheduled") =>
    db.db
      .insert(meetings)
      .values({
        subject: "会议",
        startAt,
        endAt,
        createdBy: actors.owner!.id,
        meetingAccountId: account.id,
        status,
        externalMeetingId: "remote-meeting",
        calendarEventId: "remote-event",
        calendarId: "remote-calendar",calendarConnectionId:"feishu-calendar",
        providerResponseJson: '{"password":"private-secret"}',
      })
      .returning()
      .get();
  let key = 0;
  const event = (status = "synced") =>
    db.db
      .insert(calendarEvents)
      .values({
        subject: "日程",
        startAt,
        endAt,
        createdBy: actors.owner!.id,
        status,
        requestKey: "calendar-key-" + ++key,
        payloadJson: JSON.stringify({ subject: "日程", startAt, endAt }),
        calendarEventId: "event",
        calendarId: "calendar",
      })
      .returning()
      .get();
  let remoteCancels = 0;
  app.get(TencentAdapter).cancel = async () => {
    remoteCancels++;
  };
  app.get(FeishuAdapter).deleteEvent = async () => {};
  try {
    await t.test(
      "record readers and deleters are enforced by the API",
      async () => {
        const audit = db.db
          .insert(auditLogs)
          .values({ action: "test.record", actorId: String(actors.admin!.id) })
          .returning()
          .get();
        for (const kind of ["audit", "sync", "jobs"]) {
          assert.equal(
            (await request("owner", "GET", `/api/records/${kind}`)).statusCode,
            403,
          );
          assert.equal(
            (await request("operator", "GET", `/api/records/${kind}`))
              .statusCode,
            200,
          );
          assert.equal(
            (await request("operator", "DELETE", `/api/records/${kind}/1`))
              .statusCode,
            403,
          );
          assert.equal(
            (
              await request("operator", "POST", `/api/records/${kind}/clear`, {
                throughId: 1000,
              })
            ).statusCode,
            403,
          );
        }
        assert.equal(
          (await request("operator", "GET", "/api/records/audit")).statusCode,
          200,
        );
        assert.equal(
          (await request("operator", "GET", "/api/system/settings")).statusCode,
          403,
        );
        assert.equal(
          (await request("owner", "GET", "/api/system/logs/server.log"))
            .statusCode,
          403,
        );
        const log = await request("operator", "GET", "/api/records/audit");
        assert.equal(
          log.json().items.find((r: any) => r.id === audit.id).actorName,
          "admin",
        );
        // 审计记录是操作追踪的底账，管理员也不能删除。
        const removed = await request(
          "admin",
          "DELETE",
          `/api/records/audit/${audit.id}`,
        );
        assert.equal(removed.statusCode, 403);
        assert.match(removed.json().message, /审计记录不可删除/);
        assert.equal(
          (
            await request("admin", "POST", "/api/records/audit/clear", {
              throughId: audit.id,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await request("admin", "GET", "/api/records/audit%20OR%201=1"))
            .statusCode,
          400,
        );
        assert.equal(
          (await request("admin", "DELETE", "/api/records/audit/1%20OR%201=1"))
            .statusCode,
          400,
        );
      },
    );
    await t.test(
      "pagination reads beyond 100 records and cleanup preserves new and active tasks",
      async () => {
        for (let i = 0; i < 105; i++)
          db.db
            .insert(jobs)
            .values({
              type: "sync",
              status: "success",
              payloadJson: '{"private":"payload"}',
            })
            .run();
        const queued = db.db
          .insert(jobs)
          .values({ type: "sync" })
          .returning()
          .get();
        const running = db.db
          .insert(jobs)
          .values({ type: "sync", status: "running" })
          .returning()
          .get();
        const last = (
          await request("operator", "GET", "/api/records/jobs?page=6")
        ).json();
        assert.equal(last.total, 107);
        assert.equal(last.items.length, 7);
        assert.equal("payloadJson" in last.items[0], false);
        for (const id of [queued.id, running.id])
          assert.equal(
            (await request("admin", "DELETE", `/api/records/jobs/${id}`))
              .statusCode,
            409,
          );
        const newer = db.db
          .insert(jobs)
          .values({ type: "sync", status: "success" })
          .returning()
          .get();
        const cleared = await request(
          "admin",
          "POST",
          "/api/records/jobs/clear",
          { throughId: last.throughId },
        );
        assert.equal(cleared.json().deleted, 105);
        assert.deepEqual(
          db.db
            .select()
            .from(jobs)
            .all()
            .map((r) => r.id),
          [queued.id, running.id, newer.id],
        );
        db.db.delete(jobs).run();
        const org = db.db
          .insert(syncRuns)
          .values({ source: "feishu.organization", status: "success" })
          .returning()
          .get();
        const people = db.db
          .insert(syncRuns)
          .values({ source: "feishu.users", status: "success" })
          .returning()
          .get();
        const inProgress = db.db
          .insert(syncRuns)
          .values({ source: "feishu.organization", status: "running" })
          .returning()
          .get();
        const scoped = (
          await request("admin", "GET", "/api/records/sync?scope=organization")
        ).json();
        assert.equal(scoped.total, 2);
        await request("admin", "POST", "/api/records/sync/clear", {
          throughId: scoped.throughId,
          scope: "organization",
        });
        assert.deepEqual(
          db.db
            .select()
            .from(syncRuns)
            .all()
            .map((r) => r.id),
          [people.id, inProgress.id],
        );
        assert.equal(
          db.db.select().from(syncRuns).where(eq(syncRuns.id, org.id)).get(),
          undefined,
        );
        assert.ok(
          db.db
            .select()
            .from(auditLogs)
            .all()
            .some((r) => r.action === "records.clear"),
        );
      },
    );
    await t.test(
      "runtime log truncation preserves the writer and is admin-only",
      async () => {
        const dir = path.resolve(
          root,
          app.get(ConfigurationService).get("logging.dir"),
        );
        await mkdir(dir, { recursive: true });
        const filename = path.join(dir, "server.log");
        await writeFile(filename, "old log\n");
        const writer = await open(filename, "a");
        try {
          assert.equal(
            (await request("operator", "GET", "/api/system/logs/server.log"))
              .statusCode,
            200,
          );
          assert.equal(
            (await request("operator", "DELETE", "/api/system/logs/server.log"))
              .statusCode,
            403,
          );
          assert.equal(
            (await request("admin", "DELETE", "/api/system/logs/server.log"))
              .statusCode,
            200,
          );
          await writer.write("new log\n");
          assert.equal(await readFile(filename, "utf8"), "new log\n");
          assert.equal(
            (await request("admin", "DELETE", "/api/system/logs/unknown.log"))
              .statusCode,
            404,
          );
        } finally {
          await writer.close();
        }
      },
    );
    await t.test(
      "users cancel only their own schedules and managers can cancel others",
      async () => {
        const m = meeting(),
          e = event();
        db.db
          .insert(meetingAttendees)
          .values({
            meetingId: m.id,
            userId: actors.stranger!.id,
            displayName: "被邀请用户",
          })
          .run();
        for (const url of [
          `/api/meetings/${m.id}/cancel`,
          `/api/calendar-events/${e.id}/cancel`,
        ])
          assert.equal(
            (await request("stranger", "POST", url)).statusCode,
            403,
          );
        assert.equal(
          (await request("stranger", "GET", "/api/calendar-events")).json()
            .length,
          0,
        );
        assert.ok(
          (await request("operator", "GET", "/api/calendar-events"))
            .json()
            .some((r: any) => r.id === e.id),
        );
        assert.equal(
          (await request("admin", "DELETE", `/api/meetings/${m.id}`))
            .statusCode,
          409,
        );
        assert.equal(
          (await request("admin", "DELETE", `/api/calendar-events/${e.id}`))
            .statusCode,
          409,
        );
        assert.equal(
          (
            await request(
              "operator",
              "POST",
              `/api/calendar-events/${e.id}/cancel`,
            )
          ).statusCode,
          201,
        );
        assert.equal(
          (await request("owner", "POST", `/api/meetings/${m.id}/cancel`))
            .statusCode,
          201,
        );
        await worker.runOnce();
        assert.equal(remoteCancels, 1);
        assert.equal(
          db.db
            .select()
            .from(calendarEvents)
            .where(eq(calendarEvents.id, e.id))
            .get()!.status,
          "cancelled",
        );
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, m.id)).get()!
            .status,
          "cancelled",
        );
        for (const url of [
          `/api/meetings/${m.id}`,
          `/api/calendar-events/${e.id}`,
        ])
          assert.equal((await request("owner", "DELETE", url)).statusCode, 403);
        const recording = db.db
          .insert(recordings)
          .values({
            meetingId: m.id,
            status: "ready",
            filesJson: '[{"id":"file"}]',
          })
          .returning()
          .get();
        assert.equal(
          (await request("operator", "DELETE", `/api/meetings/${m.id}`))
            .statusCode,
          200,
        );
        assert.equal(
          (await request("admin", "DELETE", `/api/calendar-events/${e.id}`))
            .statusCode,
          200,
        );
        for (const actor of ["owner", "operator", "admin"]) {
          assert.ok(
            !(await request(actor, "GET", "/api/meetings"))
              .json()
              .some((r: any) => r.id === m.id),
          );
          assert.ok(
            !(await request(actor, "GET", "/api/calendar-events"))
              .json()
              .some((r: any) => r.id === e.id),
          );
          assert.equal(
            (await request(actor, "GET", `/api/meetings/${m.id}`)).statusCode,
            404,
          );
        }
        assert.ok(
          db.db
            .select()
            .from(recordings)
            .where(eq(recordings.id, recording.id))
            .get(),
          "deleting a schedule retains cloud recording cleanup state",
        );
        const recordingList = (
          await request("owner", "GET", "/api/recordings")
        ).json();
        assert.ok(
          recordingList.some((r: any) => r.recording.id === recording.id),
        );
        assert.ok(!JSON.stringify(recordingList).includes("private-secret"));
        const upcoming = meeting();
        assert.ok(
          !JSON.stringify(
            (await request("owner", "GET", "/api/dashboard/summary")).json(),
          ).includes("private-secret"),
        );
        db.db.delete(meetings).where(eq(meetings.id, upcoming.id)).run();
      },
    );
    await t.test(
      "deletion rejects queued jobs and retry cannot revive deleted resources",
      async () => {
        const m = meeting("cancelled"),
          e = event("cancelled");
        const pending = db.db
          .insert(jobs)
          .values({
            type: "meeting.cancel",
            payloadJson: JSON.stringify({ id: m.id }),
          })
          .returning()
          .get();
        assert.equal(
          (await request("admin", "DELETE", `/api/meetings/${m.id}`))
            .statusCode,
          409,
        );
        db.db
          .update(jobs)
          .set({ status: "failed" })
          .where(eq(jobs.id, pending.id))
          .run();
        await request("admin", "DELETE", `/api/meetings/${m.id}`);
        assert.equal(
          (
            await request(
              "admin",
              "POST",
              `/api/system/jobs/${pending.id}/retry`,
            )
          ).statusCode,
          404,
        );
        await request("admin", "DELETE", `/api/calendar-events/${e.id}`);
        const calendarJob = db.db
          .insert(jobs)
          .values({
            type: "calendar.provision",
            status: "failed",
            payloadJson: JSON.stringify({ id: e.id }),
          })
          .returning()
          .get();
        assert.equal(
          (
            await request(
              "admin",
              "POST",
              `/api/system/jobs/${calendarJob.id}/retry`,
            )
          ).statusCode,
          404,
        );
      },
    );
    await t.test(
      "uncertain Feishu creation cannot be discarded before idempotent recovery",
      async () => {
        const e = event("pending");
        db.db
          .update(calendarEvents)
          .set({ calendarEventId: null })
          .where(eq(calendarEvents.id, e.id))
          .run();
        const feishu = app.get(FeishuAdapter),
          originalCreate = feishu.createEvent,
          originalReplace = feishu.replaceAttendees;
        try {
          feishu.createEvent = async () => {
            throw new PlatformError("飞书", "NETWORK", true);
          };
          await assert.rejects(calendar.provision(e.id));
          assert.equal(
            (
              await request(
                "owner",
                "POST",
                `/api/calendar-events/${e.id}/cancel`,
              )
            ).statusCode,
            409,
          );
          feishu.createEvent = async () => ({
            id: "recovered-event",
            calendarId: "calendar",
          });
          feishu.replaceAttendees = async () => {};
          await calendar.provision(e.id);
          assert.equal(
            db.db
              .select()
              .from(calendarEvents)
              .where(eq(calendarEvents.id, e.id))
              .get()!.creationUncertain,
            false,
          );
          assert.equal(
            (
              await request(
                "owner",
                "POST",
                `/api/calendar-events/${e.id}/cancel`,
              )
            ).statusCode,
            201,
          );
          await worker.runOnce();
          assert.equal(
            db.db
              .select()
              .from(calendarEvents)
              .where(eq(calendarEvents.id, e.id))
              .get()!.status,
            "cancelled",
          );
        } finally {
          feishu.createEvent = originalCreate;
          feishu.replaceAttendees = originalReplace;
        }
      },
    );
    await t.test(
      "cancel invalidates a queued create retry, including the worker's fetched batch",
      async () => {
        db.db.delete(jobs).run();
        const blocker = meeting("cancelling"),
          target = meeting("failed");
        db.db
          .insert(jobs)
          .values({
            type: "meeting.cancel",
            payloadJson: JSON.stringify({ id: blocker.id }),
          })
          .run();
        const obsolete = db.db
          .insert(jobs)
          .values({
            type: "meeting.provision",
            payloadJson: JSON.stringify({ id: target.id }),
          })
          .returning()
          .get();
        let entered!: () => void, resume!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const paused = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const original = booking.performCancel.bind(booking);
        booking.performCancel = async (id) => {
          if (id === blocker.id) {
            entered();
            await paused;
          }
          await original(id);
        };
        const run = worker.runOnce();
        await started;
        try {
          assert.equal(
            (
              await request(
                "owner",
                "POST",
                `/api/meetings/${target.id}/cancel`,
              )
            ).statusCode,
            201,
          );
        } finally {
          resume();
          await run;
          booking.performCancel = original;
        }
        assert.equal(
          db.db.select().from(jobs).where(eq(jobs.id, obsolete.id)).get()!
            .attempts,
          0,
        );
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, target.id)).get()!
            .status,
          "cancelling",
        );
        await worker.runOnce();
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, target.id)).get()!
            .status,
          "cancelled",
        );
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
