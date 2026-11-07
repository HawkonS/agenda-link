import {scopedPerson} from "./platform-fixture.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { DatabaseService } from "../src/database.service.js";
import { WorkerService } from "../src/worker.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { recordingUrl } from "../src/platforms/recording-files.js";
import { MeetingService } from "../src/meeting.service.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { SyncService } from "../src/sync.service.js";
import { AuthService } from "../src/auth.service.js";
import {
  platformIdentities,
  users,
  meetings,
  recordings,
  jobs,
  calendarEvents,
  syncRuns,
  meetingAccounts,
  meetingAttendees,
} from "../src/db/schema.js";
import { tencentSignature } from "../src/platforms/shared/tencent/client.js";

test("real adapters, permissions, transactional allocation, recovery and TTL", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-test-"));
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  process.env.AGENDA_LINK_WORKSPACE = root;
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: any; headers: any }[] = [];
  let failCalendar = false,
    timeoutTencent = false;
  let failCalendarDelete = false;
  const deletedTencentMeetings = new Set<string>();
  const events = new Map<string, string>(),
    remoteAttendees = new Map<string, any[]>();
  const remoteDescriptions = new Map<string, string>();
  const remoteUsers = new Set([
    "host1",
    ...Array.from({ length: 20 }, (_, i) => "existing-" + i),
  ]);
  const remoteUserDepartments = new Map<string, string[]>();
  let remoteCounter = 0;
  let downloadUrl = "https://download.tencent.com/record.mp4";
  globalThis.fetch = async (input: any, options: any = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: url.toString(), method, body, headers: options.headers });
    const result = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.hostname === "api.meeting.qq.com") {
      const headers = options.headers;
      assert.equal(
        headers["X-TC-Signature"],
        tencentSignature(
          method,
          url.pathname + url.search,
          options.body || "",
          headers["X-TC-Key"],
          "tencent-secret",
          headers["X-TC-Nonce"],
          headers["X-TC-Timestamp"],
        ),
      );
      assert.equal(headers.SdkId, "sdk");
      if (
        url.pathname.endsWith("/cancel") &&
        deletedTencentMeetings.has(url.pathname.split("/").at(-2)!)
      )
        return result(
          { error_info: { error_code: 9007, message: "MEETING CANCLED" } },
          500,
        );
      if (url.pathname === "/v1/departments" && method === "GET")
        return result({ total_page: 1, department_list: [] });
      if (url.pathname === "/v1/departments" && method === "POST")
        return result({ department_id: "dept-tencent" });
      if (url.pathname === "/v1/departments/dept-tencent" && method === "PUT")
        return result({ department_id: "dept-tencent" });
      if (url.pathname === "/v1/users/list" && method === "GET") {
        assert.equal(url.searchParams.get("page_size"), "20");
        assert.equal(url.searchParams.get("operator_id_type"), "1");
        const page = Number(url.searchParams.get("page"));
        return result({
          current_page: page,
          total_count: remoteUsers.size,
          users: [...remoteUsers]
            .slice((page - 1) * 20, page * 20)
            .map((userid) => ({ userid })),
        });
      }
      if (
        (url.pathname === "/v1/users" && method === "POST") ||
        (/^\/v1\/users\/[^/]+$/.test(url.pathname) && method === "PUT")
      ) {
        if (body.phone) {
          assert.match(body.phone, /^1\d{10}$/);
          assert.equal(body.area, "86");
        }
        const id = body.userid || url.pathname.split("/").at(-1)!;
        remoteUsers.add(id);
        if (body.department_list)
          remoteUserDepartments.set(id, body.department_list);
        return result({});
      }
      if (url.pathname.startsWith("/v1/users/") && method === "GET") {
        if (
          url.pathname.endsWith("/f-user") &&
          !calls.some((c) => c.body.userid === "f-user")
        )
          return result({ code: 20000 }, 404);
        return result({
          userid: url.pathname.split("/").at(-1),
          user_account_type: 9,
          status: "1",
          department_list: (
            remoteUserDepartments.get(url.pathname.split("/").at(-1)!) || []
          )
            .filter((id) => id !== "0")
            .map((department_id) => ({ department_id, is_main: true })),
        });
      }
      if (url.pathname === "/v1/meetings" && method === "POST") {
        if (timeoutTencent) throw new Error("timeout");
        return result({
          meeting_info_list: [
            {
              meeting_id: "meeting-" + ++remoteCounter,
              meeting_code: "123 456 789",
              join_url: "https://meeting.tencent.com/real-response",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/real-time-participants"))
        return result({
          status: "4",
          current_page: 1,
          total_page: 1,
          participants: [
            {
              userid: "host1",
              ms_open_id: "ms-host",
              instanceid: 1,
              user_role: 3,
            },
            {
              userid: "f-user",
              ms_open_id: "ms-user",
              instanceid: 2,
              user_role: 0,
            },
          ],
        });
      if (url.pathname === "/v1/records" && method === "GET") {
        assert.equal(url.searchParams.get("page_size"), "20");
        assert.equal(url.searchParams.get("userid"), "host1");
        return result({ record_meetings: [{ meeting_record_id: "record-1" }] });
      }
      if (url.pathname.startsWith("/v1/records/") && method === "DELETE") {
        assert.ok(url.searchParams.get("meeting_id"));
        assert.equal(url.searchParams.get("userid"), "host1");
        return result({});
      }
      if (url.pathname === "/v1/addresses")
        return result({
          total_page: 1,
          record_files: [
            {
              record_file_id: "file-1",
              download_address: downloadUrl,
              download_address_file_type: "mp4",
            },
          ],
        });
      return result({});
    }
    if (url.pathname.endsWith("/tenant_access_token/internal"))
      return result({ code: 0, tenant_access_token: "tenant", expire: 7200 });
    if (url.pathname === "/open-apis/authen/v2/oauth/token") {
      assert.ok(body.code_verifier);
      return result({ access_token: "oauth-token" });
    }
    if (url.pathname.endsWith("/authen/v1/user_info"))
      return result({
        code: 0,
        data: {
          open_id: "ou-user",
          user_id: "f-user",
          avatar_url: "https://example.com/oauth-avatar.jpg",
        },
      });
    if (url.pathname.endsWith("/attendees")) {
      const previous = remoteAttendees.get(url.pathname) || [];
      if (method === "GET")
        return result({ code: 0, data: { items: previous, has_more: false } });
      if (method === "POST") {
        for (const attendee of body.attendees) {
          if (attendee.type === "third_party") {
            assert.ok(attendee.third_party_email);
            assert.equal(attendee.email, undefined);
          }
          previous.push({ ...attendee, attendee_id: "a-" + previous.length });
        }
        remoteAttendees.set(url.pathname, previous);
        return result({ code: 0, data: { attendees: previous } });
      }
    }
    if (url.pathname.includes("/departments/0/children"))
      return result({
        code: 0,
        data: {
          items: [
            {
              open_department_id: "od-finance",
              name: "财务部",
              parent_department_id: "0",
            },
          ],
          has_more: false,
        },
      });
    if (url.pathname.endsWith("/users/find_by_department"))
      return result({
        code: 0,
        data: {
          items:
            url.searchParams.get("department_id") === "0"
              ? []
              : [
                  {
                    open_id: "ou-user",
                    user_id: "f-user",
                    name: "飞书员工",
                    mobile: "13800000000",
                    department_ids: ["od-finance"],
                  },
                ],
          has_more: false,
        },
      });
    if (
      (url.pathname.endsWith("/events") && method === "POST") ||
      (/\/events\/[^/]+$/.test(url.pathname) && method === "PATCH")
    ) {
      // Feishu Calendar v4's public contract; invalid values must fail the mock
      // just as they fail production, for both event creation and updates.
      if (
        ![
          "none",
          "can_see_others",
          "can_invite_others",
          "can_modify_event",
        ].includes(body.attendee_ability)
      )
        return result({ code: 99992402, msg: "field validation failed" }, 400);
    }
    if (url.pathname.endsWith("/events") && method === "POST") {
      if (failCalendar) return result({ code: 194002 });
      const key = url.searchParams.get("idempotency_key")!;
      if (!events.has(key)) events.set(key, "event-" + events.size);
      remoteDescriptions.set(events.get(key)!, body.description);
      return result({
        code: 0,
        data: { event: { event_id: events.get(key) } },
      });
    }
    if (/\/events\/[^/]+$/.test(url.pathname) && method === "GET")
      return result({
        code: 0,
        data: {
          event: {
            description: remoteDescriptions.get(
              decodeURIComponent(url.pathname.split("/").at(-1)!),
            ),
          },
        },
      });
    if (/\/events\/[^/]+$/.test(url.pathname) && method === "PATCH")
      remoteDescriptions.set(
        decodeURIComponent(url.pathname.split("/").at(-1)!),
        body.description,
      );
    if (
      method === "DELETE" &&
      url.pathname.includes("/events/") &&
      failCalendarDelete
    )
      return result({ code: 194002 });
    return result({ code: 0, data: {} });
  };
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const initialAdmin = app.get(AuthService).ensureInitialAdmin();
  const initialPassword = (
    await readFile(initialAdmin.passwordPath, "utf8")
  ).trim();
  const server = app.getHttpAdapter().getInstance();
  const db = app.get(DatabaseService);
  const worker = app.get(WorkerService);
  const request = (
    method: string,
    url: string,
    payload?: any,
    cookie?: string,
    key?: string,
  ) =>
    server.inject({
      method,
      url,
      payload,
      headers: {
        origin: app.get(ConfigurationService).baseUrl,
        ...(cookie ? { cookie } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
    });
  let admin = "",
    operator = "",
    ordinary = "";
  let ownId = 0,
    meetingId = 0;
  try {
    await t.test(
      "first startup creates an admin without an initialization wizard",
      async () => {
        const setup = (await request("GET", "/api/bootstrap/status")).json();
        assert.equal(setup.initialized, true);
        assert.deepEqual(setup.missingRequired, []);
        const config = app.get(ConfigurationService);
        await config.update({ "platform.logo": "", "platform.favicon": "" });
        const branding = (await request("GET", "/api/system/branding")).json();
        assert.equal(branding.logo, "/logo.svg");
        assert.equal(branding.favicon, "/favicon.svg");
        assert.equal(
          config.setupDefaults()["platform.favicon"],
          "/favicon.svg",
        );
        await config.update({
          "platform.logo": "/logo.svg",
          "platform.favicon": "/favicon.svg",
        });
        const init = await request("POST", "/api/bootstrap/initialize", {});
        assert.equal(init.statusCode, 409);
        assert.ok(db.connection.name.includes("data"));
        assert.ok(
          app.get(ConfigurationService).get("auth.jwt-secret").length >= 32,
        );
        const file = await readFile(
          path.join(root, "agenda-link.properties"),
          "utf8",
        );
        assert.ok(!file.includes(initialPassword));
        assert.equal(
          (await request("GET", "/api/bootstrap/status")).json().defaults,
          undefined,
        );
        const login = await request("POST", "/api/auth/login", {
          username: "hawkon",
          password: initialPassword,
        });
        assert.equal(login.statusCode, 201, login.body);
        admin = login.headers["set-cookie"].split(";")[0];
        assert.equal(
          (await request("GET", "/api/dashboard/summary", undefined, admin))
            .statusCode,
          200,
        );
        assert.equal((await request("GET", "/api/users")).statusCode, 401);
        assert.equal(
          (await request("POST", "/api/bootstrap/initialize", {})).statusCode,
          409,
        );
      },
    );
    await t.test(
      "unconfigured connections do not start OAuth, enqueue work or run scheduled sync; settings enable them later",
      async () => {
        const before = calls.length;
        assert.equal(
          (await request("GET", "/api/auth/feishu/status")).json().enabled,
          false,
        );
        for (const [method, url] of [
          ["GET", "/api/auth/feishu/url"],
          ["POST", "/api/sync/run"],
        ]) {
          const result = await request(method, url, undefined, admin);
          assert.equal(result.statusCode, 400, result.body);
          assert.match(result.json().message, /系统设置/);
        }
        const event = {
          subject: "尚未配置连接",
          startAt: new Date(Date.now() + 3600000).toISOString(),
          endAt: new Date(Date.now() + 7200000).toISOString(),
        };
        const result = await request(
          "POST",
          "/api/meetings",
          event,
          admin,
          "unconfigured-request-key-00000001",
        );
        assert.equal(result.statusCode, 400, result.body);
        assert.match(result.json().message, /系统设置/);
        const config = app.get(ConfigurationService);
        await config.update({
          "feishu.login.app-id": "app",
          "sync.interval-minutes": "1",
        });
        assert.equal(
          (await request("GET", "/api/auth/feishu/status")).json().enabled,
          false,
        );
        assert.equal(
          (await request("GET", "/api/auth/feishu/url")).statusCode,
          400,
        );
        await worker.runOnce();
        assert.equal(calls.length, before);
        assert.equal(db.db.select().from(jobs).all().length, 0);
        assert.equal(db.db.select().from(meetings).all().length, 0);
        assert.equal(db.db.select().from(calendarEvents).all().length, 0);
        assert.equal(db.db.select().from(syncRuns).all().length, 0);
        assert.equal(
          db.connection
            .prepare(
              "SELECT COUNT(*) AS count FROM system_state WHERE key LIKE 'oauth:%'",
            )
            .get().count,
          0,
        );
        const saved = await request(
          "PATCH",
          "/api/system/settings",
          {
            revision: (
              await request(
                "GET",
                "/api/system/configuration",
                undefined,
                admin,
              )
            ).json().revision,
            values: {
              "feishu.login.app-id": "app",
              "feishu.login.app-secret": "secret",
              "feishu.login.redirect-uri":
                "http://localhost:15173/api/auth/feishu/callback",
            },
          },
          admin,
        );
        assert.equal(saved.statusCode, 200, saved.body);
        for (const [kind, values] of [
          [
            "feishu-calendar",
            {
              appId: "app",
              appSecret: "secret",
              calendarId: "shared-calendar",
            },
          ],
          [
            "feishu-directory",
            { appId: "app", appSecret: "secret", rootDepartmentId: "0" },
          ],
          [
            "tencent-meeting",
            {
              appId: "enterprise",
              sdkId: "sdk",
              secretId: "key",
              secretKey: "tencent-secret",
              operatorId: "operator",
            },
          ],
        ] as const) {
          const connection = await request(
            "PATCH",
            `/api/platform-connections/${kind}`,
            values,
            admin,
          );
          assert.equal(connection.statusCode, 200, connection.body);
        }
        assert.equal(
          (await request("GET", "/api/auth/feishu/status")).json().enabled,
          true,
        );
      },
    );
    await t.test(
      "operators cannot grant or modify system admins; logout revokes sessions",
      async () => {
        for (const [username, role] of [
          ["operator", "operation_admin"],
          ["ordinary", "user"],
        ]) {
          const r = await request(
            "POST",
            "/api/users",
            {
              username,
              displayName: username,
              password: "LongPassword123",
              role,
            },
            admin,
          );
          assert.equal(r.statusCode, 201, r.body);
          if (username === "ordinary") ownId = r.json().id;
          const login = await request("POST", "/api/auth/login", {
            username,
            password: "LongPassword123",
          });
          const cookie = login.headers["set-cookie"].split(";")[0];
          if (username === "operator") operator = cookie;
          else ordinary = cookie;
        }
        assert.equal(
          (
            await request(
              "POST",
              "/api/users",
              {
                username: "evil",
                displayName: "evil",
                password: "LongPassword123",
                role: "system_admin",
              },
              operator,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (await request("PATCH", "/api/users/1", { role: "user" }, operator))
            .statusCode,
          403,
        );
        assert.equal(
          (await request("GET", "/api/records/audit", undefined, ordinary))
            .statusCode,
          403,
        );
        const login = await request("POST", "/api/auth/login", {
          username: "ordinary",
          password: "LongPassword123",
        });
        const session = login.headers["set-cookie"].split(";")[0];
        await request("POST", "/api/auth/logout", {}, session);
        assert.equal(
          (await request("GET", "/api/auth/me", undefined, session)).statusCode,
          401,
        );
      },
    );
    await t.test(
      "sync policy permissions, partial updates and automatic schedule persistence",
      async () => {
        for (const cookie of [undefined, ordinary]) {
          const status = cookie ? 403 : 401;
          assert.equal(
            (await request("GET", "/api/sync/policy", undefined, cookie))
              .statusCode,
            status,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/sync/policy",
                { automaticMode: "daily" },
                cookie,
              )
            ).statusCode,
            status,
          );
        }
        const sync = app.get(SyncService);
        const config = app.get(ConfigurationService);
        await config.update({ "sync.interval-minutes": "30" });
        const before = Date.now();
        const saved = await request(
          "PATCH",
          "/api/sync/policy",
          {
            overwriteUsers: true,
            preserveExistingPermissions: false,
            automaticMode: "interval",
            intervalMinutes: 120,
          },
          operator,
        );
        assert.equal(saved.statusCode, 200, saved.body);
        const next = Date.parse(saved.json().nextRunAt);
        assert.ok(
          next >= before + 120 * 60000 && next <= Date.now() + 120 * 60000,
        );
        const anchor = db.getState("sync.last-attempt");
        const partial = await request(
          "PATCH",
          "/api/sync/policy",
          { overwriteDepartments: true },
          operator,
        );
        assert.equal(partial.statusCode, 200, partial.body);
        assert.equal(partial.json().overwriteUsers, true);
        assert.equal(partial.json().preserveExistingPermissions, false);
        assert.equal(partial.json().intervalMinutes, 120);
        assert.equal(db.getState("sync.last-attempt"), anchor);
        assert.deepEqual(
          (await request("GET", "/api/sync/policy", undefined, admin)).json(),
          partial.json(),
        );
        const daily = await request(
          "PATCH",
          "/api/sync/policy",
          { automaticMode: "daily", dailyTime: "03:15" },
          operator,
        );
        assert.equal(daily.statusCode, 200, daily.body);
        assert.equal(new Date(daily.json().nextRunAt).getUTCHours(), 19);
        assert.equal(new Date(daily.json().nextRunAt).getUTCMinutes(), 15);
        assert.ok(Date.parse(daily.json().nextRunAt) > Date.now());
        for (const patch of [
          { dailyTime: "25:00" },
          { intervalMinutes: 0 },
          { unexpected: true },
        ])
          assert.equal(
            (await request("PATCH", "/api/sync/policy", patch, operator))
              .statusCode,
            400,
          );
        await request(
          "PATCH",
          "/api/sync/policy",
          {
            automaticMode: "manual",
            overwriteUsers: false,
            overwriteDepartments: false,
            preserveExistingPermissions: true,
          },
          operator,
        );
        db.setState("sync.last-attempt", "2000-01-01T00:00:00Z");
        const attempts = db.db.select().from(syncRuns).all().length;
        await worker.runOnce();
        assert.equal(db.db.select().from(syncRuns).all().length, attempts);
        assert.equal(sync.policy().automaticMode, "manual");
        assert.equal(sync.policyView().nextRunAt, null);
        await config.update({ "sync.interval-minutes": "0" });
      },
    );
    await t.test(
      "real directory calls apply department license rules and update Tencent",
      async () => {
        await request(
          "POST",
          "/api/sync/rules",
          {
            name: "财务高级",
            departmentName: "财务部",
            meetingUserType: "advanced",
          },
          operator,
        );
        const r = await request("POST", "/api/sync/run", {}, operator);
        assert.equal(r.statusCode, 201);
        await worker.runOnce();
        const person = scopedPerson(db,"feishu-directory","ou-user");
        assert.equal(person.meetingUserType, "advanced");
        assert.equal(person.tencentUserId, "f-user");
        assert.equal(person.syncError, null);
        assert.equal(person.systemAccess, "not_added");
        await assert.rejects(
          () => app.get(AuthService).issue(person),
          /未获准登录/,
        );
        const systemList = await request(
          "GET",
          "/api/system-users",
          undefined,
          admin,
        );
        assert.ok(!systemList.json().some((p: any) => p.id === person.id));
        const preview = await request(
          "POST",
          "/api/system-users/feishu-preview",
          {},
          admin,
        );
        assert.equal(preview.statusCode, 201, preview.body);
        const imported = await request(
          "POST",
          "/api/system-users/feishu-import",
          { selectedIds: ["ou-user"], role: "user" },
          admin,
        );
        assert.equal(imported.statusCode, 201, imported.body);
        assert.equal(
          db.db.select().from(users).where(eq(users.id, person.id)).get()!
            .systemAccess,
          "allowed",
        );
        assert.equal(
          (await stat(app.get(ConfigurationService).databasePath)).mode & 0o777,
          0o600,
        );
        assert.ok(
          calls.some(
            (c) =>
              c.url.includes("/v1/users") &&
              c.body.user_account_type === 9 &&
              c.body.department_list.includes("dept-tencent"),
          ),
        );
        assert.ok(
          calls.some(
            (c) =>
              new URL(c.url).pathname === "/v1/users/list" &&
              new URL(c.url).searchParams.get("page") === "2",
          ),
        );
        const beforeRetry = calls.length;
        await app.get(SyncService).run();
        const subsequent = calls.slice(beforeRetry);
        assert.ok(
          !subsequent.some(
            (c) =>
              new URL(c.url).pathname === "/v1/users/f-user" &&
              c.method === "PUT",
          ),
          "default merge skips accounts already in the mapped department and preserves profiles and licenses",
        );
        assert.ok(
          !subsequent.some(
            (c) =>
              new URL(c.url).pathname === "/v1/users" && c.method === "POST",
          ),
        );
      },
    );
    await t.test(
      "account qualification, secrets and ordinary selectors",
      async () => {
        const r = await request(
          "POST",
          "/api/meeting-accounts",
          {
            name: "主持账号",
            accountId: "host1",
            secretId: "key",
            secretKey: "tencent-secret",
          },
          operator,
        );
        assert.equal(r.statusCode, 201, r.body);
        assert.equal(r.json().status, "disabled");
        assert.equal(r.json().secretKey, undefined);
        assert.equal(
          (
            await request(
              "POST",
              "/api/meeting-accounts/" + r.json().id + "/test",
              {},
              operator,
            )
          ).statusCode,
          201,
        );
        const pool = await request(
          "POST",
          "/api/account-pools",
          { name: "共享账号池", accountIds: [r.json().id] },
          operator,
        );
        assert.equal(pool.statusCode, 201);
        const preview = await request(
          "GET",
          "/api/meeting-accounts/platform/tencent-meeting",
          undefined,
          operator,
        );
        assert.equal(preview.statusCode, 200, preview.body);
        assert.ok(
          preview.json().accounts.some((a: any) => a.accountId === "host1"),
        );
        assert.equal(
          (
            await request(
              "GET",
              "/api/meeting-accounts/platform/tencent-meeting",
              undefined,
              ordinary,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/api/meeting-accounts/platform/tencent-meeting/import",
              { accountIds: ["host1"] },
              ordinary,
            )
          ).statusCode,
          403,
        );
        const imported = await request(
          "POST",
          "/api/meeting-accounts/platform/tencent-meeting/import",
          { accountIds: ["host1"], poolId: pool.json().id },
          operator,
        );
        assert.equal(imported.statusCode, 201, imported.body);
        assert.deepEqual(imported.json(), {
          created: 0,
          existing: 1,
          poolAdded: 0,
        });
        assert.equal(
          (await request("GET", "/api/account-pools", undefined, ordinary))
            .statusCode,
          200,
        );
        assert.equal(
          (await request("GET", "/api/directory/people?connectionId=tencent-meeting", undefined, ordinary))
            .statusCode,
          200,
        );
      },
    );
    // These integration scenarios exercise exhaustion of a single pool host;
    // invitee-host priority is covered separately with independent accounts.
    db.db
      .update(meetingAccounts)
      .set({ status: "disabled" })
      .where(eq(meetingAccounts.accountId, "f-user"))
      .run();
    const start = new Date(Date.now() + 3600000).toISOString(),
      end = new Date(Date.now() + 7200000).toISOString();
    const booking = {
      subject: "测试会议",
      startAt: start,
      endAt: end,
      recordingEnabled: true,
      attendeeIds: [
        scopedPerson(db,"feishu-directory","ou-user").id,
      ],
    };
    await t.test(
      "host previews require login, validate inputs and leave reservations untouched",
      async () => {
        const before = db.db.select().from(meetings).all().length;
        assert.equal(
          (await request("POST", "/api/booking/host-preview", booking))
            .statusCode,
          401,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/api/booking/host-preview",
              { ...booking, endAt: start },
              ordinary,
            )
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/api/booking/host-preview",
              { ...booking, attendeeIds: [999999] },
              ordinary,
            )
          ).statusCode,
          400,
        );
        const preview = await request(
          "POST",
          "/api/booking/host-preview",
          booking,
          ordinary,
        );
        assert.equal(preview.statusCode, 201, preview.body);
        assert.equal(preview.json().available, true);
        assert.ok(preview.json().hostAccountName);
        assert.ok(!/secret|passwordHash/i.test(preview.body));
        assert.equal(db.db.select().from(meetings).all().length, before);
      },
    );
    await t.test(
      "concurrent booking cannot allocate the same account, idempotent requests return same meeting",
      async () => {
        const [a, b] = await Promise.all([
          request(
            "POST",
            "/api/meetings",
            booking,
            admin,
            "test-request-000000000000000000001",
          ),
          request(
            "POST",
            "/api/meetings",
            booking,
            admin,
            "test-request-000000000000000000002",
          ),
        ]);
        // Concurrent HTTP requests may reach the transaction in either order.
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
        const winner = a.statusCode === 201 ? a : b;
        const winningKey =
          a.statusCode === 201
            ? "test-request-000000000000000000001"
            : "test-request-000000000000000000002";
        meetingId = winner.json().id;
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings",
              booking,
              ordinary,
              "test-request-000000000000000000003",
            )
          ).statusCode,
          409,
        );
        const repeat = await request(
          "POST",
          "/api/meetings",
          booking,
          admin,
          winningKey,
        );
        assert.equal(repeat.json().id, meetingId);
        await worker.runOnce();
        const row = db.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .get()!;
        assert.equal(row.status, "scheduled");
        assert.equal(
          row.meetingUrl,
          "https://meeting.tencent.com/real-response",
        );
        assert.ok(row.calendarEventId);
        const eventRequest = calls.find(
          (c) =>
            c.method === "POST" &&
            new URL(c.url).pathname.endsWith("/events") &&
            new URL(c.url).searchParams.get("idempotency_key") === winningKey,
        );
        assert.ok(eventRequest);
        assert.equal(eventRequest.body.attendee_ability, "can_invite_others");
        assert.equal(eventRequest.body.visibility, "default");
        assert.equal(row.calendarDescriptionText, eventRequest.body.description);
        const details = await request(
          "GET",
          `/api/meetings/${meetingId}`,
          undefined,
          admin,
        );
        assert.equal(details.statusCode, 200, details.body);
        assert.equal(
          details.json().calendarDescription,
          eventRequest.body.description,
        );
        assert.ok(details.json().calendarDescription.includes("123 456 789"));
        assert.equal(details.json().description, null);
        db.db
          .update(meetings)
          .set({ calendarDescriptionText: null })
          .where(eq(meetings.id, meetingId))
          .run();
        const historical = await request(
          "GET",
          `/api/meetings/${meetingId}`,
          undefined,
          admin,
        );
        assert.equal(
          historical.json().calendarDescription,
          eventRequest.body.description,
        );
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, meetingId)).get()!
            .calendarDescriptionText,
          eventRequest.body.description,
        );
        const tencentRequest = calls
          .filter(
            (c) =>
              c.method === "POST" &&
              new URL(c.url).pathname === "/v1/meetings" &&
              c.body.subject === "测试会议",
          )
          .at(-1);
        assert.ok(tencentRequest);
        assert.deepEqual(tencentRequest.body.hosts, [
          { userid: "host1" },
          { userid: "f-user" },
        ]);
      },
    );
    await t.test(
      "ordinary users cannot cancel or view someone else’s meeting or dashboard",
      async () => {
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings/" + meetingId + "/cancel",
              {},
              ordinary,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "GET",
              "/api/meetings/" + meetingId,
              undefined,
              ordinary,
            )
          ).statusCode,
          403,
        );
        const summary = await request(
          "GET",
          "/api/dashboard/summary",
          undefined,
          ordinary,
        );
        assert.equal(summary.json().meetings, 0);
        assert.equal(summary.json().upcoming.length, 0);
        assert.equal(
          (
            await request(
              "GET",
              "/api/calendar-owners",
              undefined,
              ordinary,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "GET",
              "/api/meetings?owner=all",
              undefined,
              ordinary,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "GET",
              "/api/records/audit/actors",
              undefined,
              ordinary,
            )
          ).statusCode,
          403,
        );
      },
    );
    await t.test(
      "calendar failure retries without creating another Tencent meeting",
      async () => {
        const p = {
          ...booking,
          startAt: new Date(Date.now() + 10800000).toISOString(),
          endAt: new Date(Date.now() + 14400000).toISOString(),
        };
        failCalendar = true;
        const r = await request(
          "POST",
          "/api/meetings",
          p,
          admin,
          "test-request-000000000000000000003",
        );
        await worker.runOnce();
        const row = db.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, r.json().id))
          .get()!;
        assert.equal(row.status, "failed");
        assert.ok(row.externalMeetingId);
        assert.equal(row.meetingCode, "123 456 789");
        const before = remoteCounter;
        failCalendar = false;
        db.db
          .update(jobs)
          .set({ runAt: new Date().toISOString() })
          .where(eq(jobs.status, "queued"))
          .run();
        await worker.runOnce();
        assert.equal(remoteCounter, before);
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, row.id)).get()!
            .status,
          "scheduled",
        );
      },
    );
    await t.test(
      "ambiguous Tencent result holds slot and does not retry POST",
      async () => {
        timeoutTencent = true;
        const p = {
          ...booking,
          startAt: new Date(Date.now() + 18000000).toISOString(),
          endAt: new Date(Date.now() + 21600000).toISOString(),
        };
        const r = await request(
          "POST",
          "/api/meetings",
          p,
          admin,
          "test-request-000000000000000000004",
        );
        await worker.runOnce();
        const row = db.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, r.json().id))
          .get()!;
        assert.equal(row.status, "unknown");
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings",
              p,
              admin,
              "test-request-000000000000000000005",
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings/" + row.id + "/retry",
              {},
              admin,
            )
          ).statusCode,
          409,
        );
        timeoutTencent = false;
      },
    );
    await t.test(
      "cohosts are applied using actual in-meeting identities",
      async () => {
        db.db
          .update(meetings)
          .set({
            startAt: new Date(Date.now() - 60000).toISOString(),
            endAt: new Date(Date.now() + 60000).toISOString(),
          })
          .where(eq(meetings.id, meetingId))
          .run();
        await worker.runOnce();
        assert.ok(
          calls.some(
            (c) =>
              c.url.endsWith("/cohosts") &&
              c.body.user.to_operator_id === "ms-user" &&
              c.body.operator_id === "host1" &&
              c.body.operator_id_type === 1,
          ),
        );
      },
    );
    await t.test(
      "recording downloads refresh URLs and reject untrusted platform addresses",
      async () => {
        const row = db.db
          .select()
          .from(recordings)
          .where(eq(recordings.meetingId, meetingId))
          .get()!;
        assert.equal(row.storageType, "remote");
        db.db
          .update(recordings)
          .set({
            status: "ready",
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            filesJson: JSON.stringify([
              {
                id: "file-1",
                url: "https://download.tencent.com/stale",
                extension: "mp4",
              },
            ]),
          })
          .where(eq(recordings.id, row.id))
          .run();
        const endpoint = `/api/recordings/${row.id}/download?fileId=file-1`;
        downloadUrl =
          "https://download.tencent.com/record.mp4?fresh-token=test";
        const fresh = await request("GET", endpoint, undefined, admin);
        assert.equal(fresh.statusCode, 200, fresh.body);
        assert.equal(fresh.json().url, downloadUrl);
        downloadUrl = "https://attacker.test/record.mp4";
        assert.equal(
          (await request("GET", endpoint, undefined, admin)).statusCode,
          400,
        );
        downloadUrl = "https://download.tencent.com/record.mp4";
      },
    );
    await t.test(
      "recording expiry deletes remote files and revokes download access",
      async () => {
        const r = db.db
          .select()
          .from(recordings)
          .where(eq(recordings.meetingId, meetingId))
          .get()!;
        db.db
          .update(recordings)
          .set({
            status: "ready",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            filesJson: JSON.stringify([
              {
                id: "file-1",
                url: "https://download.tencent.com/record.mp4",
                extension: "mp4",
              },
            ]),
          })
          .where(eq(recordings.id, r.id))
          .run();
        await worker.runOnce();
        assert.ok(
          calls.some(
            (c) =>
              c.method === "DELETE" && c.url.includes("/v1/records/file-1"),
          ),
        );
        assert.equal(
          db.db.select().from(recordings).where(eq(recordings.id, r.id)).get()!
            .status,
          "expired",
        );
        assert.equal(
          (
            await request(
              "GET",
              "/api/recordings/" + r.id + "/download?fileId=file-1",
              undefined,
              admin,
            )
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      "settings never expose secrets, backup is valid and CSRF is blocked",
      async () => {
        const r = await request(
          "GET",
          "/api/system/settings",
          undefined,
          admin,
        );
        const connection = r
          .json()
          .connections.find((item: any) => item.kind === "tencent-meeting");
        assert.equal(connection.values.secretKey, "********");
        assert.equal(r.json().values["auth.jwt-secret"], undefined);
        const backup = await request("POST", "/api/system/backups", {}, admin);
        assert.equal(backup.statusCode, 201, backup.body);
        const bytes = await readFile(
          path.join(root, "data", "backups", backup.json().name),
        );
        assert.equal(bytes.subarray(0, 15).toString(), "SQLite format 3");
        const forbidden = await server.inject({
          method: "POST",
          url: "/api/sync/run",
          payload: {},
          headers: { cookie: admin, origin: "https://untrusted.invalid" },
        });
        assert.equal(forbidden.statusCode, 403);
      },
    );
    await t.test(
      "OAuth state is required, PKCE is used, callback state cannot be replayed",
      async () => {
        const start = await request("GET", "/api/auth/feishu/url");
        const url = new URL(start.json().url);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const cookie = start.headers["set-cookie"].split(";")[0];
        const callback =
          "/api/auth/feishu/callback?code=authorized-code&state=" +
          url.searchParams.get("state");
        const success = await request("GET", callback, undefined, cookie);
        assert.equal(success.statusCode, 302);
        assert.ok(success.headers.location.endsWith("/dashboard"));
        const sessionCookie = success.headers["set-cookie"][0].split(";")[0];
        const me = await request(
          "GET",
          "/api/auth/me",
          undefined,
          sessionCookie,
        );
        assert.equal(
          me.json().user.avatarUrl,
          "https://example.com/oauth-avatar.jpg",
        );
        const profile = await request(
          "GET",
          "/api/profile",
          undefined,
          sessionCookie,
        );
        assert.equal(
          profile.json().avatarUrl,
          "https://example.com/oauth-avatar.jpg",
        );
        const replay = await request("GET", callback, undefined, cookie);
        assert.equal(replay.statusCode, 302);
        const replayLocation = new URL(replay.headers.location);
        assert.equal(
          replayLocation.searchParams.get("auth_error"),
          "feishu_login_failed",
        );
        assert.equal(replayLocation.searchParams.has("error"), false);
        const missing = await request("GET", callback);
        assert.equal(missing.statusCode, 302);
        const missingLocation = new URL(missing.headers.location);
        assert.equal(
          missingLocation.searchParams.get("auth_error"),
          "feishu_login_failed",
        );
        assert.equal(missingLocation.searchParams.has("error"), false);
      },
    );
    await t.test(
      "retired standalone booking rejects stale clients without creating records or jobs",
      async () => {
        const beforeEvents = db.db.select().from(calendarEvents).all().length;
        const beforeJobs = db.db.select().from(jobs).all().length;
        const beforeCalls = calls.length;
        const payload = {
          subject: "旧页面提交",
          startAt: start,
          endAt: end,
        };
        assert.equal(
          (await request("POST", "/api/calendar-events", payload)).statusCode,
          401,
        );
        for (const cookie of [admin, operator, ordinary]) {
          const result = await request(
            "POST",
            "/api/calendar-events",
            payload,
            cookie,
            "retired-request-00000000000000001",
          );
          assert.equal(result.statusCode, 410, result.body);
          assert.match(result.json().message, /刷新页面.*会议预约/);
        }
        assert.equal(
          db.db.select().from(calendarEvents).all().length,
          beforeEvents,
        );
        assert.equal(db.db.select().from(jobs).all().length, beforeJobs);
        assert.equal(calls.length, beforeCalls);
      },
    );
    await t.test(
      "historical personal calendars still permit maintenance and cancellations",
      async () => {
        const payload = {
          subject: "个人日程",
          startAt: start,
          endAt: end,
          extensions: { 项目: "研发" },
          attendees: [{ email: "outside@example.com" }],
        };
        const { id } = db.db
          .insert(calendarEvents)
          .values({
            subject: payload.subject,
            startAt: start,
            endAt: end,
            createdBy: ownId,
            requestKey: "personal-request-00000000000000001",
            payloadJson: JSON.stringify(payload),
            calendarId: "calendar",
            calendarEventId: "historical-event",
            status: "synced",
          })
          .returning()
          .get();
        assert.equal(
          (await request("PATCH", "/api/calendar-events/" + id, payload, admin))
            .statusCode,
          200,
        );
        await worker.runOnce();
        assert.equal(
          (
            await request(
              "PATCH",
              "/api/calendar-events/" + id,
              { ...payload, subject: "修改后的日程" },
              ordinary,
            )
          ).statusCode,
          200,
        );
        await worker.runOnce();
        const updatedEvent = calls.find(
          (c) => c.method === "PATCH" && c.body.summary === "修改后的日程",
        );
        assert.ok(updatedEvent);
        assert.equal(updatedEvent.body.attendee_ability, "can_invite_others");
        await request(
          "POST",
          "/api/calendar-events/" + id + "/cancel",
          undefined,
          ordinary,
        );
        await worker.runOnce();
        assert.equal(
          (await request("GET", "/api/calendar-events", undefined, ordinary))
            .json()
            .find((r: any) => r.id === id).status,
          "cancelled",
        );
      },
    );
    await t.test(
      "manually deleted Tencent meetings finish cancellation after retrying Feishu cleanup",
      async () => {
        const response = await request(
          "POST",
          "/api/meetings",
          {
            ...booking,
            startAt: new Date(Date.now() + 48 * 3600000).toISOString(),
            endAt: new Date(Date.now() + 49 * 3600000).toISOString(),
          },
          admin,
          "cancel-deleted-request-000000000001",
        );
        assert.equal(response.statusCode, 201, response.body);
        const id = response.json().id;
        await worker.runOnce();
        const meeting = () =>
          db.db.select().from(meetings).where(eq(meetings.id, id)).get()!;
        assert.equal(meeting().status, "scheduled");
        deletedTencentMeetings.add(meeting().externalMeetingId!);
        failCalendarDelete = true;
        const cancelled = await request(
          "POST",
          `/api/meetings/${id}/cancel`,
          {},
          admin,
        );
        assert.equal(cancelled.statusCode, 201, cancelled.body);
        await worker.runOnce();
        assert.equal(meeting().status, "cancelling");
        assert.equal(meeting().provisionStep, "meeting_cancelled");
        const cancellationJob = db.db
          .select()
          .from(jobs)
          .all()
          .find(
            (job) =>
              job.type === "meeting.cancel" &&
              JSON.parse(job.payloadJson).id === id,
          )!;
        db.db
          .update(jobs)
          .set({ attempts: 4, runAt: new Date(0).toISOString() })
          .where(eq(jobs.id, cancellationJob.id))
          .run();
        await worker.runOnce();
        assert.equal(meeting().status, "cancel_failed");
        assert.equal(
          db.db
            .select()
            .from(jobs)
            .where(eq(jobs.id, cancellationJob.id))
            .get()!.status,
          "failed",
        );

        failCalendarDelete = false;
        assert.equal(
          (await request("POST", `/api/meetings/${id}/cancel`, {}, admin))
            .statusCode,
          201,
        );
        await worker.runOnce();
        assert.equal(meeting().status, "cancelled");
        assert.equal(meeting().error, null);
        assert.equal(
          calls.filter((call) =>
            call.url.includes(`/meetings/${meeting().externalMeetingId}/cancel`),
          ).length,
          1,
        );
        assert.ok(
          calls.some(
            (call) =>
              call.method === "DELETE" &&
              call.url.includes(`/events/${meeting().calendarEventId}`),
          ),
        );
        const jobCount = db.db.select().from(jobs).all().length;
        await request("POST", `/api/meetings/${id}/cancel`, {}, admin);
        assert.equal(db.db.select().from(jobs).all().length, jobCount);
      },
    );
    await t.test(
      "offset timestamps collide correctly and changed payload cannot reuse an idempotency key",
      async () => {
        const normalize = (s: string) =>
          new Date(Date.parse(s) + 8 * 3600000)
            .toISOString()
            .replace("Z", "+08:00");
        const future = new Date(Date.now() + 30 * 3600000).toISOString(),
          later = new Date(Date.now() + 31 * 3600000).toISOString();
        const p = {
          ...booking,
          startAt: normalize(future),
          endAt: normalize(later),
        };
        const key = "timezone-request-00000000000000001";
        const row = await request("POST", "/api/meetings", p, admin, key);
        assert.equal(row.statusCode, 201, row.body);
        assert.equal(row.json().startAt, future);
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings",
              { ...p, subject: "改名" },
              admin,
              key,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/api/meetings",
              { ...p, startAt: future, endAt: later },
              ordinary,
              "timezone-request-00000000000000002",
            )
          ).statusCode,
          409,
        );
      },
    );
    await t.test(
      "retry rechecks account conflicts and restart preserves ambiguous creation state",
      async () => {
        const bookingService = app.get(MeetingService),
          future = new Date(Date.now() + 36 * 3600000).toISOString(),
          later = new Date(Date.now() + 37 * 3600000).toISOString();
        const a = await request(
          "POST",
          "/api/meetings",
          { ...booking, startAt: future, endAt: later },
          admin,
          "recovery-request-00000000000000001",
        );
        const id = a.json().id;
        db.db
          .update(meetings)
          .set({ status: "failed" })
          .where(eq(meetings.id, id))
          .run();
        db.db
          .update(jobs)
          .set({ status: "failed" })
          .where(eq(jobs.status, "queued"))
          .run();
        const b = await request(
          "POST",
          "/api/meetings",
          { ...booking, startAt: future, endAt: later },
          ordinary,
          "recovery-request-00000000000000002",
        );
        assert.equal(b.statusCode, 201, b.body);
        assert.equal(
          (await request("POST", "/api/meetings/" + id + "/retry", {}, admin))
            .statusCode,
          409,
        );
        db.db
          .update(meetings)
          .set({ provisionStep: "meeting_inflight", status: "unknown" })
          .where(eq(meetings.id, b.json().id))
          .run();
        const before = remoteCounter;
        await assert.rejects(() => bookingService.provision(b.json().id));
        assert.equal(remoteCounter, before);
      },
    );
    await t.test(
      "an invited advanced account creates the meeting as host and still receives its Feishu invitation",
      async () => {
        const invitee = db.db
          .select()
          .from(users)
          .where(eq(users.feishuUserId, "f-user"))
          .get()!;
        const account = db.db
          .select()
          .from(meetingAccounts)
          .where(eq(meetingAccounts.accountId, "f-user"))
          .get()!;
        db.db
          .update(meetingAccounts)
          .set({ status: "available" })
          .where(eq(meetingAccounts.id, account.id))
          .run();
        try {
          const response = await request(
            "POST",
            "/api/meetings",
            {
              ...booking,
              startAt: new Date(Date.now() + 96 * 3600000).toISOString(),
              endAt: new Date(Date.now() + 97 * 3600000).toISOString(),
              attendeeIds: [invitee.id],
            },
            admin,
            "invitee-host-integration-request-001",
          );
          assert.equal(response.statusCode, 201, response.body);
          assert.equal(response.json().allocationSource, "invitee");
          assert.equal(response.json().hostAccountId, "f-user");
          const before = calls.length;
          await worker.runOnce();
          const row = db.db
            .select()
            .from(meetings)
            .where(eq(meetings.id, response.json().id))
            .get()!;
          assert.equal(row.status, "scheduled");
          const created = calls
            .slice(before)
            .find(
              (call) =>
                new URL(call.url).pathname === "/v1/meetings" &&
                call.method === "POST",
            )!;
          assert.equal(created.body.userid, "f-user");
          assert.deepEqual(created.body.hosts, [{ userid: "f-user" }]);
          assert.deepEqual(created.body.invitees, []);
          assert.ok(
            calls
              .slice(before)
              .some(
                (call) =>
                  new URL(call.url).pathname.endsWith("/attendees") &&
                  call.method === "POST" &&
                  call.body.attendees.some(
                    (attendee: any) => attendee.user_id === "f-user",
                  ),
              ),
          );
          const attendee = db.db
            .select()
            .from(meetingAttendees)
            .where(eq(meetingAttendees.meetingId, row.id))
            .get()!;
          assert.equal(attendee.isCohost, false);
          assert.equal(attendee.cohostStatus, "host");
        } finally {
          db.db
            .update(meetingAccounts)
            .set({ status: "disabled" })
            .where(eq(meetingAccounts.id, account.id))
            .run();
        }
      },
    );
    await t.test(
      "manual host selection is exposed safely and used by the real Tencent creation request",
      async () => {
        const people = ["manual-first", "manual-second"].map((name) =>
          db.db
            .insert(users)
            .values({
              username: name,
              displayName: name,
              meetingUserType: "advanced",
              tencentUserId: name,
              feishuUserId: name,
            })
            .returning()
            .get(),
        );
        for(const p of people)db.db.insert(platformIdentities).values({providerId:"tencent",connectionId:"tencent-meeting",externalId:p.username,name:p.displayName,userId:p.id,profileJson:JSON.stringify({providerData:{advanced:true}})}).run();
        const accounts = people.map((p) =>
          db.db
            .insert(meetingAccounts)
            .values({
              name: p.displayName,
              accountId: p.username,
              verifiedAt: new Date().toISOString(),
            })
            .returning()
            .get(),
        );
        const directory = await request(
          "GET",
          "/api/directory/people?connectionId=tencent-meeting",
          undefined,
          admin,
        );
        assert.equal(directory.statusCode, 200);
        assert.equal(
          directory.json().find((p: any) => p.id === people[1]!.id).canHost,
          true,
        );
        assert.ok(!JSON.stringify(directory.json()).includes("secret"));
        const payload = {
          ...booking,
          startAt: new Date(Date.now() + 192 * 3600000).toISOString(),
          endAt: new Date(Date.now() + 193 * 3600000).toISOString(),
          attendeeIds: people.map((p) => p.id),
          hostMode: "person",
          hostUserId: people[1]!.id,
        };
        const preview = await request(
          "POST",
          "/api/booking/host-preview",
          payload,
          admin,
        );
        assert.equal(preview.statusCode, 201, preview.body);
        assert.equal(preview.json().hostAccountId, "manual-second");
        const created = await request(
          "POST",
          "/api/meetings",
          payload,
          admin,
          "manual-host-selection-integration-001",
        );
        assert.equal(created.statusCode, 201, created.body);
        assert.equal(created.json().meetingAccountId, accounts[1]!.id);
        const before = calls.length;
        await worker.runOnce(false);
        const remote = calls
          .slice(before)
          .find(
            (call) =>
              new URL(call.url).pathname === "/v1/meetings" &&
              call.method === "POST",
          )!;
        assert.ok(remote);
        assert.equal(remote.body.userid, "manual-second");
        assert.deepEqual(remote.body.hosts, [
          { userid: "manual-second" },
          { userid: "manual-first" },
        ]);
        db.db
          .update(meetingAccounts)
          .set({ verifiedAt: null })
          .where(eq(meetingAccounts.id, accounts[1]!.id))
          .run();
        const updated = await request(
          "GET",
          "/api/directory/people?connectionId=tencent-meeting",
          undefined,
          admin,
        );
        assert.equal(
          updated.json().find((p: any) => p.id === people[1]!.id).canHost,
          false,
        );
      },
    );
    await t.test(
      "finishing a meeting requires ownership, releases it locally and makes no platform requests",
      async () => {
        const row = db.db
          .insert(meetings)
          .values({
            subject: "本地结束会议",
            status: "scheduled",
            createdBy: ownId,
            startAt: new Date(Date.now() - 60000).toISOString(),
            endAt: new Date(Date.now() + 3600000).toISOString(),
            externalMeetingId: "keep-tencent-reservation",
            calendarEventId: "keep-feishu-reservation",
            calendarId: "calendar",
            calendarDescriptionText: "原预约保持不变",
          })
          .returning()
          .get();
        const url = `/api/meetings/${row.id}/finish`;
        const before = calls.length;
        assert.equal((await request("POST", url)).statusCode, 401);
        const own = await request("POST", url, {}, ordinary);
        assert.equal(own.statusCode, 201, own.body);
        assert.deepEqual(own.json(), { ok: true });
        assert.equal(
          (await request("POST", url, {}, ordinary)).statusCode,
          201,
        );
        assert.equal(
          (await request("POST", url, {}, operator)).statusCode,
          201,
        );
        assert.equal(
          (await request("POST", "/api/meetings/invalid/finish", {}, admin))
            .statusCode,
          400,
        );
        const ended = db.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, row.id))
          .get()!;
        assert.deepEqual(ended, {
          ...row,
          status: "finished",
          updatedAt: ended.updatedAt,
        });
        const summary = await request(
          "GET",
          "/api/dashboard/summary",
          undefined,
          ordinary,
        );
        assert.ok(
          !summary
            .json()
            .upcoming.some((meeting: any) => meeting.id === row.id),
        );
        // An invitation permits reading but does not grant control of the host.
        db.db
          .update(meetings)
          .set({ createdBy: 1, status: "scheduled" })
          .where(eq(meetings.id, row.id))
          .run();
        db.db
          .insert(meetingAttendees)
          .values({ meetingId: row.id, userId: ownId, displayName: "ordinary" })
          .run();
        assert.equal(
          (await request("POST", url, {}, ordinary)).statusCode,
          403,
        );
        assert.equal((await request("POST", url, {}, admin)).statusCode, 201);
        assert.equal(calls.length, before);
      },
    );
    await t.test("recording URLs allow trusted HTTPS downloads only", () => {
      assert.equal(
        recordingUrl("https://download.tencent.com/record.mp4"),
        "https://download.tencent.com/record.mp4",
      );
      for (const url of [
        "http://127.0.0.1/private",
        "https://tencent.com.attacker.test/video",
        "https://user:secret@download.tencent.com/video",
        "not-a-url",
      ])
        assert.throws(() => recordingUrl(url));
    });
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
