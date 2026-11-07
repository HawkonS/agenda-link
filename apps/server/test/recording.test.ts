import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../src/database.service.js";
import { AuthService } from "../src/auth.service.js";
import { RecordingService } from "../src/recording.service.js";
import { WorkerService } from "../src/worker.service.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { PlatformHttp, PlatformError } from "../src/platforms/shared/http.js";
import {
  users,
  meetings,
  recordings,
  meetingAccounts,
  meetingAttendees,
  jobs,
} from "../src/db/schema.js";

test("Tencent cloud recordings: API contract, playback, permissions and deletion recovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-recording-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const db = app.get(DatabaseService),
    service = app.get(RecordingService),
    worker = app.get(WorkerService);
  const tencent = app.get(TencentAdapter),
    server = app.getHttpAdapter().getInstance(),
    auth = app.get(AuthService);
  app.get(PlatformConnectionService).update("tencent-meeting", {
    appId: "app",
    sdkId: "sdk",
    secretId: "key",
    secretKey: "secret",
    operatorId: "admin",
  });
  const people = {} as Record<string, any>;
  for (const [username, role] of [
    ["admin", "system_admin"],
    ["operator", "operation_admin"],
    ["owner", "user"],
    ["stranger", "user"],
    ["guest", "user"],
  ] as const) {
    const row = db.db
      .insert(users)
      .values({ username, displayName: username, role })
      .returning()
      .get();
    const session = await auth.issue(row);
    people[username] = {
      user: { ...row, avatarUrl: null },
      token: session.token,
    };
  }
  const request = (name: string, method: string, url: string) =>
    server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${people[name].token}` },
    });
  const account = db.db
    .insert(meetingAccounts)
    .values({ name: "Host", accountId: "host" })
    .returning()
    .get();
  const meeting = db.db
    .insert(meetings)
    .values({
      subject: "Cloud recording",
      startAt: new Date(Date.now() - 7200000).toISOString(),
      endAt: new Date(Date.now() - 3600000).toISOString(),
      status: "finished",
      externalMeetingId: "remote-meeting",
      meetingAccountId: account.id,
      createdBy: people.owner.user.id,
      recordingEnabled: true,
      recordingTtlDays: 10,
    })
    .returning()
    .get();
  const makeRecording = (extra: Partial<typeof recordings.$inferInsert> = {}) =>
    db.db
      .insert(recordings)
      .values({ meetingId: meeting.id, ...extra })
      .returning()
      .get();
  const get = (id: number) =>
    db.db.select().from(recordings).where(eq(recordings.id, id)).get()!;
  const calls: { url: URL; method: string }[] = [];
  const state = {
    pages: [
      [
        {
          meeting_record_id: "record-1",
          meeting_id: "remote-meeting",
          state: 3,
        },
      ],
    ] as any[][],
    files: [
      {
        record_file_id: "file-1",
        view_address: "https://meeting.tencent.com/crm/cloud-playback",
        sharing_url: "https://meeting.tencent.com/crm/shared-playback",
        download_address: undefined as string | undefined,
      },
    ] as any[],
    invalidPage: false,
    deleteError: undefined as Error | undefined,
    deleteId: "",
  };
  app.get(PlatformHttp).request = async (raw: string, method = "GET") => {
    const url = new URL(raw);
    calls.push({ url, method });
    assert.equal(
      url.searchParams.get("userid"),
      "host",
      "record APIs use userid, not operator_id_type=1",
    );
    assert.equal(url.searchParams.has("operator_id"), false);
    if (url.pathname === "/v1/records" && method === "GET") {
      assert.equal(url.searchParams.get("page_size"), "20");
      assert.equal(url.searchParams.get("meeting_id"), "remote-meeting");
      assert.ok(
        Number(url.searchParams.get("end_time")) -
          Number(url.searchParams.get("start_time")) <
          31 * 86400,
      );
      const page = Number(url.searchParams.get("page"));
      return {
        total_page: state.pages.length,
        current_page: state.invalidPage ? 1 : page,
        record_meetings: state.pages[page - 1] || [],
      };
    }
    if (url.pathname === "/v1/addresses") {
      assert.equal(
        url.searchParams.has("page_size"),
        false,
        "addresses endpoint is not paginated",
      );
      assert.ok(url.searchParams.get("meeting_record_id"));
      return { meeting_id: "remote-meeting", record_files: state.files };
    }
    assert.equal(method, "DELETE");
    assert.equal(
      url.searchParams.get("meeting_id"),
      "remote-meeting",
      "deletion requires meeting_id",
    );
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (state.deleteError && (!state.deleteId || id === state.deleteId))
      throw state.deleteError;
    state.files = state.files.filter((f) => f.record_file_id !== id);
    return {};
  };
  try {
    await t.test(
      "records playback-only files, refreshes unchanged file URLs and keeps TTL stable",
      async () => {
        const row = makeRecording({
          status: "failed",
          error: "old invalid page size",
        });
        await service.poll(row);
        const ready = get(row.id);
        assert.equal(ready.status, "ready");
        assert.equal(ready.remoteUrl, state.files[0].view_address);
        assert.equal(ready.error, null);
        const listed = service
          .list(people.owner.user)
          .find((r) => r.recording.id === row.id)!.recording;
        assert.equal(listed.files[0]!.viewUrl, state.files[0].sharing_url);
        assert.equal(listed.files[0]!.downloadable, false);
        assert.equal(listed.canDelete, false);
        assert.equal(service.list(people.stranger.user).length, 0);
        state.files[0].view_address =
          "https://meeting.tencent.com/crm/updated-playback";
        await service.poll(ready);
        assert.equal(get(row.id).remoteUrl, state.files[0].view_address);
        assert.equal(get(row.id).expiresAt, ready.expiresAt);
        const stranger = await request(
          "stranger",
          "GET",
          `/api/recordings/${row.id}/download?fileId=file-1`,
        );
        assert.equal(stranger.statusCode, 403);
      },
    );
    await t.test(
      "schedule recordings are scoped, permission checked and read without platform requests",
      async () => {
        const foreign = db.db
          .insert(meetings)
          .values({
            subject: "Other private meeting",
            startAt: meeting.startAt,
            endAt: meeting.endAt,
            createdBy: people.stranger.user.id,
            status: "finished",
          })
          .returning()
          .get();
        const privateRecording = db.db
          .insert(recordings)
          .values({
            meetingId: foreign.id,
            status: "deleted",
          })
          .returning()
          .get();
        db.db
          .insert(meetingAttendees)
          .values({
            meetingId: meeting.id,
            userId: people.guest.user.id,
            displayName: "Invited guest",
          })
          .run();
        const before = calls.length;
        const endpoint = `/api/meetings/${meeting.id}/recordings`;
        for (const actor of ["owner", "guest", "operator", "admin"]) {
          const response = await request(actor, "GET", endpoint);
          assert.equal(response.statusCode, 200);
          const data = response.json();
          assert.ok(data.length > 0);
          assert.ok(data.every((row: any) => row.id !== privateRecording.id));
          assert.equal(
            data[0].files[0].viewUrl,
            ["admin", "operator"].includes(actor)
              ? "https://meeting.tencent.com/crm/updated-playback"
              : "https://meeting.tencent.com/crm/shared-playback",
          );
          assert.equal(data[0].canDelete, actor === "admin");
          assert.equal(data[0].filesJson, undefined);
          assert.equal(data[0].meeting, undefined);
        }
        assert.equal(
          (await request("stranger", "GET", endpoint)).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "owner",
              "GET",
              `/api/meetings/${foreign.id}/recordings`,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (await request("owner", "GET", "/api/meetings/999999/recordings"))
            .statusCode,
          404,
        );
        assert.equal(
          (await server.inject({ method: "GET", url: endpoint })).statusCode,
          401,
        );
        assert.equal(calls.length, before);
      },
    );
    await t.test(
      "paginates list, skips transcoding and rejects wrong page/unsafe addresses",
      async () => {
        state.pages.push([{ meeting_record_id: "record-2", state: 2 }]);
        const before = calls.length;
        const files = await tencent.recordingFiles(meeting, account);
        assert.equal(files.length, 1);
        assert.equal(
          files[0]!.shareUrl,
          "https://meeting.tencent.com/crm/shared-playback",
        );
        assert.equal(
          calls.slice(before).filter((c) => c.url.pathname === "/v1/records")
            .length,
          2,
        );
        assert.equal(
          calls.slice(before).filter((c) => c.url.pathname === "/v1/addresses")
            .length,
          1,
        );
        await assert.rejects(
          () =>
            tencent.recordingFiles(meeting, account, { requireComplete: true }),
          /正在生成/,
        );
        state.invalidPage = true;
        await assert.rejects(
          () => tencent.recordingFiles(meeting, account),
          /分页/,
        );
        state.invalidPage = false;
        state.pages.pop();
        state.files[0].view_address = "https://evil.test/redirect";
        await assert.rejects(
          () => tencent.recordingFiles(meeting, account),
          /不受信任/,
        );
        state.files[0].view_address =
          "https://meeting.tencent.com/crm/playback";
      },
    );
    await t.test(
      "an empty list waits instead of failing, and stops polling after seven days",
      async () => {
        const saved = state.pages;
        state.pages = [];
        const row = makeRecording();
        await service.poll(row);
        assert.equal(get(row.id).status, "processing");
        assert.equal(get(row.id).error, null);
        db.db
          .update(meetings)
          .set({
            endAt: new Date(Date.now() - 8 * 86400000).toISOString(),
            startAt: new Date(
              Date.now() - 8 * 86400000 - 3600000,
            ).toISOString(),
          })
          .where(eq(meetings.id, meeting.id))
          .run();
        await service.poll(get(row.id));
        assert.equal(get(row.id).status, "unavailable");
        db.db
          .update(meetings)
          .set({ endAt: meeting.endAt, startAt: meeting.startAt })
          .where(eq(meetings.id, meeting.id))
          .run();
        state.pages = saved;
      },
    );
    await t.test(
      "manual sync runs immediately as a durable worker job",
      async () => {
        const row = makeRecording({ status: "failed" });
        assert.equal(
          (await request("owner", "POST", `/api/recordings/${row.id}/retry`))
            .statusCode,
          403,
        );
        assert.equal(
          (await request("operator", "POST", `/api/recordings/${row.id}/retry`))
            .statusCode,
          201,
        );
        await worker.runOnce(false);
        assert.equal(get(row.id).status, "ready");
      },
    );
    await t.test(
      "only system administrators can delete; requests are idempotent and revoke access immediately",
      async () => {
        const row = makeRecording();
        await service.poll(row);
        for (const actor of ["owner", "operator", "stranger"])
          assert.equal(
            (await request(actor, "DELETE", `/api/recordings/${row.id}`))
              .statusCode,
            403,
          );
        assert.equal(
          (await request("admin", "DELETE", `/api/recordings/${row.id}`))
            .statusCode,
          200,
        );
        assert.equal(
          (await request("admin", "DELETE", `/api/recordings/${row.id}`))
            .statusCode,
          200,
        );
        assert.equal(get(row.id).status, "deleting");
        assert.equal(
          service
            .list(people.admin.user)
            .find((r) => r.recording.id === row.id)!.recording.files[0]!
            .viewUrl,
          undefined,
        );
        assert.equal(
          db.db
            .select()
            .from(jobs)
            .where(eq(jobs.type, "recording.delete"))
            .all()
            .filter((j) => JSON.parse(j.payloadJson!).id === row.id).length,
          1,
        );
        await service.poll(row); // stale poll must not resurrect deletion
        assert.equal(get(row.id).status, "deleting");
        await worker.runOnce(false);
        assert.equal(get(row.id).status, "deleted");
        assert.equal(state.files.length, 0);
        assert.equal(get(row.id).remoteUrl, null);
        assert.equal(
          (
            await request(
              "admin",
              "GET",
              `/api/recordings/${row.id}/download?fileId=file-1`,
            )
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      "partial deletion checkpoints successful files and retries failures without claiming success",
      async () => {
        state.files = ["one", "two"].map((id) => ({
          record_file_id: id,
          view_address: `https://meeting.tencent.com/crm/${id}`,
        }));
        const row = makeRecording();
        await service.poll(row);
        service.delete(row.id, people.admin.user);
        state.deleteId = "two";
        state.deleteError = new PlatformError("腾讯会议", "NO_PERMISSION");
        await assert.rejects(
          () => service.performDelete(row.id),
          /NO_PERMISSION/,
        );
        assert.equal(get(row.id).status, "deleting");
        assert.equal(JSON.parse(get(row.id).filesJson!)[0].remoteDeleted, true);
        assert.equal(
          JSON.parse(get(row.id).filesJson!)[1].remoteDeleted,
          undefined,
        );
        const before = calls.filter(
          (c) => c.method === "DELETE" && c.url.pathname.endsWith("/one"),
        ).length;
        state.deleteError = undefined;
        await service.performDelete(row.id);
        assert.equal(get(row.id).status, "deleted");
        assert.equal(
          calls.filter(
            (c) => c.method === "DELETE" && c.url.pathname.endsWith("/one"),
          ).length,
          before,
        );
        await worker.runOnce(false); // queued delete becomes a safe no-op
      },
    );
    await t.test(
      "deletion timeouts are reconciled and external deletions stop exposing stale playback",
      async () => {
        state.files = [
          {
            record_file_id: "external",
            view_address: "https://meeting.tencent.com/crm/external",
          },
        ];
        const row = makeRecording();
        await service.poll(row);
        state.files = [];
        await service.poll(get(row.id));
        assert.equal(get(row.id).status, "processing");
        assert.equal(
          service
            .list(people.owner.user)
            .find((r) => r.recording.id === row.id)!.recording.files.length,
          0,
        );
        state.files = [
          {
            record_file_id: "external",
            view_address: "https://meeting.tencent.com/crm/external",
          },
        ];
        await service.poll(get(row.id));
        service.delete(row.id, people.admin.user);
        const original = app.get(PlatformHttp).request;
        app.get(PlatformHttp).request = async (
          ...args: Parameters<PlatformHttp["request"]>
        ) => {
          if (args[1] === "DELETE") {
            state.files = [];
            throw new PlatformError("腾讯会议", "NETWORK", true);
          }
          return original(...args);
        };
        try {
          await service.performDelete(row.id);
        } finally {
          app.get(PlatformHttp).request = original;
        }
        assert.equal(get(row.id).status, "deleted");
        await worker.runOnce(false);
      },
    );
    await t.test(
      "TTL can retain the Tencent file while hiding links; explicit deletion still removes it",
      async () => {
        state.files = [
          {
            record_file_id: "retained",
            view_address: "https://meeting.tencent.com/crm/retained",
          },
        ];
        const row = makeRecording({ deleteRemote: false });
        await service.poll(row);
        db.db
          .update(recordings)
          .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
          .where(eq(recordings.id, row.id))
          .run();
        assert.equal(
          service
            .list(people.owner.user)
            .find((r) => r.recording.id === row.id)!.recording.files[0]!
            .viewUrl,
          undefined,
        );
        const before = calls.filter((c) => c.method === "DELETE").length;
        await service.expire(get(row.id));
        assert.equal(get(row.id).status, "expired");
        assert.equal(calls.filter((c) => c.method === "DELETE").length, before);
        assert.equal(state.files.length, 1);
        service.delete(row.id, people.admin.user);
        await worker.runOnce(false);
        assert.equal(get(row.id).status, "deleted");
        assert.equal(state.files.length, 0);
      },
    );
    await t.test(
      "TTL remote deletion also includes newly discovered segments",
      async () => {
        state.files = [
          {
            record_file_id: "first",
            view_address: "https://meeting.tencent.com/crm/first",
          },
        ];
        const row = makeRecording();
        await service.poll(row);
        state.files.push({
          record_file_id: "late",
          view_address: "https://meeting.tencent.com/crm/late",
        });
        await service.expire(get(row.id));
        assert.equal(get(row.id).status, "expired");
        assert.equal(state.files.length, 0);
        assert.equal(JSON.parse(get(row.id).filesJson!).length, 2);
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
