import {registryFixture,scopedPerson} from "./platform-fixture.js";
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
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import {
  FeishuAdapter,
  type DirectoryPerson,
  type DirectoryDepartment,
} from "../src/platforms/shared/feishu/client.js";
import { PlatformHttp } from "../src/platforms/shared/http.js";
import { SyncService } from "../src/sync.service.js";
import { SystemUsersService } from "../src/system-users.service.js";
import { AuthService } from "../src/auth.service.js";
import { MeetingService } from "../src/meeting.service.js";
import {
  platformIdentities,
  users,
  departments,
  meetingAccounts,
  accountPools,
  accountPoolMembers,
  meetings,
  jobs,
  syncRules,
  meetingAttendees,
} from "../src/db/schema.js";

test("system access, independent directory sync, preserved licenses and personal account priority", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-management-"));
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  process.env.AGENDA_LINK_WORKSPACE = root;
  const config = new ConfigurationService();
  const db = new DatabaseService(config);
  const connections = new PlatformConnectionService(config, db);
  connections.update("feishu-directory", {
    appId: "sync-app",tenantKey:"tenant",
    appSecret: "sync-secret",
  });
  connections.update("feishu-calendar", {
    appId: "booking-app",
    appSecret: "booking-secret",
    calendarId: "calendar",
  });
  connections.update("tencent-meeting", {
    appId: "app",
    sdkId: "sdk",
    secretId: "key",
    secretKey: "secret",
    operatorId: "operator",
    advancedType: "9",
  });
  await config.update({
    "feishu.login.app-id": "login-app",
    "feishu.login.tenant-key":"tenant",
    "feishu.login.app-secret": "login-secret",
  });
  const sourceDepartments: DirectoryDepartment[] = [
    { open_department_id: "root", name: "公司", parent_department_id: "0" },
    {
      open_department_id: "child",
      name: "研发部",
      parent_department_id: "root",
    },
  ];
  const sourcePeople: DirectoryPerson[] = [
    {
      open_id: "sync-person",
      user_id: "stable-person",
      name: "张三",
      avatar: { avatar_240: "https://example.com/zhang-san.jpg" },
      mobile: "13800000000",
      department_ids: ["child"],
    },
  ];
  const feishu = {
    calendarId: "calendar",
    directory: async (kind: string, includePeople = true) => ({
      departments: structuredClone(sourceDepartments),
      people: includePeople
        ? structuredClone(sourcePeople).map((p) =>
            kind === "login" ? { ...p, open_id: "login-" + p.user_id } : p,
          )
        : [],
    }),
  } as unknown as FeishuAdapter;
  const remote = new Map<string, any>([
    [
      "old-tencent-id",
      {
        userid: "old-tencent-id",
        username: "腾讯已有高级用户",
        phone: "+86 13800000000",
        user_account_type: 9,
        department_list: [
          { department_id: "previous-department", is_main: true },
        ],
        status: "1",
        avatar_url: "https://example.com/tencent-avatar.jpg",
        add_on_largemeeting: 1,
      },
    ],
    [
      "pool-host",
      { userid: "pool-host", user_account_type: 9, phone: "13900000000" },
    ],
  ]);
  const remoteDepartments = new Map<string, any>();
  const calls: { path: string; method: string; body: any }[] = [];
  const http = {
    request: async (
      url: string,
      method = "GET",
      _headers: unknown,
      raw?: any,
    ) => {
      const u = new URL(url),
        body = typeof raw === "string" ? JSON.parse(raw) : raw || {};
      calls.push({ path: u.pathname, method, body });
      if (u.pathname === "/v1/departments" && method === "GET")
        return {
          total_page: 1,
          department_list: [...remoteDepartments.values()],
        };
      if (
        u.pathname.startsWith("/v1/departments") &&
        ["PUT", "POST"].includes(method)
      ) {
        const id =
          method === "PUT"
            ? u.pathname.split("/").at(-1)!
            : `remote-dept-${remoteDepartments.size + 1}`;
        const parent = remoteDepartments.get(body.parent_department_id);
        remoteDepartments.set(id, {
          department_id: id,
          department_name: body.department_name,
          department_full_name:
            (parent ? parent.department_full_name + "/" : "") +
            body.department_name,
          parent_department_id: body.parent_department_id,
        });
        return { department_id: id };
      }
      if (u.pathname === "/v1/users/list")
        return { total_count: remote.size, users: [...remote.values()] };
      if (u.pathname.endsWith("/enable")) return {};
      if (u.pathname.startsWith("/v1/users/") && method === "GET") {
        const row = remote.get(u.pathname.split("/").at(-1)!);
        if (!row) throw new Error("remote user does not exist");
        return { ...row };
      }
      if (
        u.pathname.startsWith("/v1/users") &&
        ["PUT", "POST"].includes(method)
      ) {
        const id = body.userid || u.pathname.split("/").at(-1);
        remote.set(id, {
          ...remote.get(id),
          ...body,
          userid: id,
          ...(body.department_list
            ? {
                department_list: body.department_list
                  .filter((id: string) => id !== "0")
                  .map((department_id: string) => ({
                    department_id,
                    is_main: true,
                  })),
              }
            : {}),
        });
        return {};
      }
      throw new Error(`unexpected ${method} ${u.pathname}`);
    },
  } as unknown as PlatformHttp;
  const tencent = new TencentAdapter(config, http, connections);
  const sync = new SyncService(db,registryFixture(config,db,connections,tencent,feishu));
  const system = new SystemUsersService(db, config, feishu);
  const auth = new AuthService(config, db);
  const booking = new MeetingService(db,config,registryFixture(config,db,connections,tencent,feishu),connections);
  try {
    await t.test(
      "Feishu reads are independent, do not write Tencent, and do not grant login",
      async () => {
        await sync.pull("organization");
        assert.equal(db.db.select().from(users).all().length, 0);
        await sync.pull("users");
        assert.equal(calls.length, 0);
        const p=scopedPerson(db,"feishu-directory","sync-person");
        assert.equal(p.systemAccess, "not_added");
        assert.equal(p.avatarUrl, "https://example.com/zhang-san.jpg");
        assert.equal(sync.view("users").people[0]?.avatarUrl, p.avatarUrl);
        await assert.rejects(() => auth.issue(p), /未获准登录/);
        assert.deepEqual(sync.view("users").people[0]?.departmentNames, [
          "研发部",
        ]);
      },
    );
    await t.test(
      "directory reads refresh avatars and missing avatars preserve the previous image",
      async () => {
        sourcePeople[0]!.avatar = {
          avatar_640: "https://example.com/updated.jpg",
        };
        await sync.pull("users");
        assert.equal(
          db.db.select().from(users).get()!.avatarUrl,
          "https://example.com/updated.jpg",
        );
        delete sourcePeople[0]!.avatar;
        await sync.pull("users");
        assert.equal(
          db.db.select().from(users).get()!.avatarUrl,
          "https://example.com/updated.jpg",
        );
        assert.equal(
          sync.view("users").people[0]?.avatarUrl,
          "https://example.com/updated.jpg",
        );
      },
    );
    await t.test(
      "selected child includes ancestors; merge skips remote updates and overwrite is explicit",
      async () => {
        const first = await sync.execute("organization", {
          selectedIds: ["child"],
        });
        assert.equal(first.created, 2);
        const child = calls.filter(
          (c) => c.path === "/v1/departments" && c.method === "POST",
        )[1]!;
        assert.equal(child.body.parent_department_id, "remote-dept-1");
        const before = calls.length;
        await sync.execute("organization", { selectedIds: ["child"] });
        assert.equal(
          calls.slice(before).filter((c) => c.method !== "GET").length,
          0,
        );
        sourceDepartments[1]!.name = "产品研发部";
        await sync.pull("organization");
        const overwrite = await sync.execute("organization", {
          selectedIds: ["child"],
          overwriteDepartments: true,
        });
        assert.equal(overwrite.updated, 2);
        assert.equal(
          remoteDepartments.get("remote-dept-2").department_name,
          "产品研发部",
        );
      },
    );
    await t.test(
      "phone matching moves an existing account without changing its profile, status or licenses",
      async () => {
        await sync.pull("users");
        const beforeMatch = calls.length;
        const first = await sync.execute("users");
        assert.equal(first.created, 0);
        assert.equal(first.updated, 1);
        assert.equal(first.permissionsPreserved, 1);
        const writes = calls
          .slice(beforeMatch)
          .filter((c) => c.method !== "GET");
        assert.deepEqual(writes, [
          {
            path: "/v1/users/old-tencent-id",
            method: "PUT",
            body: {
              operator_id: "operator",
              operator_id_type: 1,
              department_list: ["remote-dept-2"],
            },
          },
        ]);
        const existing = remote.get("old-tencent-id");
        assert.equal(existing.username, "腾讯已有高级用户");
        assert.equal(existing.phone, "+86 13800000000");
        assert.equal(existing.status, "1");
        assert.equal(
          existing.avatar_url,
          "https://example.com/tencent-avatar.jpg",
        );
        assert.equal(existing.add_on_largemeeting, 1);
        const p=scopedPerson(db,"feishu-directory","sync-person");
        assert.equal(p.tencentUserId, "old-tencent-id");
        assert.equal(p.meetingUserType, "advanced");
        assert.equal(remote.get("old-tencent-id").user_account_type, 9);
        const beforeRepeat = calls.length;
        const repeated = await sync.execute("users");
        assert.equal(repeated.updated, 0);
        assert.equal(repeated.skipped, 1);
        assert.equal(
          calls.slice(beforeRepeat).filter((c) => c.method !== "GET").length,
          0,
        );
        const before = calls.length;
        await sync.execute("users", { overwriteUsers: true });
        const update = calls
          .slice(before)
          .find(
            (c) => c.method === "PUT" && c.path === "/v1/users/old-tencent-id",
          )!;
        assert.ok(update);
        assert.equal(Object.hasOwn(update.body, "user_account_type"), false);
        assert.equal(remote.get("old-tencent-id").user_account_type, 9);
        assert.equal(
          db.db
            .select()
            .from(meetingAccounts)
            .where(eq(meetingAccounts.accountId, "old-tencent-id"))
            .get()!.status,
          "available",
        );
      },
    );
    await t.test(
      "existing accounts follow department changes and root moves; unsynchronized departments fail without writes",
      async () => {
        sourcePeople[0]!.department_ids = ["root"];
        await sync.pull("users");
        assert.equal((await sync.execute("users")).updated, 1);
        assert.equal(
          remote.get("old-tencent-id").department_list[0].department_id,
          "remote-dept-1",
        );

        sourcePeople[0]!.department_ids = ["0"];
        await sync.pull("users");
        const beforeRoot = calls.length;
        assert.equal((await sync.execute("users")).updated, 1);
        assert.deepEqual(
          calls.slice(beforeRoot).find((c) => c.method === "PUT")!.body
            .department_list,
          ["0"],
        );
        assert.deepEqual(remote.get("old-tencent-id").department_list, []);
        assert.equal((await sync.execute("users")).skipped, 1);

        // Root membership does not displace the first actual Feishu department.
        sourcePeople[0]!.department_ids = ["0", "child", "root"];
        await sync.pull("users");
        assert.equal((await sync.execute("users")).updated, 1);
        assert.equal(
          remote.get("old-tencent-id").department_list[0].department_id,
          "remote-dept-2",
        );

        sourceDepartments.push({
          open_department_id: "unmapped",
          name: "未同步部门",
          parent_department_id: "root",
        });
        for (const id of ["unmapped", "invisible"]) {
          sourcePeople[0]!.department_ids = [id];
          await sync.pull("users");
          const beforeFailure = calls.length;
          const failed = await sync.execute("users");
          assert.equal(failed.failed, 1);
          assert.match(failed.errors[0]!, /所属组织尚未同步/);
          assert.equal(
            calls.slice(beforeFailure).filter((c) => c.method !== "GET").length,
            0,
          );
          assert.equal(
            remote.get("old-tencent-id").department_list[0].department_id,
            "remote-dept-2",
          );
          assert.equal(remote.get("old-tencent-id").user_account_type, 9);
        }
        sourcePeople[0]!.department_ids = ["child"];
        await sync.pull("users");
        assert.equal((await sync.execute("users")).failed, 0);
        assert.equal(db.db.select().from(users).get()!.syncError, null);
      },
    );
    await t.test(
      "permission overwrite changes existing accounts only when selected; new users default ordinary",
      async () => {
        remote.get("old-tencent-id").department_list = [
          { department_id: "remote-dept-1", is_main: true },
        ];
        const before = calls.length;
        const changed = await sync.execute("users", {
          preserveExistingPermissions: false,
        });
        assert.equal(changed.updated, 1);
        assert.deepEqual(
          calls.slice(before).filter((c) => c.method !== "GET"),
          [
            {
              path: "/v1/users/old-tencent-id",
              method: "PUT",
              body: {
                operator_id: "operator",
                operator_id_type: 1,
                department_list: ["remote-dept-2"],
                user_account_type: 2,
              },
            },
          ],
        );
        assert.equal(remote.get("old-tencent-id").user_account_type, 2);
        assert.equal(
          db.db
            .select()
            .from(meetingAccounts)
            .where(eq(meetingAccounts.accountId, "old-tencent-id"))
            .get()!.verifiedAt,
          null,
        );
        sourcePeople.push({
          open_id: "new-open",
          user_id: "new-user",
          name: "李四",
          mobile: "+8613700000000",
          department_ids: ["child"],
        });
        await sync.pull("users");
        const result = await sync.execute("users", {
          selectedIds: ["new-open"],
        });
        assert.equal(result.created, 1);
        assert.equal(remote.get("new-user").user_account_type, 2);
        assert.equal(remote.get("new-user").phone, "13700000000");
        assert.equal(remote.get("new-user").area, "86");
        assert.equal(
          scopedPerson(db,"feishu-directory","new-open").systemAccess,
          "not_added",
        );
        // Restore the first account via an explicit rule so subsequent allocation tests use a real verified identity.
        db.db
          .insert(syncRules)
          .values({
            name: "研发高级",
            departmentExternalId: "child",
            meetingUserType: "advanced",
          })
          .run();
        await sync.execute("users", {
          selectedIds: ["sync-person"],
          preserveExistingPermissions: false,
        });
      },
    );
    await t.test(
      "login-app import preserves roles and blocked access, and binding merges directory-only identities",
      async () => {
        const manual = db.db
          .insert(users)
          .values({
            username: "manual",
            displayName: "手动用户",
            passwordHash: auth.hashPassword("LongPassword123"),
          })
          .returning()
          .get();
        const preview = await system.preview();
        assert.equal(preview.appId, "login-app");
        assert.equal(
          preview.people[0]?.avatarUrl,
          "https://example.com/updated.jpg",
        );
        const staged = scopedPerson(db,"feishu-directory","sync-person");
        const meeting = db.db
          .insert(meetings)
          .values({
            subject: "既有会议",
            startAt: "2035-01-01T00:00:00.000Z",
            endAt: "2035-01-01T01:00:00.000Z",
            status: "cancelled",
          })
          .returning()
          .get();
        db.db
          .insert(meetingAttendees)
          .values({
            meetingId: meeting.id,
            userId: staged.id,
            displayName: staged.displayName,
          })
          .run();
        system.bind(manual.id, "login-stable-person", 1);
        assert.equal(
          db.db.select().from(users).where(eq(users.id, staged.id)).get(),
          undefined,
        );
        assert.equal(
          db.db.select().from(meetingAttendees).get()!.userId,
          manual.id,
        );
        const bound = db.db
          .select()
          .from(users)
          .where(eq(users.id, manual.id))
          .get()!;
        assert.equal(scopedPerson(db,"feishu-directory","sync-person").tencentUserId,"old-tencent-id");
        assert.equal(scopedPerson(db,"feishu-directory","sync-person").id,bound.id);
        assert.equal(bound.feishuLoginOpenId, "login-stable-person");
        assert.equal(bound.avatarUrl, "https://example.com/updated.jpg");
        const session = await auth.issue(bound);
        assert.equal(session.user.avatarUrl, bound.avatarUrl);
        assert.equal(
          (
            await auth.verify({
              headers: { authorization: "Bearer " + session.token },
            })
          ).user.avatarUrl,
          bound.avatarUrl,
        );
        db.db
          .update(users)
          .set({ systemAccess: "blocked", role: "operation_admin" })
          .where(eq(users.id, manual.id))
          .run();
        await assert.rejects(() =>
          auth.verify({
            headers: { authorization: "Bearer " + session.token },
          }),
        );
        system.import(["login-stable-person"], "user", 1);
        const preserved = db.db
          .select()
          .from(users)
          .where(eq(users.id, manual.id))
          .get()!;
        assert.equal(preserved.systemAccess, "blocked");
        assert.equal(preserved.role, "operation_admin");
        assert.equal(preserved.avatarUrl, bound.avatarUrl);
        db.db
          .update(users)
          .set({ systemAccess: "allowed" })
          .where(eq(users.id, manual.id))
          .run();
        await sync.pull("users");
        assert.equal(
          db.db
            .select()
            .from(users)
            .where(eq(users.feishuUserId, "stable-person"))
            .get()!.id,
          manual.id,
        );
        system.bind(manual.id, null, 1);
        assert.equal(
          db.db.select().from(users).where(eq(users.id, manual.id)).get()!
            .feishuLoginOpenId,
          null,
        );
      },
    );
    await t.test(
      "personal advanced account wins, overlaps fall back to a pool, ordinary users use only pools",
      async () => {
        const owner = db.db
          .select()
          .from(users)
          .where(eq(users.username, "manual"))
          .get()!;
        const ownAccount = db.db
          .select()
          .from(meetingAccounts)
          .where(eq(meetingAccounts.accountId, "old-tencent-id"))
          .get()!;
        // Reverification is explicit after a license was previously removed.
        await tencent.verifyAccount(ownAccount);
        db.db
          .update(meetingAccounts)
          .set({ verifiedAt: new Date().toISOString(), status: "available" })
          .where(eq(meetingAccounts.id, ownAccount.id))
          .run();
        const shared = db.db
          .insert(meetingAccounts)
          .values({
            name: "共享账号",
            accountId: "pool-host",
            verifiedAt: new Date().toISOString(),
          })
          .returning()
          .get();
        const pool = db.db
          .insert(accountPools)
          .values({ name: "备用池" })
          .returning()
          .get();
        db.db
          .insert(accountPoolMembers)
          .values({ poolId: pool.id, accountId: shared.id })
          .run();
        const sessionUser = {
          id: owner.id,
          username: owner.username,
          displayName: owner.displayName,
          role: owner.role,
          meetingUserType: owner.meetingUserType,
        };
        const input = {
          subject: "个人会议",
          startAt: "2035-02-01T00:00:00Z",
          endAt: "2035-02-01T01:00:00Z",
          accountPoolId: pool.id,
        };
        const first = booking.reserve(
          input,
          "personal".padEnd(32, "1"),
          sessionUser,
        );
        assert.equal(first.meetingAccountId, ownAccount.id);
        assert.equal(first.accountPoolId, null);
        assert.equal(first.allocationSource, "personal");
        const second = booking.reserve(
          input,
          "fallback".padEnd(32, "2"),
          sessionUser,
        );
        assert.equal(second.meetingAccountId, shared.id);
        assert.equal(second.allocationSource, "pool");
        assert.throws(
          () => booking.reserve(input, "conflict".padEnd(32, "3"), sessionUser),
          /空闲高级账号/,
        );
        db.db
          .update(platformIdentities)
          .set({profileJson:JSON.stringify({providerData:{advanced:false}})})
          .where(eq(platformIdentities.userId,owner.id))
          .run();
        const ordinary = booking.reserve(
          {
            ...input,
            startAt: "2035-03-01T00:00:00Z",
            endAt: "2035-03-01T01:00:00Z",
          },
          "ordinary".padEnd(32, "4"),
          sessionUser,
        );
        assert.equal(
          ordinary.meetingAccountId,
          shared.id,
          "allocation reads current database license rather than stale session info",
        );
        db.db
          .update(meetings)
          .set({ status: "failed" })
          .where(eq(meetings.id, first.id))
          .run();
        booking.retry(first.id, sessionUser);
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, first.id)).get()!
            .status,
          "provisioning",
          "personal retries do not require an account pool",
        );
        assert.equal(db.db.select().from(jobs).all().length, 3);
      },
    );
  } finally {
    db.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
  }
});
