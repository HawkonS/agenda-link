import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { eventDescription } from "./platforms/calendar/contract.js";
import type { StoredFile } from "./platforms/recording-files.js";
import { MeetingService } from "./meeting.service.js";
import { recordings, meetings, jobs } from "./db/schema.js";
import type { SessionUser } from "./auth.service.js";
import { PlatformError } from "./platforms/shared/http.js";

type Recording = typeof recordings.$inferSelect;
const terminal = ["expired", "deleted", "deleting", "delete_failed"];
@Injectable()
export class RecordingService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(MeetingService) private booking: MeetingService,
  ) {}
  private row(id: number) {
    const row = this.database.db
      .select()
      .from(recordings)
      .where(eq(recordings.id, id))
      .get();
    if (!row) throw new BadRequestException("录制不存在");
    return row;
  }
  forMeeting(id: number, user: SessionUser) {
    this.booking.accessible(id, user);
    return this.list(user, id).map((row) => row.recording);
  }
  list(user: SessionUser, meetingId?: number) {
    return this.database.db
      .select({ recording: recordings, meeting: meetings })
      .from(recordings)
      .innerJoin(meetings, eq(recordings.meetingId, meetings.id))
      .where(
        and(
          this.booking.visibility(user, true),
          meetingId === undefined ? undefined : eq(meetings.id, meetingId),
        ),
      )
      .all()
      .map(({ meeting, recording: r }) => {
        const available =
          r.status === "ready" &&
          (!r.expiresAt || Date.parse(r.expiresAt) > Date.now());
        return {
          meeting: this.booking.publicMeeting(meeting),
          recording: {
            id: r.id,
            status: r.status,
            expiresAt: r.expiresAt,
            error: r.error,
            storageType: r.storageType,
            lastPolledAt: r.lastPolledAt,
            deleteRemote: r.deleteRemote,
            canDelete:
              user.role === "system_admin" &&
              !!this.booking.registry.descriptor(
                "meeting",
                meeting.connectionId,
              ).capabilities.deleteRecording &&
              r.storageType === "remote" &&
              ["ready", "expired", "delete_failed"].includes(r.status) &&
              (JSON.parse(r.filesJson || "[]") as StoredFile[]).some(
                (f) => !f.remoteDeleted,
              ),
            remoteDeletionSupported: !!this.booking.registry.descriptor(
              "meeting",
              meeting.connectionId,
            ).capabilities.deleteRecording,
            files: (JSON.parse(r.filesJson || "[]") as StoredFile[]).map(
              (f) => {
                // 管理员沿用主持人视角；普通用户（含创建人和联席主持人）
                // 优先用分享页，避免只有会议主持人账号才有播放权限。
                const viewUrl =
                  user.role === "user"
                    ? f.shareUrl || f.viewUrl
                    : f.viewUrl;
                return {
                  id: f.id,
                  extension: f.extension,
                  viewUrl:
                    available && viewUrl && !f.remoteDeleted
                      ? this.booking.registry.recordingUrl(
                          viewUrl,
                          meeting.connectionId,
                        )
                      : undefined,
                  downloadable:
                    available && Boolean(f.url) && !f.remoteDeleted,
                };
              },
            ),
          },
        };
      });
  }
  async poll(input: Recording) {
    const recording = this.row(input.id);
    if (terminal.includes(recording.status)) return;
    const meeting = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, recording.meetingId))
      .get();
    if (!meeting?.externalMeetingId || Date.parse(meeting.endAt) > Date.now())
      return;
    const previous = JSON.parse(recording.filesJson || "[]") as StoredFile[];
    this.database.db
      .update(recordings)
      .set({ lastPolledAt: new Date().toISOString() })
      .where(eq(recordings.id, recording.id))
      .run();
    try {
      if (recording.storageType !== "remote")
        throw new BadRequestException(
          "此历史录制使用已停用的外部存储，请从原平台维护文件",
        );
      const found = await this.booking.registry
        .meeting(meeting.connectionId)
        .recordingFiles(meeting, this.booking.account(meeting));
      // A manual deletion can be queued while the platform query is in flight.
      if (terminal.includes(this.row(recording.id).status)) return;
      const previousById = new Map(previous.map((f) => [f.id, f]));
      // The complete current list also detects files removed in Tencent itself.
      const files = found.map((file) => ({
        ...previousById.get(file.id),
        ...file,
      }));
      const available = files.some(
        (f) => !f.remoteDeleted && (f.viewUrl || f.url),
      );
      if (!available) {
        const unavailable =
          Date.now() - Date.parse(meeting.endAt) > 7 * 86400000;
        this.database.db
          .update(recordings)
          .set({
            status: unavailable ? "unavailable" : "processing",
            filesJson: JSON.stringify(files),
            error: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(recordings.id, recording.id))
          .run();
        return;
      }
      const expiresAt =
        recording.expiresAt ||
        new Date(
          Date.now() + meeting.recordingTtlDays * 86400000,
        ).toISOString();
      this.database.db
        .update(recordings)
        .set({
          status: "ready",
          expiresAt,
          filesJson: JSON.stringify(files),
          remoteUrl:
            files.find((f) => f.viewUrl && !f.remoteDeleted)?.viewUrl || null,
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(recordings.id, recording.id))
        .run();
      if (
        recording.status !== "ready" ||
        recording.error?.startsWith("日程回写待重试：")
      ) {
        try {
          await this.backwrite(meeting);
        } catch (error) {
          this.database.db
            .update(recordings)
            .set({
              error:
                "日程回写待重试：" +
                (error instanceof Error ? error.message : "失败"),
            })
            .where(eq(recordings.id, recording.id))
            .run();
        }
      }
      if (recording.status !== "ready" || files.length !== previous.length)
        this.database.addAuditLog(
          "recording.ready",
          JSON.stringify({ recordingId: recording.id, count: files.length }),
          "worker",
        );
    } catch (error) {
      if (!terminal.includes(this.row(recording.id).status))
        this.database.db
          .update(recordings)
          .set({
            // A transient refresh failure must not revoke a previously available recording.
            status: recording.status === "ready" ? "ready" : "failed",
            error: error instanceof Error ? error.message : "录制查询失败",
          })
          .where(eq(recordings.id, recording.id))
          .run();
      throw error;
    }
  }
  private async backwrite(meeting: typeof meetings.$inferSelect) {
    if (
      meeting.deletedAt ||
      ["cancelled", "cancelling", "cancel_failed"].includes(meeting.status)
    )
      return;
    if (meeting.calendarEventId && meeting.calendarId) {
      const base = this.booking.eventPayload(meeting);
      const payload = {
        ...base,
        description:
          (base.description || "") +
          "\n录制：" +
          this.config.baseUrl +
          `/calendar?meeting=${meeting.id}`,
      };
      await this.booking.registry
        .calendar(meeting.calendarConnectionId!)
        .updateEvent(meeting.calendarEventId, meeting.calendarId, payload);
      this.database.db
        .update(meetings)
        .set({
          calendarDescriptionText: eventDescription(payload),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, meeting.id))
        .run();
    }
  }
  private enqueue(type: string, id: number) {
    const existing = this.database.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.type, type), inArray(jobs.status, ["queued", "running"])),
      )
      .all();
    if (!existing.some((j) => JSON.parse(j.payloadJson || "{}").id === id))
      this.database.db
        .insert(jobs)
        .values({
          type,
          payloadJson: JSON.stringify({ id }),
          runAt: new Date().toISOString(),
        })
        .run();
  }
  retry(id: number, user: SessionUser) {
    if (user.role === "user") throw new ForbiddenException("无权同步录制");
    const row = this.row(id);
    this.booking.accessible(row.meetingId, user, false, true);
    if (terminal.includes(row.status))
      throw new BadRequestException("此录制无法同步");
    const meeting = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, row.meetingId))
      .get()!;
    if (Date.parse(meeting.endAt) > Date.now())
      throw new BadRequestException("会议结束后才能同步录制");
    this.database.db.transaction(() => {
      this.database.db
        .update(recordings)
        .set({
          status: row.status === "ready" ? "ready" : "processing",
          error: null,
        })
        .where(eq(recordings.id, id))
        .run();
      this.enqueue("recording.sync", id);
    });
    this.database.notifyJobs();
    this.database.addAuditLog("recording.retry", String(id), String(user.id));
    return { ok: true };
  }
  delete(id: number, user: SessionUser) {
    if (user.role !== "system_admin")
      throw new ForbiddenException("仅系统管理员可以删除云录制");
    const row = this.row(id);
    const meeting = this.booking.accessible(row.meetingId, user, false, true);
    if (
      !this.booking.registry.descriptor("meeting", meeting.connectionId)
        .capabilities.deleteRecording
    )
      throw new BadRequestException("该平台不支持远端录制删除");
    if (["deleted", "deleting"].includes(row.status)) return { ok: true };
    if (row.storageType !== "remote")
      throw new BadRequestException("请从原存储平台维护此历史录制");
    if (
      !["ready", "expired", "delete_failed"].includes(row.status) ||
      !JSON.parse(row.filesJson || "[]").length
    )
      throw new BadRequestException("尚未获取到云录制文件，不能删除");
    this.database.db.transaction(() => {
      this.database.db
        .update(recordings)
        .set({ status: "deleting", remoteUrl: null, error: null })
        .where(eq(recordings.id, id))
        .run();
      this.enqueue("recording.delete", id);
    });
    this.database.notifyJobs();
    this.database.addAuditLog(
      "recording.delete_requested",
      String(id),
      String(user.id),
    );
    return { ok: true };
  }
  async performDelete(id: number) {
    const row = this.row(id);
    if (row.status !== "deleting") return;
    try {
      await this.removeRemote(row, true);
      this.finish(row.id, "deleted");
    } catch (error) {
      this.database.db
        .update(recordings)
        .set({
          error: error instanceof Error ? error.message : "云录制删除失败",
        })
        .where(eq(recordings.id, id))
        .run();
      throw error;
    }
  }
  private finish(id: number, status: "deleted" | "expired") {
    this.database.db
      .update(recordings)
      .set({
        status,
        remoteUrl: null,
        objectUrl: null,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(recordings.id, id))
      .run();
    this.database.addAuditLog("recording." + status, String(id), "worker");
  }
  private async removeRemote(row: Recording, refresh: boolean) {
    if (row.storageType !== "remote")
      throw new BadRequestException(
        "此历史录制使用已停用的外部存储，请从原平台维护文件",
      );
    const meeting = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, row.meetingId))
      .get();
    if (!meeting?.externalMeetingId)
      throw new BadRequestException("会议缺少腾讯会议 ID，无法删除云录制");
    const account = this.booking.account(meeting);
    const previous = JSON.parse(row.filesJson || "[]") as StoredFile[];
    const found = refresh
      ? await this.booking.registry
          .meeting(meeting.connectionId)
          .recordingFiles(meeting, account, {
            requireComplete: true,
          })
      : [];
    const byId = new Map(previous.map((f) => [f.id, f]));
    for (const f of found) byId.set(f.id, { ...byId.get(f.id), ...f });
    const files = [...byId.values()];
    for (const file of files) {
      if (file.remoteDeleted) continue;
      if (refresh && !found.some((f) => f.id === file.id)) {
        file.remoteDeleted = true;
        file.viewUrl = undefined;
        file.url = undefined;
        this.database.db
          .update(recordings)
          .set({ filesJson: JSON.stringify(files) })
          .where(eq(recordings.id, row.id))
          .run();
        continue;
      }
      try {
        await this.booking.registry.meeting(meeting.connectionId)
          .deleteRecording!(file.id, meeting.externalMeetingId, account);
      } catch (error: any) {
        if (error.httpStatus !== 404) {
          // A timeout can occur after Tencent accepted deletion. Re-query before retrying.
          if (!(error instanceof PlatformError) || !error.ambiguous)
            throw error;
          const current = await this.booking.registry
            .meeting(meeting.connectionId)
            .recordingFiles(meeting, account);
          if (current.some((f) => f.id === file.id)) throw error;
        }
      }
      file.remoteDeleted = true;
      file.viewUrl = undefined;
      file.url = undefined;
      this.database.db
        .update(recordings)
        .set({ filesJson: JSON.stringify(files) })
        .where(eq(recordings.id, row.id))
        .run();
    }
  }
  async expire(input: Recording) {
    const row = this.row(input.id);
    if (
      ["expired", "deleted", "deleting", "delete_failed"].includes(row.status)
    )
      return;
    const meeting = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, row.meetingId))
      .get();
    if (
      row.deleteRemote &&
      meeting &&
      this.booking.registry.descriptor("meeting", meeting.connectionId)
        .capabilities.deleteRecording
    )
      await this.removeRemote(row, true);
    // A delete request may have arrived during the remote query.
    if (this.row(row.id).status === "deleting") return;
    this.finish(row.id, "expired");
  }
  async download(id: number, fileId: string, user: SessionUser) {
    const row = this.row(id);
    const meeting = this.booking.accessible(row.meetingId, user, false, true);
    if (
      row.status !== "ready" ||
      (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())
    )
      throw new BadRequestException("录制不可下载或已过期");
    const file = (JSON.parse(row.filesJson || "[]") as StoredFile[]).find(
      (f) => f.id === fileId && !f.remoteDeleted,
    );
    if (!file) throw new BadRequestException("录制文件不存在");
    if (row.storageType !== "remote")
      throw new BadRequestException("请从原存储平台下载此历史录制");
    const fresh = await this.booking.registry
      .meeting(meeting.connectionId)
      .recordingFiles(meeting, this.booking.account(meeting));
    const current = fresh.find((f) => f.id === fileId);
    const latest = this.row(id);
    if (
      !current?.url ||
      latest.status !== "ready" ||
      (latest.expiresAt && Date.parse(latest.expiresAt) <= Date.now())
    )
      throw new BadRequestException("平台录制暂不可下载或已过期");
    this.database.addAuditLog(
      "recording.download",
      JSON.stringify({ id, fileId }),
      String(user.id),
    );
    return {
      url: this.booking.registry.recordingUrl(
        current.url,
        meeting.connectionId,
      ),
    };
  }
}
