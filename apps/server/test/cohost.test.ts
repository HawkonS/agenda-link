import {registryFixture} from "./platform-fixture.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { DatabaseService } from "../src/database.service.js";
import { MeetingService } from "../src/meeting.service.js";
import { WorkerService } from "../src/worker.service.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { PlatformError, type PlatformHttp } from "../src/platforms/shared/http.js";
import type { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import type { CalendarService } from "../src/calendar.service.js";
import type { RecordingService } from "../src/recording.service.js";
import type { SyncService } from "../src/sync.service.js";
import {
  meetings,
  meetingAccounts,
  meetingAttendees,
} from "../src/db/schema.js";

const participant = (extra: Record<string, unknown> = {}) => ({
  userid: "target",
  ms_open_id: "live-target",
  instanceid: 2,
  user_role: 0,
  ...extra,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture() {
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-cohost-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  const config = new ConfigurationService();
  const database = new DatabaseService(config);
  const connections = new PlatformConnectionService(config, database);
  connections.update("tencent-meeting", {
    appId: "app",
    sdkId: "sdk",
    secretId: "key",
    secretKey: "secret",
    operatorId: "admin",
  });
  const state = {
    status: "4",
    pages: [[participant()]] as any[][],
    readError: undefined as Error | undefined,
    writeError: undefined as Error | undefined,
    invalidPage: false,
  };
  const calls: { url: URL; method: string; body?: any }[] = [];
  const http = {
    request: async (
      raw: string,
      method: string,
      _headers: unknown,
      body?: string,
    ) => {
      const url = new URL(raw);
      calls.push({ url, method, body: body ? JSON.parse(body) : undefined });
      if (method === "GET") {
        assert.ok(
          url.pathname.endsWith("/real-time-participants"),
          "historical records cannot drive live controls",
        );
        assert.equal(url.searchParams.get("operator_id"), "creator");
        assert.equal(url.searchParams.get("operator_id_type"), "1");
        assert.equal(url.searchParams.get("page_size"), "50");
        if (state.readError) throw state.readError;
        const page = Number(url.searchParams.get("page"));
        return {
          status: state.status,
          current_page:
            state.pages.length === 0 ? 0 : state.invalidPage ? 1 : page,
          total_page: state.pages.length,
          ...(state.pages.length
            ? { participants: state.pages[page - 1] || [] }
            : {}),
        };
      }
      assert.equal(method, "PUT");
      assert.ok(url.pathname.endsWith("/cohosts"));
      if (state.writeError) throw state.writeError;
      return {};
    },
  } as unknown as PlatformHttp;
  const tencent = new TencentAdapter(config, http, connections);
  const booking = new MeetingService(
    database,
    config,
    registryFixture(config,database,connections,tencent,{} as FeishuAdapter),
    connections,
  );
  const account = database.db
    .insert(meetingAccounts)
    .values({ name: "Creator", accountId: "creator" })
    .returning()
    .get();
  const row = database.db
    .insert(meetings)
    .values({
      subject: "Cohost",
      startAt: new Date(Date.now() - 60000).toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      status: "scheduled",
      externalMeetingId: "remote-meeting",
      meetingAccountId: account.id,
    })
    .returning()
    .get();
  const attendee = database.db
    .insert(meetingAttendees)
    .values({
      meetingId: row.id,
      externalId: "target",
      displayName: "Target",
      isCohost: true,
    })
    .returning()
    .get();
  const get = () =>
    database.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.id, attendee.id))
      .get()!;
  const check = () =>
    booking.cohosts(
      database.db.select().from(meetings).where(eq(meetings.id, row.id)).get()!,
    );
  const controls = () => calls.filter((c) => c.method === "PUT");
  const close = async () => {
    database.onModuleDestroy();
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  };
  return {
    config,
    database,
    connections,
    tencent,
    booking,
    state,
    calls,
    row,
    attendee,
    get,
    check,
    controls,
    close,
  };
}

test("finishing during participant lookup prevents further remote cohost controls", async () => {
  const f = await fixture();
  try {
    const lookup = f.tencent.realtimeParticipants.bind(f.tencent);
    f.tencent.realtimeParticipants = async (...args) => {
      const result = await lookup(...args);
      f.booking.finish(f.row.id, {
        id: 1,
        username: "admin",
        displayName: "Admin",
        role: "system_admin",
        meetingUserType: "ordinary",
      });
      return result;
    };
    await f.check();
    assert.equal(f.controls().length, 0);
    assert.equal(f.get().cohostStatus, "pending");
    assert.equal(
      f.database.db
        .select()
        .from(meetings)
        .where(eq(meetings.id, f.row.id))
        .get()!.status,
      "finished",
    );
  } finally {
    await f.close();
  }
});

test("cohost assignment uses creator UserID even when the pool creator has not joined", async () => {
  const f = await fixture();
  try {
    await f.check();
    assert.equal(f.get().cohostStatus, "applied");
    assert.deepEqual(f.controls()[0]!.body, {
      operator_id: "creator",
      operator_id_type: 1,
      instanceid: 1,
      action: true,
      user: {
        to_operator_id: "live-target",
        to_operator_id_type: 4,
        instanceid: 2,
      },
    });
  } finally {
    await f.close();
  }
});

test("a creator who is not the current host can operate, with its actual device", async () => {
  const f = await fixture();
  try {
    f.state.pages[0]!.push(
      participant({
        userid: "creator",
        ms_open_id: "live-creator",
        instanceid: 4,
        user_role: 1,
      }),
    );
    await f.check();
    assert.equal(f.controls()[0]!.body.instanceid, 4);
    assert.equal(f.get().cohostStatus, "applied");
  } finally {
    await f.close();
  }
});

test("real-time pagination finds invited people on later pages", async () => {
  const f = await fixture();
  try {
    f.state.pages = [
      [participant({ userid: "someone-else" })],
      [participant()],
    ];
    await f.check();
    assert.deepEqual(
      f.calls
        .filter((c) => c.method === "GET")
        .map((c) => c.url.searchParams.get("page")),
      ["1", "2"],
    );
    assert.equal(f.get().cohostStatus, "applied");
    f.state.invalidPage = true;
    await assert.rejects(
      f.tencent.realtimeParticipants("remote", { accountId: "creator" }),
      /INVALID_PAGINATION/,
    );
  } finally {
    await f.close();
  }
});

test("meetings not started and mapped users not in the meeting have explicit waiting reasons", async () => {
  const f = await fixture();
  try {
    f.state.status = "2";
    f.state.pages = [];
    await f.check();
    assert.equal(f.get().cohostStatus, "waiting_meeting");
    assert.match(f.get().cohostError!, /尚未开始/);
    f.state.status = "4";
    // A guest with the same display name is not proof of the bound identity.
    f.state.pages = [[participant({ userid: "", user_name: "Target" })]];
    await f.check();
    assert.equal(f.get().cohostStatus, "waiting_join");
    assert.match(f.get().cohostError!, /绑定账号/);
    assert.equal(f.controls().length, 0);
  } finally {
    await f.close();
  }
});

test("participant query and control failures are visible and recover on the next check", async () => {
  const f = await fixture();
  try {
    f.state.readError = new PlatformError(
      "腾讯会议",
      "9042",
      false,
      400,
      "权限不足",
    );
    await assert.rejects(f.check(), /9042/);
    assert.equal(f.get().cohostStatus, "failed");
    assert.match(f.get().cohostError!, /权限不足/);
    f.state.readError = undefined;
    f.state.writeError = new PlatformError(
      "腾讯会议",
      "202007",
      false,
      400,
      "成员已离会",
    );
    await f.check();
    assert.equal(f.get().cohostStatus, "failed");
    assert.match(f.get().cohostError!, /202007/);
    f.state.writeError = undefined;
    await f.check();
    assert.equal(f.get().cohostStatus, "applied");
    assert.equal(f.get().cohostError, null);
  } finally {
    await f.close();
  }
});

test("already assigned cohosts and current hosts are never demoted or set again", async () => {
  const f = await fixture();
  try {
    f.state.pages = [[participant({ user_role: 6 })]];
    await f.check();
    assert.equal(f.get().cohostStatus, "applied");
    f.state.pages = [[participant({ user_role: 2 })]];
    await f.check();
    assert.equal(f.get().cohostStatus, "host");
    assert.equal(f.controls().length, 0);
    // Rejoining with an ordinary role must retry with the new live identity.
    f.state.pages = [[participant({ ms_open_id: "rejoined", instanceid: 4 })]];
    await f.check();
    assert.equal(f.controls()[0]!.body.user.to_operator_id, "rejoined");
    assert.equal(f.controls()[0]!.body.user.instanceid, 4);
  } finally {
    await f.close();
  }
});

test("multi-device users use a supported live device and missing identities do not silently stall", async () => {
  const f = await fixture();
  try {
    f.state.pages = [
      [
        participant({ instanceid: 10 }),
        participant({ instanceid: 4, ms_open_id: "mobile" }),
      ],
    ];
    await f.check();
    assert.equal(f.controls()[0]!.body.user.to_operator_id, "mobile");
    f.state.pages = [[participant({ ms_open_id: "" })]];
    await f.check();
    assert.equal(f.get().cohostStatus, "failed");
    assert.match(f.get().cohostError!, /未返回会中身份/);
    f.state.pages = [[participant({ instanceid: 10 })]];
    await f.check();
    assert.match(f.get().cohostError!, /不支持该入会设备/);
  } finally {
    await f.close();
  }
});

test("cancelled meetings and meetings with cohosts disabled perform no control calls", async () => {
  const f = await fixture();
  try {
    f.database.db
      .update(meetings)
      .set({ status: "cancelled" })
      .where(eq(meetings.id, f.row.id))
      .run();
    await f.check();
    f.database.db
      .update(meetings)
      .set({ status: "scheduled", cohostEnabled: false })
      .where(eq(meetings.id, f.row.id))
      .run();
    await f.check();
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("live cohosts are checked every fifteen seconds independently of sixty-second maintenance and stop on shutdown", async (t) => {
  const f = await fixture();
  const previous = process.env.AGENDA_LINK_DISABLE_WORKER;
  delete process.env.AGENDA_LINK_DISABLE_WORKER;
  const worker = new WorkerService(
    f.database,
    f.config,
    f.booking,
    {} as CalendarService,
    {} as RecordingService,
    { policy: () => ({ automaticMode: "manual" }) } as SyncService,
    f.connections,
  );
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    f.state.status = "2";
    f.state.pages = [];
    worker.onModuleInit();
    await tick();
    assert.equal(f.get().cohostStatus, "waiting_meeting");
    f.state.status = "4";
    f.state.pages = [[participant()]];
    t.mock.timers.tick(15000);
    await tick();
    await tick();
    assert.equal(f.get().cohostStatus, "applied");
    await worker.onModuleDestroy();
    const before = f.calls.length;
    t.mock.timers.tick(60000);
    await tick();
    assert.equal(f.calls.length, before);
  } finally {
    await worker.onModuleDestroy();
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.AGENDA_LINK_DISABLE_WORKER;
    else process.env.AGENDA_LINK_DISABLE_WORKER = previous;
    await f.close();
  }
});
