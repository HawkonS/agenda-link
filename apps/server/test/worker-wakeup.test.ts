import {PlatformConnectionService} from "../src/platform-connection.service.js";
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
import { CalendarService } from "../src/calendar.service.js";
import { WorkerService } from "../src/worker.service.js";
import { calendarEvents, jobs, users } from "../src/db/schema.js";
import type { SessionUser } from "../src/auth.service.js";
import type { MeetingService } from "../src/meeting.service.js";
import type { RecordingService } from "../src/recording.service.js";
import type { SyncService } from "../src/sync.service.js";
import type { PlatformConnectionService } from "../src/platform-connection.service.js";
import { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import { PlatformError } from "../src/platforms/shared/http.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Worker did not wake within two seconds");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const previous = {
    workspace: process.env.AGENDA_LINK_WORKSPACE,
    disabled: process.env.AGENDA_LINK_DISABLE_WORKER,
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-worker-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  delete process.env.AGENDA_LINK_DISABLE_WORKER;
  const config = new ConfigurationService();
  const database = new DatabaseService(config);
  const connections=new PlatformConnectionService(config,database);
  connections.update("feishu-calendar",{appId:"app",appSecret:"secret",calendarId:"calendar"});
  const row = database.db
    .insert(users)
    .values({ username: "owner", displayName: "Owner", feishuUserId: "owner" })
    .returning()
    .get();
  const user: SessionUser = {
    ...row,
    role: "user",
    meetingUserType: "ordinary",
  };
  let creates = 0,
    deletes = 0;
  const feishu = {
    calendarId: "calendar",
    createEvent: async () => ({ id: "event-" + ++creates }),
    updateEvent: async () => {},
    replaceAttendees: async () => {},
    deleteEvent: async () => {
      deletes++;
    },
  } as unknown as FeishuAdapter;
  const calendar = new CalendarService(database,registryFixture(config,database,connections,undefined,feishu));
  const trace: string[] = [];
  const booking = {
    provision: async (id: number) => {
      trace.push("create:" + id);
    },
    performCancel: async (id: number) => {
      trace.push("cancel:" + id);
    },
  } as unknown as MeetingService;
  const sync = {
    policy: () => ({ automaticMode: "manual" }),
    run: async () => {
      trace.push("sync");
    },
  } as unknown as SyncService;
  const worker = new WorkerService(
    database,
    config,
    booking,
    calendar,
    {} as RecordingService,
    sync,
    { isConfigured: () => false } as unknown as PlatformConnectionService,
  );
  worker.onModuleInit();
  await tick();
  let key = 0;
  const create = () =>
    calendar.create(
      {
        subject: "Test",
        startAt: "2035-01-01T01:00:00.000Z",
        endAt: "2035-01-01T02:00:00.000Z",
      },
      "worker-calendar-request-" + String(++key).padStart(12, "0"),
      user,
    );
  const event = (id: number) =>
    database.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .get()!;
  const enqueue = (
    type: string,
    id: number,
    runAt = new Date().toISOString(),
  ) => {
    const row = database.db
      .insert(jobs)
      .values({ type, payloadJson: JSON.stringify({ id }), runAt })
      .returning()
      .get();
    database.notifyJobs();
    return row;
  };
  const close = async () => {
    await worker.onModuleDestroy();
    database.onModuleDestroy();
    if (previous.workspace === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous.workspace;
    if (previous.disabled === undefined)
      delete process.env.AGENDA_LINK_DISABLE_WORKER;
    else process.env.AGENDA_LINK_DISABLE_WORKER = previous.disabled;
    await rm(root, { recursive: true, force: true });
  };
  return {
    database,
    worker,
    calendar,
    user,
    feishu,
    create,
    event,
    enqueue,
    close,
    trace,
    counts: () => ({ creates, deletes }),
  };
}

test("calendar creation, updates and cancellation wake immediately with a 60-second maintenance interval", async () => {
  const f = await fixture();
  try {
    const row = f.create();
    assert.equal(f.event(row.id).status, "pending");
    assert.equal(
      f.counts().creates,
      0,
      "remote work must start after the transaction commits",
    );
    await until(() => f.event(row.id).status === "synced");
    assert.equal(f.counts().creates, 1);
    let updates = 0;
    f.feishu.updateEvent = async () => {
      updates++;
    };
    f.calendar.update(
      row.id,
      { subject: "Edited", startAt: row.startAt, endAt: row.endAt },
      f.user,
    );
    await until(() => f.event(row.id).status === "synced");
    assert.equal(updates, 1);
    for (let i = 0; i < 5; i++) f.calendar.cancel(row.id, f.user);
    await until(() => f.event(row.id).status === "cancelled");
    assert.equal(
      f.counts().deletes,
      1,
      "repeated clicks must not duplicate cancellation",
    );
  } finally {
    await f.close();
  }
});

test("work enqueued while a platform call is pending is drained without a lost wake or overlapping calls", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    active = 0,
    peak = 0;
  f.feishu.createEvent = async () => {
    calls++;
    peak = Math.max(peak, ++active);
    if (calls === 1) await gate;
    active--;
    return { id: "event-" + calls, calendarId: "calendar" };
  };
  try {
    const first = f.create();
    await until(() => calls === 1);
    const second = f.create();
    await f.worker.runOnce();
    assert.equal(calls, 1);
    release();
    await until(() =>
      [first, second].every((row) => f.event(row.id).status === "synced"),
    );
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally {
    release();
    await f.close();
  }
});

test("due work drains across batches and cancellations precede queued creates and sync", async () => {
  const f = await fixture();
  try {
    f.enqueue("sync", 1);
    for (let id = 1; id <= 24; id++) f.enqueue("meeting.provision", id);
    f.enqueue("meeting.cancel", 99);
    await until(() =>
      f.database.db
        .select()
        .from(jobs)
        .all()
        .every((job) => job.status === "success"),
    );
    assert.equal(f.trace[0], "cancel:99");
    assert.equal(f.trace.at(-1), "sync");
    assert.equal(new Set(f.trace).size, 26);
    assert.ok(
      f.database.db
        .select()
        .from(jobs)
        .all()
        .every((job) => job.attempts === 1),
    );
  } finally {
    await f.close();
  }
});

test("delayed work wakes at its deadline without running early", async () => {
  const f = await fixture();
  try {
    const dueAt = Date.now() + 150;
    const job = f.enqueue(
      "meeting.provision",
      42,
      new Date(dueAt).toISOString(),
    );
    await tick();
    assert.deepEqual(f.trace, []);
    await until(() => f.trace.length === 1);
    assert.ok(Date.now() >= dueAt);
    assert.equal(
      f.database.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!
        .status,
      "success",
    );
  } finally {
    await f.close();
  }
});

test("failed platform work keeps its backoff and manual retry wakes the existing job", async () => {
  const f = await fixture();
  let calls = 0;
  f.feishu.createEvent = async () => {
    if (++calls === 1) throw new PlatformError("飞书", "TEMPORARY");
    return { id: "recovered", calendarId: "calendar" };
  };
  try {
    const row = f.create();
    await until(() => f.event(row.id).status === "failed");
    const job = f.database.db.select().from(jobs).get()!;
    assert.equal(job.status, "queued");
    assert.ok(Date.parse(job.runAt) > Date.now() + 25000);
    f.database.notifyJobs();
    await tick();
    assert.equal(calls, 1, "a wake must not bypass retry backoff");
    f.calendar.retry(row.id, f.user);
    await until(() => f.event(row.id).status === "synced");
    assert.equal(calls, 2);
    assert.equal(f.database.db.select().from(jobs).all().length, 1);
  } finally {
    await f.close();
  }
});

test("shutdown cancels scheduled wakes and stops listening for new work", async () => {
  const f = await fixture();
  try {
    f.enqueue("meeting.provision", 42, new Date(Date.now() + 50).toISOString());
    await tick();
    await f.worker.onModuleDestroy();
    f.enqueue("meeting.provision", 43);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(f.trace, []);
    assert.ok(
      f.database.db
        .select()
        .from(jobs)
        .all()
        .every((job) => job.status === "queued"),
    );
  } finally {
    await f.close();
  }
});
