import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { platformComponents } from "../src/platforms/index.js";
import { fakeMeeting } from "./fake-meeting-component.js";
import { PlatformRegistry } from "../src/platforms/registry.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { PlatformHttp, PlatformError } from "../src/platforms/shared/http.js";
import { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { DirectoryService } from "../src/directory.service.js";
import { DatabaseService } from "../src/database.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { AuthService } from "../src/auth.service.js";
import { MeetingService } from "../src/meeting.service.js";
import { RecordingService } from "../src/recording.service.js";
import {
  users,
  platformIdentities,
  meetings,
  recordings,
  meetingAccounts,
  accountPools,
  accountPoolMembers,
} from "../src/db/schema.js";
import { feishuIdentity } from "../src/platforms/shared/feishu/identity.js";
import { selectMeetingHost } from "../src/platforms/meeting/tencent/allocation.js";

test("registered components, Feishu application meetings and connection isolation", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agenda-link-platform-"),
  );
  const workspace = path.join(temporaryRoot, "fresh-workspace");
  const previous = { ...process.env };
  Object.assign(process.env, {
    AGENDA_LINK_WORKSPACE: workspace,
    AGENDA_LINK_TEST: "true",
    AGENDA_LINK_DISABLE_WORKER: "true",
  });
  // This registration is the only application entry change the test platform needs.
  platformComponents.push(fakeMeeting);
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const db = app.get(DatabaseService),
    connections = app.get(PlatformConnectionService),
    registry = app.get(PlatformRegistry),
    booking = app.get(MeetingService),
    directory = app.get(DirectoryService),
    feishu = app.get(FeishuAdapter),
    auth = app.get(AuthService),
    config = app.get(ConfigurationService);
  const owner = db.db
    .insert(users)
    .values({ username: "owner", displayName: "Owner", role: "system_admin" })
    .returning()
    .get();
  const ordinary = db.db
    .insert(users)
    .values({ username: "ordinary", displayName: "Ordinary" })
    .returning()
    .get();
  const admin = await auth.issue(owner),
    user = await auth.issue(ordinary);
  const server = app.getHttpAdapter().getInstance();
  const api = (
    who: typeof admin,
    method: string,
    url: string,
    payload?: unknown,
  ) =>
    server.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer " + who.token },
    });
  let calendarFail = false,
    recordingReady = false,
    postCount = 0,
    eventCount = 0;
  const calls: { path: string; method: string; body: any }[] = [];
  app.get(PlatformHttp).request = async (raw, method, _headers, body) => {
    const url = new URL(raw),
      p = url.pathname.replace("/open-apis", "");
    calls.push({ path: p, method, body });
    if (p.includes("tenant_access_token"))
      return { code: 0, tenant_access_token: "app-token", expire: 3600 };
    if (p === "/vc/v1/reserves/apply") {
      postCount++;
      assert.equal(url.searchParams.get("user_id_type"), "user_id");
      assert.equal((body as any).owner_id, "default-owner");
      assert.equal((body as any).meeting_settings.auto_record, true);
      return {
        code: 0,
        data: {
          reserve: {
            id: "reserve-" + postCount,
            meeting_no: "123456789",
            url: "https://vc.feishu.cn/j/123456789",
          },
        },
      };
    }
    if (p.endsWith("get_active_meeting"))
      return { code: 0, data: { meeting: { id: "runtime-1" } } };
    if (p === "/vc/v1/meetings/list_by_no")
      return {
        code: 0,
        data: { meeting_briefs: [{ id: "runtime-1" }], has_more: false },
      };
    if (p === "/vc/v1/meetings/runtime-1/recording")
      return recordingReady
        ? {
            code: 0,
            data: {
              recording: { url: "https://tenant.feishu.cn/minutes/recording" },
            },
          }
        : { code: 124002 };
    if (method === "DELETE" && p.startsWith("/vc/v1/reserves/"))
      return { code: 0 };
    throw new Error("Unexpected mock API " + method + " " + p);
  };
  feishu.createEvent = async (payload) => {
    eventCount++;
    assert.equal(payload.meetingUrl, "https://vc.feishu.cn/j/123456789");
    assert.equal(
      (payload as any).vchat,
      undefined,
      "calendar must not create a second conference",
    );
    if (calendarFail) throw new PlatformError("飞书", "MOCK_CALENDAR_FAILED");
    return { id: "event-1", calendarId: "calendar-1" };
  };
  feishu.invite = async () => {};
  feishu.updateEvent = async () => {};
  feishu.deleteEvent = async () => {};
  const input = () => ({
    subject: "组件预约",
    startAt: new Date(Date.now() + 3600000).toISOString(),
    endAt: new Date(Date.now() + 7200000).toISOString(),
    connectionId: "feishu-meeting",
    providerId: "feishu",
    recordingEnabled: true,
    calendarConnectionId: null,
  });
  let sequence = 0;
  const reserve = (body: unknown) =>
    booking.reserve(
      body,
      ("platform-" + String(++sequence).padStart(3, "0")).padEnd(32, "0"),
      admin.user,
    );
  try {
    await t.test(
      "fresh installation uses new files and leaves legacy deployment untouched",
      async () => {
        const legacy = path.join(workspace, "wemeet-link.properties");
        await writeFile(legacy, "platform.name=legacy\n");
        assert.equal(path.basename(config.filePath), "agenda-link.properties");
        assert.equal(path.basename(config.databasePath), "agenda-link.sqlite");
        assert.equal(await readFile(legacy, "utf8"), "platform.name=legacy\n");
        assert.equal(config.get("platform.name"), "AgendaLink");
      },
    );
    await t.test(
      "metadata drives config and secrets are restricted to admin masks",
      async () => {
        const initial = (await api(user, "GET", "/api/platforms")).json();
        assert.ok(
          initial.some((p: any) => p.id === "meeting.example" && !p.configured),
        );
        assert.ok(initial.every((p: any) => !p.fields));
        const saved = await api(
          admin,
          "PATCH",
          "/api/platform-connections/example-meeting",
          { token: "test-component-secret" },
        );
        assert.equal(saved.statusCode, 200, saved.body);
        assert.ok(!saved.body.includes("test-component-secret"));
        const forms = await api(admin, "GET", "/api/platform-connections");
        const form = forms
          .json()
          .find((p: any) => p.kind === "example-meeting");
        assert.equal(form.fields[0].key, "token");
        assert.equal(form.values.token, "********");
        assert.equal(
          (await api(user, "GET", "/api/platform-connections")).statusCode,
          403,
        );
        const result = booking.reserve(
          {
            subject: "测试组件",
            startAt: input().startAt,
            endAt: input().endAt,
            connectionId: "example-meeting",
            calendarConnectionId: null,
          },
          "example-request".padEnd(32, "0"),
          admin.user,
        );
        await booking.provision(result.id);
        assert.equal(
          booking.detail(result.id, admin.user).externalMeetingId,
          "example-1",
        );
      },
    );
    await t.test(
      "books a local schedule without an online meeting",
      async () => {
        const result = reserve({
          subject: "无在线会议日程",
          startAt: input().startAt,
          endAt: input().endAt,
          providerId: "local",
          connectionId: "local-meeting",
          calendarConnectionId: null,
        });
        await booking.provision(result.id);
        const detail = booking.detail(result.id, admin.user);
        assert.equal(detail.status, "scheduled");
        assert.equal(detail.platformName, "无在线会议");
        assert.match(String(detail.externalMeetingId), /^local-/);
        assert.equal(detail.meetingUrl, null);
        assert.equal(detail.meetingCode, null);
        // 内置连接不可在系统设置中配置
        const kinds = connections.all().map((row) => row.kind);
        assert.ok(!kinds.includes("local-meeting"));
        assert.throws(
          () => connections.update("local-meeting", {}),
          /内置/,
        );
        assert.throws(
          () =>
            reserve({
              ...input(),
              providerId: "local",
              connectionId: "local-meeting",
              recordingEnabled: true,
            }),
          /不支持云录制/,
        );
        assert.throws(
          () =>
            reserve({
              ...input(),
              providerId: "local",
              connectionId: "local-meeting",
              hostMode: "person",
              hostUserId: admin.user.id,
            }),
          /无需指定发起账号/,
        );
      },
    );
    await t.test("meeting list accepts an optional time window", async () => {
      const start = new Date(Date.now() + 2 * 86400000);
      const outsideStart = new Date(Date.now() + 20 * 86400000);
      reserve({
        subject: "窗口内会议",
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 3600000).toISOString(),
        providerId: "local",
        connectionId: "local-meeting",
        calendarConnectionId: null,
      });
      reserve({
        subject: "窗口外会议",
        startAt: outsideStart.toISOString(),
        endAt: new Date(outsideStart.getTime() + 3600000).toISOString(),
        providerId: "local",
        connectionId: "local-meeting",
        calendarConnectionId: null,
      });
      const rows = booking.list(admin.user, {
        from: new Date(Date.now() + 86400000).toISOString(),
        to: new Date(Date.now() + 3 * 86400000).toISOString(),
      });
      const subjects = rows.map((row) => row.subject);
      assert.ok(subjects.includes("窗口内会议"));
      assert.ok(!subjects.includes("窗口外会议"));
      assert.equal(
        (await api(admin, "GET", "/api/meetings?from=not-a-date")).statusCode,
        400,
      );
      const first = await api(admin, "GET", "/api/meetings?limit=1&offset=0");
      assert.equal(first.json().length, 1);
      assert.ok(Number(first.headers["x-total-count"]) >= 2);
      const second = await api(admin, "GET", "/api/meetings?limit=1&offset=1");
      assert.notEqual(second.json()[0].id, first.json()[0].id);
      assert.equal(
        (await api(admin, "GET", "/api/meetings?limit=0")).statusCode,
        400,
      );
      assert.equal(
        (await api(admin, "GET", "/api/meetings?offset=-1")).statusCode,
        400,
      );
      assert.equal(
        (await api(admin, "GET", "/api/calendar-events?limit=0")).statusCode,
        400,
      );
    });
    connections.update("feishu-meeting", {
      appId: "meeting-app",
      appSecret: "secret",
      defaultOwnerUserId: "default-owner",
      tenantKey: "tenant",
    });
    await t.test(
      "multiple configured meeting connections require explicit selection; 30 days checked before queueing",
      () => {
        assert.throws(() => registry.select("meeting"), /请选择/);
        assert.throws(
          () =>
            reserve({
              ...input(),
              endAt: new Date(Date.now() + 31 * 86400000).toISOString(),
            }),
          /30 天/,
        );
        assert.equal(postCount, 0);
        assert.throws(
          () => reserve({ ...input(), providerId: "tencent" }),
          /不匹配/,
        );
      },
    );
    await t.test(
      "standalone Feishu meeting stores reservation ID, skips calendar and cancels reservation",
      async () => {
        const body = input(),
          row = reserve(body);
        assert.equal(reserveWithKey(row.requestKey!, body).id, row.id);
        await booking.provision(row.id);
        const detail = booking.detail(row.id, admin.user);
        assert.equal(detail.externalMeetingId, "reserve-1");
        assert.equal(detail.calendarStatus, "not_requested");
        assert.equal(eventCount, 0);
        assert.equal(detail.capabilities.remoteEnd, false);
        assert.equal(detail.capabilities.deleteRecording, false);
        assert.throws(() => booking.cancel(row.id, user.user), /自己的/);
        booking.cancel(row.id, admin.user);
        await booking.performCancel(row.id);
        assert.ok(
          calls.some(
            (c) =>
              c.path === "/vc/v1/reserves/reserve-1" && c.method === "DELETE",
          ),
        );
        function reserveWithKey(key: string, body: unknown) {
          return booking.reserve(body, key, admin.user);
        }
      },
    );
    await t.test(
      "Feishu meeting prefers the requester's app identity and requires an owner when unavailable",
      () => {
        connections.update("feishu-directory", {
          appId: "directory-app",
          appSecret: "secret",
          tenantKey: "tenant",
        });
        db.db
          .insert(platformIdentities)
          .values({
            providerId: "feishu",
            connectionId: "feishu-directory",
            kind: "person",
            externalId: "directory-open-id",
            stableId: "requester-user-id",
            userId: owner.id,
            name: owner.displayName,
          })
          .run();
        const provider = registry.meeting("feishu-meeting"),
          startAt = input().startAt,
          endAt = input().endAt;
        assert.equal(
          provider.selectHost(
            db.db,
            { startAt, endAt, attendeeIds: [], hostMode: "auto" },
            owner.id,
          )?.hostAccountId,
          "requester-user-id",
        );
        connections.update("feishu-meeting", { defaultOwnerUserId: "" });
        assert.throws(
          () =>
            provider.selectHost(
              db.db,
              { startAt, endAt, attendeeIds: [], hostMode: "auto" },
              ordinary.id,
            ),
          /默认归属人/,
        );
        connections.update("feishu-meeting", {
          defaultOwnerUserId: "default-owner",
        });
        db.db
          .delete(platformIdentities)
          .where(
            and(
              eq(platformIdentities.connectionId, "feishu-directory"),
              eq(platformIdentities.externalId, "directory-open-id"),
            ),
          )
          .run();
        connections.update("feishu-directory", { tenantKey: "" });
      },
    );
    connections.update("feishu-calendar", {
      appId: "calendar-app",
      appSecret: "secret",
      calendarId: "calendar-1",
      tenantKey: "tenant",
    });
    await t.test(
      "calendar failure retries only the calendar, keeping the original meeting and connection",
      async () => {
        calendarFail = true;
        const row = reserve({
          ...input(),
          calendarConnectionId: "feishu-calendar",
        });
        await assert.rejects(
          () => booking.provision(row.id),
          /MOCK_CALENDAR_FAILED/,
        );
        const created = postCount,
          detail = booking.detail(row.id, admin.user);
        assert.equal(detail.calendarStatus, "failed");
        assert.ok(detail.externalMeetingId);
        calendarFail = false;
        booking.retry(row.id, admin.user);
        await booking.provision(row.id);
        assert.equal(postCount, created);
        assert.equal(
          booking.detail(row.id, admin.user).calendarStatus,
          "synced",
        );
        assert.equal(
          booking.detail(row.id, admin.user).connectionId,
          "feishu-meeting",
        );
      },
    );
    await t.test(
      "Feishu recording waits for runtime meeting recording and expires local entry without deletion",
      async () => {
        const row = reserve(input());
        await booking.provision(row.id);
        db.db
          .update(meetings)
          .set({
            startAt: new Date(Date.now() - 7200000).toISOString(),
            endAt: new Date(Date.now() - 3600000).toISOString(),
          })
          .where(eq(meetings.id, row.id))
          .run();
        const recording = db.db
          .select()
          .from(recordings)
          .where(eq(recordings.meetingId, row.id))
          .get()!;
        const service = app.get(RecordingService);
        await service.poll(recording);
        assert.equal(
          db.db
            .select()
            .from(recordings)
            .where(eq(recordings.id, recording.id))
            .get()!.status,
          "processing",
        );
        recordingReady = true;
        await service.poll(recording);
        const ready = db.db
          .select()
          .from(recordings)
          .where(eq(recordings.id, recording.id))
          .get()!;
        assert.equal(ready.status, "ready");
        assert.ok(ready.filesJson?.includes("runtime-1"));
        db.db
          .update(recordings)
          .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
          .where(eq(recordings.id, ready.id))
          .run();
        await service.expire(
          db.db
            .select()
            .from(recordings)
            .where(eq(recordings.id, ready.id))
            .get()!,
        );
        assert.equal(
          db.db
            .select()
            .from(recordings)
            .where(eq(recordings.id, ready.id))
            .get()!.status,
          "expired",
        );
        assert.ok(
          !calls.some(
            (c) => c.method === "DELETE" && c.path.includes("recording"),
          ),
        );
      },
    );
    await t.test(
      "directory import scopes colliding IDs and Feishu application identities",
      async () => {
        connections.update("feishu-directory", {
          appId: "directory-app",
          appSecret: "secret",
        });
        connections.update("tencent-meeting", {
          appId: "tencent",
          sdkId: "sdk",
          secretId: "key",
          secretKey: "secret",
          operatorId: "operator",
        });
        feishu.directory = async () => ({
          departments: [],
          people: [
            {
              open_id: "same",
              user_id: "stable",
              name: "飞书人员",
              department_ids: [],
            },
          ],
        });
        const tencent = app.get(TencentAdapter);
        tencent.departments = async () => [];
        tencent.userList = async () => [{ userid: "same" }];
        tencent.user = async () => ({
          userid: "same",
          username: "腾讯人员",
          user_account_type: 9,
          status: 1,
        });
        for (const id of ["feishu-directory", "tencent-meeting"]) {
          const snapshot = await directory.read(id, owner.id);
          directory.import(id, ["same"], snapshot.fetchedAt!, owner.id);
        }
        const identities = db.db
          .select()
          .from(platformIdentities)
          .where(eq(platformIdentities.externalId, "same"))
          .all();
        assert.equal(identities.length, 2);
        assert.notEqual(identities[0]!.userId, identities[1]!.userId);
        const tencentAccount = db.db
          .select()
          .from(meetingAccounts)
          .where(
            and(
              eq(meetingAccounts.connectionId, "tencent-meeting"),
              eq(meetingAccounts.accountId, "same"),
            ),
          )
          .get()!;
        const exampleAccount = db.db
          .insert(meetingAccounts)
          .values({
            providerId: "example",
            connectionId: "example-meeting",
            accountId: "same",
            name: "相同账号 ID",
            verifiedAt: new Date().toISOString(),
          })
          .returning()
          .get();
        const tencentPool = db.db
          .insert(accountPools)
          .values({
            providerId: "tencent",
            connectionId: "tencent-meeting",
            name: "腾讯池",
          })
          .returning()
          .get();
        const examplePool = db.db
          .insert(accountPools)
          .values({
            providerId: "example",
            connectionId: "example-meeting",
            name: "示例池",
          })
          .returning()
          .get();
        db.db
          .insert(accountPoolMembers)
          .values([
            { poolId: tencentPool.id, accountId: tencentAccount.id },
            { poolId: examplePool.id, accountId: exampleAccount.id },
          ])
          .run();
        const choice = selectMeetingHost(
          db.db,
          {
            startAt: new Date(Date.now() + 3600000).toISOString(),
            endAt: new Date(Date.now() + 7200000).toISOString(),
            attendeeIds: [],
            hostMode: "pool",
            accountPoolId: tencentPool.id,
          },
          owner.id,
          "tencent-meeting",
        );
        assert.equal(
          choice?.meetingAccountId,
          tencentAccount.id,
          "same external account ID in another connection cannot leak into this pool",
        );
        const local = identities.find(
          (i) => i.connectionId === "feishu-directory",
        )!.userId!;
        assert.deepEqual(
          feishuIdentity(db.db, connections, "feishu-meeting", local),
          {},
          "unknown tenant cannot reuse user_id or open_id",
        );
        connections.update("feishu-directory", { tenantKey: "tenant" });
        assert.deepEqual(
          feishuIdentity(db.db, connections, "feishu-meeting", local),
          { userId: "stable" },
        );
        connections.update("feishu-meeting", {
          tenantKey: "other",
          appId: "directory-app",
        });
        assert.deepEqual(
          feishuIdentity(db.db, connections, "feishu-meeting", local),
          { userId: "stable" },
          "same application is safe",
        );
        db.db
          .update(platformIdentities)
          .set({ stableId: null })
          .where(
            and(
              eq(platformIdentities.connectionId, "feishu-directory"),
              eq(platformIdentities.userId, local),
            ),
          )
          .run();
        connections.update("feishu-meeting", {
          appId: "other-app",
          tenantKey: "tenant",
        });
        assert.deepEqual(
          feishuIdentity(db.db, connections, "feishu-meeting", local),
          {},
          "same tenant does not make open_id cross-app safe",
        );
      },
    );
  } finally {
    await app.close();
    platformComponents.pop();
    for (const key of [
      "AGENDA_LINK_WORKSPACE",
      "AGENDA_LINK_TEST",
      "AGENDA_LINK_DISABLE_WORKER",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
