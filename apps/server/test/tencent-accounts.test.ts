import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { DatabaseService } from "../src/database.service.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { PlatformHttp } from "../src/platforms/shared/http.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { TencentAccountsService } from "../src/platforms/meeting/tencent/accounts.js";
import {
  accountPoolMembers,
  accountPools,
  meetingAccounts,
  users,
} from "../src/db/schema.js";

test("Tencent account discovery and pool import work independently of Feishu", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agenda-link-tencent-accounts-"),
  );
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  process.env.AGENDA_LINK_WORKSPACE = root;
  const config = new ConfigurationService(),
    db = new DatabaseService(config);
  const connections = new PlatformConnectionService(config, db);
  connections.update("tencent-meeting", {
    appId: "app",
    sdkId: "sdk",
    secretId: "key",
    secretKey: "secret",
    operatorId: "operator",
  });
  const remote = new Map<string, any>([
    ...Array.from(
      { length: 20 },
      (_, i) =>
        [
          `ordinary-${i}`,
          {
            userid: `ordinary-${i}`,
            username: "普通账号",
            user_account_type: 2,
            status: "1",
          },
        ] as [string, any],
    ),
    [
      "tencent-only",
      {
        userid: "tencent-only",
        username: "腾讯独立账号",
        user_account_type: 9,
        status: "1",
        department_list: [
          {
            department_name: "会议服务",
            department_full_name: "公司/会议服务",
          },
        ],
      },
    ],
    [
      "existing",
      {
        userid: "existing",
        username: "腾讯默认名称",
        user_account_type: 4,
        status: "1",
      },
    ],
    [
      "legacy",
      {
        userid: "legacy",
        username: "旧格式账号",
        user_account_type: 1,
        status: "1",
      },
    ],
    [
      "disabled",
      {
        userid: "disabled",
        username: "腾讯停用账号",
        user_account_type: 9,
        status: "4",
      },
    ],
    [
      "unknown-license",
      {
        userid: "unknown-license",
        username: "仅返回企业版本",
        account_type: 9,
        status: "1",
      },
    ],
  ]);
  const calls: { id: string; method: string }[] = [];
  const http = {
    request: async (raw: string, method: string) => {
      const url = new URL(raw);
      calls.push({ id: url.pathname, method });
      if (url.pathname === "/v1/users/list") {
        const page = Number(url.searchParams.get("page"));
        return {
          total_count: remote.size,
          users: [...remote.values()]
            .slice((page - 1) * 20, page * 20)
            .map((r) => {
              if (r.userid !== "legacy") return structuredClone(r);
              const { user_account_type, ...legacy } = r;
              return legacy;
            }),
        };
      }
      const row = remote.get(url.pathname.split("/").at(-1)!);
      if (!row) throw new Error("腾讯账号不存在");
      return structuredClone(row);
    },
  } as unknown as PlatformHttp;
  const tc = new TencentAdapter(config, http, connections);
  const service = new TencentAccountsService(db, tc);
  const existing = db.db
    .insert(meetingAccounts)
    .values({
      name: "运营自定义名称",
      accountId: "existing",
      status: "disabled",
      secretId: "own-key",
      secretKey: config.encrypt("own-secret"),
    })
    .returning()
    .get();
  const pool = db.db
    .insert(accountPools)
    .values({ name: "会议账号池" })
    .returning()
    .get();
  db.db
    .insert(accountPoolMembers)
    .values({ poolId: pool.id, accountId: existing.id })
    .run();
  try {
    await t.test(
      "preview traverses pages, excludes ordinary accounts and marks unavailable Tencent accounts",
      async () => {
        const preview = await service.preview();
        assert.deepEqual(
          preview.accounts.map((a) => a.accountId),
          ["tencent-only", "existing", "legacy", "disabled"],
        );
        assert.deepEqual(preview.accounts[0]!.departmentNames, [
          "公司/会议服务",
        ]);
        assert.equal(preview.accounts[0]!.localId, null);
        assert.equal(preview.accounts[1]!.localStatus, "disabled");
        assert.equal(preview.accounts[3]!.canImport, false);
        assert.ok(calls.some((c) => c.id === "/v1/users/legacy"));
        assert.equal(db.db.select().from(meetingAccounts).all().length, 1);
        assert.equal(db.db.select().from(users).all().length, 0);
        assert.ok(!JSON.stringify(preview).includes("own-secret"));
      },
    );
    await t.test(
      "selected accounts are verified and merged without duplicates or changes to disabled accounts and credentials",
      async () => {
        assert.deepEqual(
          await service.import(
            ["tencent-only", "existing", "tencent-only"],
            pool.id,
            1,
          ),
          { created: 1, existing: 1, poolAdded: 1 },
        );
        const row = db.db
          .select()
          .from(meetingAccounts)
          .where(eq(meetingAccounts.id, existing.id))
          .get()!;
        assert.equal(row.name, "运营自定义名称");
        assert.equal(row.status, "disabled");
        assert.equal(row.secretId, "own-key");
        assert.equal(config.decrypt(row.secretKey!), "own-secret");
        assert.ok(row.verifiedAt);
        const imported = db.db
          .select()
          .from(meetingAccounts)
          .where(eq(meetingAccounts.accountId, "tencent-only"))
          .get()!;
        assert.equal(imported.status, "available");
        assert.ok(imported.verifiedAt);
        assert.equal(imported.secretKey, null);
        assert.deepEqual(await service.import(["tencent-only"], pool.id), {
          created: 0,
          existing: 1,
          poolAdded: 0,
        });
        assert.equal(db.db.select().from(accountPoolMembers).all().length, 2);
        assert.equal(db.db.select().from(users).all().length, 0);
        assert.ok(calls.every((c) => c.method === "GET"));
      },
    );
    await t.test(
      "license and activation changes reject the whole selection before local writes",
      async () => {
        remote.get("ordinary-0").user_account_type = 9;
        const preview = await service.preview();
        assert.ok(preview.accounts.some((a) => a.accountId === "ordinary-0"));
        remote.get("ordinary-0").user_account_type = 2;
        await assert.rejects(
          () => service.import(["legacy", "ordinary-0"]),
          /没有高级用户许可/,
        );
        await assert.rejects(
          () => service.import(["disabled"]),
          /不是正常启用/,
        );
        await assert.rejects(
          () => service.import(["unknown-license"]),
          /没有高级用户许可/,
        );
        await assert.rejects(
          () => service.import(["legacy"], 999),
          /账号池不存在/,
        );
        assert.equal(db.db.select().from(meetingAccounts).all().length, 2);
        assert.equal(db.db.select().from(accountPoolMembers).all().length, 2);
      },
    );
    await t.test("accounts can be added without assigning a pool", async () => {
      assert.deepEqual(await service.import(["legacy"]), {
        created: 1,
        existing: 0,
        poolAdded: 0,
      });
      assert.equal(db.db.select().from(accountPoolMembers).all().length, 2);
    });
  } finally {
    db.onModuleDestroy();
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
