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
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { MeetingService } from "../src/meeting.service.js";
import type { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import type { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import {
  platformIdentities,
  users,
  meetingAccounts,
  accountPools,
  accountPoolMembers,
  meetings,
  meetingAttendees,
  jobs,
  recordings,
  auditLogs,
} from "../src/db/schema.js";

async function fixture() {
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-host-"));
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
  connections.update("feishu-calendar",{appId:"calendar-app",appSecret:"secret",calendarId:"calendar"});
  const booking = new MeetingService(
    db,
    config,
    registryFixture(config,db,connections,{} as TencentAdapter,{calendarId:"calendar"} as FeishuAdapter),
    connections,
  );
  const person = (name:string,advanced=true) => {
    const row=db.db.insert(users).values({username:name,displayName:name,feishuLoginOpenId:"login-"+name}).returning().get();
    db.db.insert(platformIdentities).values({providerId:"tencent",connectionId:"tencent-meeting",kind:"person",externalId:name,userId:row.id,name,profileJson:JSON.stringify({providerData:{advanced}})}).run();
    return row;
  };
  const account = (name: string) =>
    db.db
      .insert(meetingAccounts)
      .values({
        name,
        accountId: name,
        verifiedAt: new Date().toISOString(),
        secretId: "private-key",
        secretKey: "encrypted-private-secret",
      })
      .returning()
      .get();
  const owner = person("本人"),
    first = person("受邀甲"),
    second = person("受邀乙"),
    ordinary = person("普通参会人", false);
  const ownAccount = account(owner.username),
    firstAccount = account(first.username),
    secondAccount = account(second.username),
    shared = account("共享主持人");
  const pool = db.db
    .insert(accountPools)
    .values({ name: "研发账号池", isDefault: true })
    .returning()
    .get();
  db.db
    .insert(accountPoolMembers)
    .values({ poolId: pool.id, accountId: shared.id })
    .run();
  const input = {
    subject: "预约测试",
    startAt: "2035-02-01T00:00:00Z",
    endAt: "2035-02-01T01:00:00Z",
    attendeeIds: [first.id, second.id],
  };
  const session = {
    id: owner.id,
    username: owner.username,
    displayName: owner.displayName,
    role: owner.role,
    meetingUserType: owner.meetingUserType,
  };
  return {
    db,
    booking,
    owner,
    first,
    second,
    ordinary,
    ownAccount,
    firstAccount,
    secondAccount,
    shared,
    pool,
    input,
    session,
    async close() {
      db.onModuleDestroy();
      if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
      else process.env.AGENDA_LINK_WORKSPACE = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function allocationTest(
  name: string,
  run: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>,
) {
  test(name, async () => {
    const f = await fixture();
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
}

allocationTest(
  "finishing releases the host immediately while preserving bookings, recordings and job history",
  async (f) => {
    const input = { ...f.input, hostMode: "person", hostUserId: f.owner.id };
    const reserved = f.booking.reserve(
      input,
      "finish-local-only".padEnd(32, "0"),
      f.session,
    );
    f.db.db
      .update(meetings)
      .set({
        status: "scheduled",
        externalMeetingId: "remote-meeting",
        calendarEventId: "remote-event",
        calendarDescriptionText: "原预约说明",
        meetingUrl: "https://meeting.tencent.com/original",
        provisionStep: "complete",
      })
      .where(eq(meetings.id, reserved.id))
      .run();
    f.db.db.update(jobs).set({ status: "success" }).run();
    f.db.db
      .insert(recordings)
      .values({
        meetingId: reserved.id,
        status: "ready",
        remoteUrl: "https://meeting.tencent.com/recording",
        expiresAt: "2035-03-01T01:00:00Z",
      })
      .run();
    const before = f.db.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, reserved.id))
      .get()!;
    const savedJobs = f.db.db.select().from(jobs).all();
    const savedRecordings = f.db.db.select().from(recordings).all();
    assert.equal(f.booking.previewHost(input, f.session).available, false);

    assert.deepEqual(f.booking.finish(reserved.id, f.session), { ok: true });
    const finished = f.db.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, reserved.id))
      .get()!;
    assert.deepEqual(finished, {
      ...before,
      status: "finished",
      updatedAt: finished.updatedAt,
    });
    assert.deepEqual(f.db.db.select().from(jobs).all(), savedJobs);
    assert.deepEqual(f.db.db.select().from(recordings).all(), savedRecordings);
    assert.equal(f.booking.previewHost(input, f.session).available, true);

    // Finished meetings must not be provisioned or cancelled by stale tasks.
    // The fixture has no remote adapter methods, so any remote call would fail.
    await f.booking.provision(reserved.id);
    await f.booking.performCancel(reserved.id);
    await f.booking.cohosts(finished);
    assert.equal(f.booking.detail(reserved.id, f.session).status, "finished");
    assert.deepEqual(f.booking.finish(reserved.id, f.session), { ok: true });
    const logs = f.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "meeting.finished"))
      .all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.actorId, String(f.owner.id));
    const next = f.booking.reserve(
      input,
      "reuse-finished-host".padEnd(32, "0"),
      f.session,
    );
    assert.equal(next.meetingAccountId, f.ownAccount.id);
  },
);

allocationTest(
  "only the creator or an administrator can finish a meeting, including repeated requests",
  (f) => {
    const row = f.booking.reserve(
      f.input,
      "finish-permissions".padEnd(32, "0"),
      f.session,
    );
    f.db.db
      .update(meetings)
      .set({ status: "scheduled" })
      .where(eq(meetings.id, row.id))
      .run();
    f.db.db.update(jobs).set({ status: "success" }).run();
    for (const id of [f.first.id, f.ordinary.id]) {
      assert.throws(
        () => f.booking.finish(row.id, { ...f.session, id }),
        /只能管理自己的会议/,
      );
    }
    for (const role of ["operation_admin", "system_admin"] as const) {
      f.db.db
        .update(meetings)
        .set({ status: "scheduled" })
        .where(eq(meetings.id, row.id))
        .run();
      assert.deepEqual(
        f.booking.finish(row.id, { ...f.session, id: f.first.id, role }),
        { ok: true },
      );
    }
    assert.throws(
      () => f.booking.finish(row.id, { ...f.session, id: f.first.id }),
      /只能管理自己的会议/,
    );
    f.db.db
      .update(meetings)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(meetings.id, row.id))
      .run();
    assert.throws(() => f.booking.finish(row.id, f.session), /会议不存在/);
    assert.throws(() => f.booking.finish(999999, f.session), /会议不存在/);
  },
);

allocationTest(
  "unfinished provisioning, uncertain results and cancellation cannot be bypassed by finishing",
  (f) => {
    const row = f.booking.reserve(
      f.input,
      "finish-state-guards".padEnd(32, "0"),
      f.session,
    );
    for (const status of [
      "provisioning",
      "unknown",
      "failed",
      "cancelling",
      "cancel_failed",
      "cancelled",
    ] as const) {
      f.db.db
        .update(meetings)
        .set({ status })
        .where(eq(meetings.id, row.id))
        .run();
      assert.throws(
        () => f.booking.finish(row.id, f.session),
        /仅已预约的会议可以结束/,
      );
      assert.equal(f.booking.detail(row.id, f.session).status, status);
    }
    f.db.db
      .update(meetings)
      .set({ status: "scheduled" })
      .where(eq(meetings.id, row.id))
      .run();
    for (const type of ["meeting.provision", "meeting.cancel"]) {
      for (const status of ["queued", "running"] as const) {
        f.db.db.update(jobs).set({ type, status }).run();
        assert.throws(
          () => f.booking.finish(row.id, f.session),
          /会议任务尚未结束/,
        );
        assert.equal(f.booking.detail(row.id, f.session).status, "scheduled");
      }
    }
  },
);

allocationTest(
  "the logged-in mapped advanced host wins; previews neither reserve nor expose credentials",
  (f) => {
    const preview = f.booking.previewHost(f.input, f.session);
    assert.equal(preview.available, true);
    if (!preview.available) throw new Error("No host");
    assert.equal(preview.meetingAccountId, f.ownAccount.id);
    assert.equal(preview.hostAccountName, "本人");
    assert.equal(preview.allocationSource, "personal");
    assert.equal(f.db.db.select().from(meetings).all().length, 0);
    assert.equal(f.db.db.select().from(jobs).all().length, 0);
    for (const secret of [
      "private-key",
      "encrypted-private-secret",
      "secretKey",
      "secretId",
    ])
      assert.ok(!JSON.stringify(preview).includes(secret));
    const row = f.booking.reserve(
      f.input,
      "owner-request".padEnd(32, "0"),
      f.session,
    );
    assert.equal(row.meetingAccountId, preview.meetingAccountId);
    assert.equal(row.allocationSource, "personal");
  },
);

allocationTest(
  "requesters without a Tencent identity can attend using a pool host without pending cohost work",
  (f) => {
    f.db.db
      .update(users)
      .set({
        feishuUserId: "feishu-self",
      })
      .where(eq(users.id, f.owner.id))
      .run();
    f.db.db.delete(platformIdentities).where(eq(platformIdentities.userId,f.owner.id)).run();
    f.db.db.insert(platformIdentities).values({providerId:"feishu",connectionId:"feishu-calendar",externalId:"open-self",stableId:"feishu-self",userId:f.owner.id,name:"本人"}).run();
    const input = { ...f.input, attendeeIds: [f.owner.id] };
    const preview = f.booking.previewHost(input, f.session);
    assert.equal(
      preview.available && preview.hostAccountId,
      f.shared.accountId,
    );
    const row = f.booking.reserve(
      input,
      "self-without-tencent".padEnd(32, "0"),
      f.session,
    );
    assert.equal(row.meetingAccountId, f.shared.id);
    const attendee = f.db.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, row.id))
      .get()!;
    assert.equal(attendee.userId, f.owner.id);
    assert.equal(attendee.isCohost, false);
    assert.equal(attendee.cohostStatus, "not_applicable");
    assert.ok(
      f.booking
        .eventPayload(
          f.db.db.select().from(meetings).where(eq(meetings.id, row.id)).get()!,
        )
        .attendees.some((a) => a.userId === "feishu-self"),
    );
    f.db.db
      .delete(platformIdentities)
      .where(eq(platformIdentities.userId, f.ordinary.id))
      .run();
    const invalid = { ...f.input, attendeeIds: [f.owner.id, f.ordinary.id] };
    assert.throws(() => f.booking.previewHost(invalid, f.session), /参会人员/);
    assert.throws(
      () =>
        f.booking.reserve(invalid, "unmapped-other".padEnd(32, "0"), f.session),
      /参会人员/,
    );
    f.db.db
      .update(users)
      .set({ status: "disabled" })
      .where(eq(users.id, f.owner.id))
      .run();
    assert.throws(() => f.booking.previewHost(input, f.session), /参会人员/);
  },
);

allocationTest(
  "ordinary requesters use the first eligible invitee, independently of pool membership and stale sessions",
  (f) => {
    f.db.db
      .update(platformIdentities)
      .set({profileJson:JSON.stringify({providerData:{advanced:false}})})
      .where(eq(platformIdentities.userId, f.owner.id))
      .run();
    const input = {
      ...f.input,
      attendeeIds: [f.second.id, f.first.id, f.second.id],
    };
    const preview = f.booking.previewHost(input, f.session);
    assert.equal(preview.available && preview.hostAccountName, "受邀乙");
    const row = f.booking.reserve(
      input,
      "invitee-request".padEnd(32, "0"),
      f.session,
    );
    assert.equal(row.meetingAccountId, f.secondAccount.id);
    assert.equal(row.allocationSource, "invitee");
    assert.equal(row.accountPoolId, null);
    assert.equal(
      f.booking.list(f.session)[0].hostAccountName,
      f.secondAccount.name,
    );
    assert.equal(
      f.booking.detail(row.id, f.session).hostAccountId,
      f.second.username,
    );
  },
);

allocationTest(
  "overlapping reservations recheck availability and fall through owner, invitees, then the named pool",
  (f) => {
    for (const [index, id] of [
      f.ownAccount.id,
      f.firstAccount.id,
      f.secondAccount.id,
      f.shared.id,
    ].entries()) {
      const preview = f.booking.previewHost(f.input, f.session);
      assert.equal(preview.available && preview.meetingAccountId, id);
      const row = f.booking.reserve(
        f.input,
        ("concurrent-" + index).padEnd(32, "0"),
        f.session,
      );
      assert.equal(row.meetingAccountId, id);
      if (id === f.shared.id) {
        assert.equal(row.allocationSource, "pool");
        assert.equal(preview.available && preview.accountPoolName, f.pool.name);
        assert.equal(
          f.booking.detail(row.id, f.session).accountPoolName,
          f.pool.name,
        );
      }
    }
    assert.equal(f.booking.previewHost(f.input, f.session).available, false);
    assert.throws(
      () => f.booking.reserve(f.input, "exhausted".padEnd(32, "0"), f.session),
      /空闲高级账号/,
    );
    // Adjacent appointments can reuse the owner's account.
    assert.equal(
      f.booking.previewHost(
        { ...f.input, startAt: f.input.endAt, endAt: "2035-02-01T02:00:00Z" },
        f.session,
      ).available,
      true,
    );
  },
);

allocationTest(
  "disabled, unverified and ordinary invitees cannot be used as hosts",
  (f) => {
    f.db.db
      .update(meetingAccounts)
      .set({ status: "disabled" })
      .where(eq(meetingAccounts.id, f.ownAccount.id))
      .run();
    f.db.db
      .update(meetingAccounts)
      .set({ verifiedAt: null })
      .where(eq(meetingAccounts.id, f.firstAccount.id))
      .run();
    f.db.db
      .update(platformIdentities)
      .set({profileJson:JSON.stringify({providerData:{advanced:false}})})
      .where(eq(platformIdentities.userId, f.second.id))
      .run();
    const preview = f.booking.previewHost(
      {
        ...f.input,
        attendeeIds: [f.owner.id, f.first.id, f.second.id, f.ordinary.id],
      },
      f.session,
    );
    assert.equal(
      preview.available && preview.hostAccountId,
      f.shared.accountId,
    );
    assert.equal(preview.available && preview.accountPoolName, f.pool.name);
    for (const attendeeIds of [[999999], [f.ordinary.id]]) {
      if (attendeeIds[0] === f.ordinary.id)
        f.db.db
          .update(users)
          .set({ status: "disabled" })
          .where(eq(users.id, f.ordinary.id))
          .run();
      assert.throws(
        () => f.booking.previewHost({ ...f.input, attendeeIds }, f.session),
        /参会人员/,
      );
    }
  },
);

allocationTest(
  "explicit pool selection is respected and automatic selection prefers the default pool",
  (f) => {
    const otherAccount = f.db.db
      .insert(meetingAccounts)
      .values({
        name: "其他主持人",
        accountId: "other",
        verifiedAt: new Date().toISOString(),
      })
      .returning()
      .get();
    const otherPool = f.db.db
      .insert(accountPools)
      .values({ name: "其他账号池" })
      .returning()
      .get();
    f.db.db
      .insert(accountPoolMembers)
      .values({ poolId: otherPool.id, accountId: otherAccount.id })
      .run();
    f.db.db
      .update(platformIdentities)
      .set({profileJson:JSON.stringify({providerData:{advanced:false}})})
      .where(eq(platformIdentities.userId, f.owner.id))
      .run();
    const input = { ...f.input, attendeeIds: [] };
    assert.equal(
      f.booking.previewHost(input, f.session).available &&
        (f.booking.previewHost(input, f.session) as any).accountPoolName,
      f.pool.name,
    );
    const preview = f.booking.previewHost(
      { ...input, accountPoolId: otherPool.id },
      f.session,
    );
    assert.equal(preview.available && preview.accountPoolName, otherPool.name);
    f.db.db
      .update(accountPools)
      .set({ enabled: false })
      .where(eq(accountPools.id, otherPool.id))
      .run();
    assert.equal(
      f.booking.previewHost(
        { ...input, accountPoolId: otherPool.id },
        f.session,
      ).available,
      false,
    );
  },
);

allocationTest(
  "unconfirmed cancellation failures keep hosts occupied while cancelled meetings release them",
  (f) => {
    const row = f.booking.reserve(
      f.input,
      "cancel-state".padEnd(32, "0"),
      f.session,
    );
    f.db.db
      .update(meetings)
      .set({ status: "cancel_failed" })
      .where(eq(meetings.id, row.id))
      .run();
    assert.equal(
      (f.booking.previewHost(f.input, f.session) as any).meetingAccountId,
      f.firstAccount.id,
    );
    f.db.db
      .update(meetings)
      .set({ status: "cancelled" })
      .where(eq(meetings.id, row.id))
      .run();
    assert.equal(
      (f.booking.previewHost(f.input, f.session) as any).meetingAccountId,
      f.ownAccount.id,
    );
  },
);

allocationTest(
  "a selected invitee overrides an available personal account and stays fixed through reservation",
  (f) => {
    const input = { ...f.input, hostMode: "person", hostUserId: f.second.id };
    const preview = f.booking.previewHost(input, f.session);
    assert.equal(
      preview.available && preview.meetingAccountId,
      f.secondAccount.id,
    );
    const key = "manual-person-choice".padEnd(32, "0");
    const row = f.booking.reserve(input, key, f.session);
    assert.equal(row.meetingAccountId, f.secondAccount.id);
    assert.equal(row.allocationSource, "invitee");
    const host = f.db.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, row.id))
      .all()
      .find((p) => p.userId === f.second.id)!;
    assert.equal(host.cohostStatus, "host");
    assert.equal(host.isCohost, false);
    assert.equal(f.booking.reserve(input, key, f.session).id, row.id);
    assert.throws(
      () =>
        f.booking.reserve({ ...input, hostUserId: f.first.id }, key, f.session),
      /幂等键/,
    );
    const unavailable = f.booking.previewHost(input, f.session);
    assert.equal(unavailable.available, false);
    assert.match(
      (!unavailable.available && unavailable.reason) || "",
      /所选主持账号/,
    );
    assert.throws(
      () =>
        f.booking.reserve(
          input,
          "manual-person-conflict".padEnd(32, "0"),
          f.session,
        ),
      /所选主持账号/,
    );
    // A failed explicit reservation cannot consume a different person's account.
    assert.equal(f.db.db.select().from(meetings).all().length, 1);
    assert.equal(
      f.booking.previewHost({ ...input, hostUserId: f.first.id }, f.session)
        .available,
      true,
    );
  },
);

allocationTest(
  "pool mode bypasses every eligible person and honors the selected pool",
  (f) => {
    const input = { ...f.input, hostMode: "pool", accountPoolId: f.pool.id };
    const preview = f.booking.previewHost(input, f.session);
    assert.equal(preview.available && preview.meetingAccountId, f.shared.id);
    const row = f.booking.reserve(
      input,
      "forced-pool-choice".padEnd(32, "0"),
      f.session,
    );
    assert.equal(row.meetingAccountId, f.shared.id);
    assert.equal(row.accountPoolId, f.pool.id);
    assert.equal(row.allocationSource, "pool");
    assert.equal(f.booking.previewHost(input, f.session).available, false);
    assert.equal(f.booking.previewHost(f.input, f.session).available, true);
  },
);

allocationTest(
  "person mode rejects uninvited, ordinary, disabled and unverified users",
  (f) => {
    for (const hostUserId of [999999, f.ordinary.id])
      assert.throws(
        () =>
          f.booking.previewHost(
            { ...f.input, hostMode: "person", hostUserId },
            f.session,
          ),
        /只能选择/,
      );
    const ordinary = f.booking.previewHost(
      {
        ...f.input,
        attendeeIds: [f.ordinary.id],
        hostMode: "person",
        hostUserId: f.ordinary.id,
      },
      f.session,
    );
    assert.equal(ordinary.available, false);
    f.db.db
      .update(meetingAccounts)
      .set({ verifiedAt: null })
      .where(eq(meetingAccounts.id, f.firstAccount.id))
      .run();
    assert.equal(
      f.booking.previewHost(
        { ...f.input, hostMode: "person", hostUserId: f.first.id },
        f.session,
      ).available,
      false,
    );
    f.db.db
      .update(meetingAccounts)
      .set({ status: "disabled" })
      .where(eq(meetingAccounts.id, f.secondAccount.id))
      .run();
    assert.equal(
      f.booking.previewHost(
        { ...f.input, hostMode: "person", hostUserId: f.second.id },
        f.session,
      ).available,
      false,
    );
    for (const preference of [
      { hostMode: "person" },
      { hostMode: "pool", hostUserId: f.owner.id },
      { hostMode: "auto", hostUserId: f.owner.id },
      { hostUserId: f.owner.id },
      { hostMode: "invalid" },
      { hostMode: "person", hostUserId: "1 OR 1=1" },
    ]) {
      assert.throws(() =>
        f.booking.previewHost({ ...f.input, ...preference }, f.session),
      );
      assert.throws(() =>
        f.booking.reserve(
          { ...f.input, ...preference },
          "invalid-host-preference".padEnd(32, "0"),
          f.session,
        ),
      );
    }
    const self = f.booking.previewHost(
      {
        ...f.input,
        attendeeIds: [],
        hostMode: "person",
        hostUserId: f.owner.id,
      },
      f.session,
    );
    assert.equal(self.available && self.meetingAccountId, f.ownAccount.id);
  },
);
