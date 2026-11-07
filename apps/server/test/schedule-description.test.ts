import {platformComponents} from "../src/platforms/index.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { AuthService } from "../src/auth.service.js";
import { DatabaseService } from "../src/database.service.js";
import { CalendarService } from "../src/calendar.service.js";
import { MeetingService } from "../src/meeting.service.js";
import { RecordingService } from "../src/recording.service.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import {
  FeishuAdapter,
  eventDescription,
  type EventPayload,
} from "../src/platforms/shared/feishu/client.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { PlatformHttp } from "../src/platforms/shared/http.js";
import {
  calendarEvents,
  calendarTemplates,
  meetingAccounts,
  meetings,
  recordings,
  users,
} from "../src/db/schema.js";

test("aborted historical note reads do not retry the network request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.signal?.aborted, true);
    throw new DOMException("aborted", "AbortError");
  };
  try {
    await assert.rejects(
      () =>
        new PlatformHttp(platformComponents).request(
          "https://open.feishu.cn/open-apis/calendar/v4/test",
          "GET",
          {},
          undefined,
          controller.signal,
        ),
      /NETWORK/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("schedule notes match Feishu, including templates, historical notes and recording backwrites", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-note-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const db = app.get(DatabaseService),
    booking = app.get(MeetingService),
    calendar = app.get(CalendarService),
    feishu = app.get(FeishuAdapter);
  app.get(PlatformConnectionService).update("feishu-calendar", {
    appId: "app",
    appSecret: "secret",
    calendarId: "calendar",
  });
  app.get(PlatformConnectionService).update("tencent-meeting",{appId:"app",sdkId:"sdk",secretId:"key",secretKey:"secret",operatorId:"operator"});
  app.get(PlatformConnectionService).update("feishu-calendar",{appId:"app",appSecret:"secret",calendarId:"calendar"});
  const owner = db.db
    .insert(users)
    .values({ username: "owner", displayName: "预约人" })
    .returning()
    .get();
  const stranger = db.db
    .insert(users)
    .values({ username: "stranger", displayName: "其他人" })
    .returning()
    .get();
  const token = (await app.get(AuthService).issue(owner)).token;
  const server = app.getHttpAdapter().getInstance();
  const account = db.db
    .insert(meetingAccounts)
    .values({ name: "主持人", accountId: "host" })
    .returning()
    .get();
  const template = db.db
    .insert(calendarTemplates)
    .values({
      name: "邀请模板",
      titleTemplate: "{subject}",
      descriptionTemplate: "邀请你参加 {subject}\n腾讯会议号：{meetingCode}",
      extensionsJson: '{"部门":"研发部"}',
    })
    .returning()
    .get();
  const startAt = "2035-10-15T02:00:00Z",
    endAt = "2035-10-15T03:00:00Z";
  const make = (extra: Partial<typeof meetings.$inferInsert> = {}) =>
    db.db
      .insert(meetings)
      .values({
        subject: "项目评审",
        startAt,
        endAt,
        createdBy: owner.id,
        meetingAccountId: account.id,
        externalMeetingId: "meeting-id",
        meetingCode: "123 456 789",
        meetingUrl: "https://meeting.tencent.com/example",
        providerResponseJson: '{"password":"private-value"}',
        calendarId: "calendar",calendarConnectionId:"feishu-calendar",
        ...extra,
      })
      .returning()
      .get();
  let written = "",
    readCount = 0,
    remoteNote: string | undefined = "",
    readError = false,
    failInvite = false,
    failUpdate = false;
  feishu.createEvent = async (p: EventPayload) => {
    written = eventDescription(p);
    return { id: "event", calendarId: "calendar" };
  };
  feishu.updateEvent = async (
    _id: string,
    _calendar: string,
    p: EventPayload,
  ) => {
    if (failUpdate) throw new Error("update failed");
    written = eventDescription(p);
  };
  feishu.invite = async () => {
    if (failInvite) throw new Error("invite failed");
  };
  feishu.replaceAttendees = async () => {};
  feishu.readEventDescription = async () => {
    readCount++;
    if (readError) throw new Error("unavailable");
    return remoteNote;
  };
  try {
    await t.test(
      "booking reminders override templates, including disabling all reminders",
      () => {
        const snapshot = { ...template, remindersJson: "[30,60]" };
        for (const reminders of [undefined, [], [0], [15]]) {
          const row = make({
            calendarTemplateId: template.id,
            extensionsJson: JSON.stringify({
              calendarTemplateSnapshot: snapshot,
              reminders,
            }),
          });
          assert.deepEqual(
            booking.eventPayload(row).reminders,
            reminders ?? [30, 60],
          );
        }
      },
    );
    await t.test(
      "a booking without a template does not force a reminder",
      () => {
        const row = make({
          calendarTemplateId: null,
          extensionsJson: "{}",
        });
        assert.equal(booking.eventPayload(row).reminders, undefined);
      },
    );
    await t.test(
      "empty raw input renders the template and custom fields and preserves the sent snapshot",
      async () => {
        const row = make({
          calendarTemplateId: template.id,
          extensionsJson: JSON.stringify({
            calendarTemplateSnapshot: template,
            extensions: { 项目: "协同工具" },
          }),
        });
        await booking.provision(row.id);
        const detail = await booking.calendarDetail(row.id, owner);
        assert.equal(detail.description, null);
        assert.equal(detail.calendarDescription, written);
        assert.match(written, /邀请你参加 项目评审/);
        assert.match(written, /会议号：123 456 789/);
        assert.match(
          written,
          /加入腾讯会议：https:\/\/meeting.tencent.com\/example/,
        );
        assert.match(written, /部门: 研发部\n项目: 协同工具/);
        assert.equal(readCount, 0);
        assert.equal("providerResponseJson" in detail, false);
        assert.equal(JSON.stringify(detail).includes("private-value"), false);
        assert.equal("calendarDescriptionText" in booking.list(owner)[0]!, false);
        db.db
          .update(calendarTemplates)
          .set({ descriptionTemplate: "后续修改的模板" })
          .where(eq(calendarTemplates.id, template.id))
          .run();
        assert.equal(
          booking.detail(row.id, owner).calendarDescription,
          written,
        );
      },
    );
    await t.test(
      "old Feishu notes are recovered once and an intentionally empty note stays empty",
      async () => {
        for (const note of [
          "飞书中的原始邀请\n\n会议号：123 456 789\n附加内容",
          "",
        ]) {
          const row = make({ calendarEventId: "old-event" });
          remoteNote = note;
          const before = readCount;
          const detail = await booking.calendarDetail(row.id, owner);
          assert.equal(detail.calendarDescription, note);
          assert.equal(
            (await booking.calendarDetail(row.id, owner)).calendarDescription,
            note,
          );
          assert.equal(readCount, before + 1);
          assert.equal(
            db.db.select().from(meetings).where(eq(meetings.id, row.id)).get()!
              .calendarDescriptionText,
            note,
          );
        }
      },
    );
    await t.test(
      "details enforce visibility before reading Feishu and require API login",
      async () => {
        const row = make({ calendarEventId: "private-event" });
        const before = readCount;
        await assert.rejects(
          () => booking.calendarDetail(row.id, stranger),
          /只能管理自己的会议/,
        );
        assert.equal(readCount, before);
        assert.equal(
          (
            await server.inject({
              method: "GET",
              url: `/api/meetings/${row.id}`,
            })
          ).statusCode,
          401,
        );
      },
    );
    await t.test(
      "Feishu failure falls back to the booking template without permanently saving the fallback",
      async () => {
        const row = make({
          calendarEventId: "legacy",
          calendarTemplateId: template.id,
          extensionsJson: JSON.stringify({
            calendarTemplateSnapshot: template,
          }),
        });
        readError = true;
        assert.match(
          (await booking.calendarDetail(row.id, owner)).calendarDescription,
          /邀请你参加 项目评审/,
        );
        assert.equal(
          db.db.select().from(meetings).where(eq(meetings.id, row.id)).get()!
            .calendarDescriptionText,
          null,
        );
        readError = false;
        remoteNote = "恢复后的飞书说明";
        assert.equal(
          (await booking.calendarDetail(row.id, owner)).calendarDescription,
          remoteNote,
        );
      },
    );
    await t.test(
      "an invitation failure still exposes the note successfully written to Feishu",
      async () => {
        const row = make({ description: "手动说明" });
        failInvite = true;
        await assert.rejects(() => booking.provision(row.id), /invite failed/);
        failInvite = false;
        assert.equal(
          booking.detail(row.id, owner).calendarDescription,
          written,
        );
      },
    );
    await t.test(
      "personal schedules keep raw editable text separate from the exact sent note",
      async () => {
        const row = calendar.create(
          {
            subject: "个人日程",
            description: "日程正文\n第二行",
            startAt,
            endAt,
            extensions: { 地点说明: "线上参加" },
          },
          "personal-calendar-request-000000000001",
          owner,
        );
        await calendar.provision(row.id);
        const response = await server.inject({
          method: "GET",
          url: `/api/calendar-events/${row.id}`,
          headers: { authorization: "Bearer " + token },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().description, "日程正文\n第二行");
        assert.equal(response.json().calendarDescription, written);
        assert.match(written, /地点说明: 线上参加/);
        await assert.rejects(
          () => calendar.detail(row.id, stranger),
          /只能维护自己的日程/,
        );
        calendar.update(
          row.id,
          {
            subject: "个人日程",
            description: "修改正文",
            startAt,
            endAt,
            extensions: { 地点说明: "会议室" },
          },
          owner,
        );
        failUpdate = true;
        await assert.rejects(() => calendar.provision(row.id), /update failed/);
        assert.equal(
          (await calendar.detail(row.id, owner)).calendarDescription,
          written,
        );
        failUpdate = false;
        await calendar.provision(row.id);
        assert.equal(
          (await calendar.detail(row.id, owner)).calendarDescription,
          "修改正文\n\n地点说明: 会议室",
        );
        // Older personal schedules recover the remote description too.
        db.db
          .update(calendarEvents)
          .set({ calendarDescriptionText: null })
          .where(eq(calendarEvents.id, row.id))
          .run();
        remoteNote = "旧日程的飞书原文";
        assert.equal(
          (await calendar.detail(row.id, owner)).calendarDescription,
          remoteNote,
        );
      },
    );
    await t.test(
      "cloud recording backwrite updates the same description snapshot",
      async () => {
        const row = make({
          status: "finished",
          startAt: new Date(Date.now() - 7200000).toISOString(),
          endAt: new Date(Date.now() - 3600000).toISOString(),
          recordingEnabled: true,
          calendarEventId: "recorded-event",
          description: "会议邀请",
          calendarDescriptionText: "旧说明",
        });
        const recording = db.db
          .insert(recordings)
          .values({ meetingId: row.id })
          .returning()
          .get();
        app.get(TencentAdapter).recordingFiles = async () => [
          {
            id: "file",
            extension: "mp4",
            viewUrl: "https://meeting.tencent.com/cloud-playback",
          },
        ];
        await app.get(RecordingService).poll(recording);
        const detail = booking.detail(row.id, owner);
        assert.ok(written.includes(`/calendar?meeting=${row.id}`));
        assert.equal(detail.calendarDescription, written);
        assert.match(detail.calendarDescription, /会议号：123 456 789/);
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.AGENDA_LINK_WORKSPACE;
  }
});
