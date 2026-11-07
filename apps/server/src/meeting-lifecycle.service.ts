import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { PlatformError } from "./platforms/shared/http.js";
import { eventDescription } from "./platforms/calendar/contract.js";
import {
  accountPools,
  calendarTemplates,
  jobs,
  meetingAccounts,
  meetingAttendees,
  meetingCalendarTargets,
  meetings,
  recordings,
} from "./db/schema.js";
import type { SessionUser } from "./auth.service.js";
import { occupiedMeeting } from "./meeting-allocation.js";
import { MeetingQueryService } from "./meeting-query.service.js";

@Injectable()
export class MeetingLifecycleService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(PlatformRegistry) private registry: PlatformRegistry,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(MeetingQueryService) private query: MeetingQueryService,
  ) {}

  account(row: typeof meetings.$inferSelect) {
    const a = row.meetingAccountId
      ? this.database.db
          .select()
          .from(meetingAccounts)
          .where(eq(meetingAccounts.id, row.meetingAccountId))
          .get()
      : undefined;
    if (!a && row.hostExternalId) return {id:0,name:row.hostName || "会议归属人",accountId:row.hostExternalId,secretId:null,secretKey:null,status:"available" as const,verifiedAt:row.createdAt,providerId:row.providerId,connectionId:row.connectionId,lastError:null,createdAt:row.createdAt,updatedAt:row.updatedAt};
    if (!a) throw new BadRequestException("会议账号不存在");
    if(a.connectionId!==row.connectionId)throw new BadRequestException("会议账号与平台连接不匹配");
    return a;
  }
  async provision(id: number) {
    let row = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, id))
      .get();
    if (
      !row ||
      row.deletedAt ||
      ["cancelled", "cancelling", "cancel_failed", "finished"].includes(
        row.status,
      )
    )
      return;
    const account = this.account(row);
    try {
      if (!row.externalMeetingId) {
        if (
          row.provisionStep === "meeting_inflight" ||
          row.status === "unknown"
        )
          throw new PlatformError(this.registry.descriptor("meeting",row.connectionId).name, "NEEDS_RECONCILIATION", true);
        await this.registry.meeting(row.connectionId).verifyAccount(account);
        this.database.db
          .update(meetings)
          .set({ provisionStep: "meeting_inflight" })
          .where(eq(meetings.id, id))
          .run();
        const attendees = this.database.db
          .select()
          .from(meetingAttendees)
          .where(eq(meetingAttendees.meetingId, id))
          .all();
        // Tencent supports assigning reservation-time hosts, while its
        // cohost endpoint only works after the meeting has started.  Submit
        // every selected internal cohost with a Tencent identity as a host so
        // the role is present on the reservation immediately.  The actual
        // meeting control loop still verifies the live role and can promote a
        // participant to cohost when Tencent reports an ordinary role.
        const reservedHostIds = attendees
          .filter((a) => a.isCohost && a.externalId)
          .map((a) => a.externalId!)
          .filter((value, index, values) => values.indexOf(value) === index);
        const remote = await this.registry.meeting(row.connectionId).createMeeting(
          {
            ...row,
            hostIds: reservedHostIds,
            inviteeIds: attendees
              .map((a) => a.externalId)
              .filter(
                (x): x is string => Boolean(x) && x !== account.accountId,
              ),
          },
          account,
        );
        this.database.db
          .update(meetings)
          .set({
            externalMeetingId: remote.id,
            meetingCode: remote.code || null,
            providerResponseJson: JSON.stringify(remote.response || {}),
            meetingUrl: remote.url,
            provisionStep: "meeting_created",
          })
          .where(eq(meetings.id, id))
          .run();
        // A successful POST means Tencent accepted the reservation-time host
        // list. Keep this visible before the meeting starts; the live control
        // worker may later refine it to `host` or `applied`.
        for (const attendee of attendees) {
          if (
            attendee.isCohost &&
            attendee.externalId &&
            reservedHostIds.includes(attendee.externalId)
          ) {
            this.database.db
              .update(meetingAttendees)
              .set({ cohostStatus: remote.rejectedHostIds?.includes(attendee.externalId!) ? "failed" : "preassigned_host", cohostError: remote.rejectedHostIds?.includes(attendee.externalId!) ? "平台未接受此主持人预设，请检查身份与权限" : null })
              .where(eq(meetingAttendees.id, attendee.id))
              .run();
          }
        }
        row = this.database.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, id))
          .get()!;
      }
      let calendarTargets = this.database.db
        .select()
        .from(meetingCalendarTargets)
        .where(eq(meetingCalendarTargets.meetingId, id))
        .all();
      if (!calendarTargets.length && row.calendarConnectionId) {
        this.database.db
          .insert(meetingCalendarTargets)
          .values({
            meetingId: id,
            connectionId: row.calendarConnectionId,
            calendarId: row.calendarId,
            eventId: row.calendarEventId,
            status: row.calendarEventId ? "synced" : "pending",
            error: row.calendarError,
          })
          .run();
        calendarTargets = this.database.db
          .select()
          .from(meetingCalendarTargets)
          .where(eq(meetingCalendarTargets.meetingId, id))
          .all();
      }
      if (!calendarTargets.length) {
        this.database.db
          .update(meetings)
          .set({
            status: "scheduled",
            provisionStep: "done",
            error: null,
            calendarStatus: "not_requested",
            calendarError: null,
          })
          .where(eq(meetings.id, id))
          .run();
        this.database.addAuditLog(
          "meeting.provisioned",
          JSON.stringify({ id, externalMeetingId: row.externalMeetingId }),
          String(row.createdBy),
        );
        return;
      }
      const payload = this.query.eventPayload(row);
      for (const [index, target] of calendarTargets.entries()) {
        const provider = this.registry.calendar(target.connectionId);
        const calendarId = target.calendarId || provider.calendarId;
        let eventId = target.eventId;
        if (!eventId) {
          const remote = await provider.createEvent(
            payload,
            index === 0
              ? row.requestKey!
              : `${row.requestKey || id}:${target.connectionId}`,
            calendarId,
          );
          eventId = remote.id;
          this.database.db
            .update(meetingCalendarTargets)
            .set({
              eventId,
              calendarId,
              status: "event_created",
              error: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(meetingCalendarTargets.id, target.id))
            .run();
          if (index === 0)
            this.database.db
              .update(meetings)
              .set({
                calendarEventId: eventId,
                calendarId,
                provisionStep: "event_created",
                calendarDescriptionText: eventDescription(payload),
              })
              .where(eq(meetings.id, id))
              .run();
        } else if (row.provisionStep !== "done") {
          await provider.updateEvent(eventId, calendarId, payload);
          this.database.db
            .update(meetings)
            .set({ calendarDescriptionText: eventDescription(payload) })
            .where(eq(meetings.id, id))
            .run();
        }
        await provider.invite(eventId, calendarId, payload.attendees);
        this.database.db
          .update(meetingCalendarTargets)
          .set({
            eventId,
            calendarId,
            status: "synced",
            error: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(meetingCalendarTargets.id, target.id))
          .run();
        if (index === 0)
          this.database.db
            .update(meetings)
            .set({ calendarEventId: eventId, calendarId })
            .where(eq(meetings.id, id))
            .run();
      }
      this.database.db
        .update(meetings)
        .set({
          status: "scheduled",
          error: null,
          provisionStep: "done",
          calendarStatus: "synced",calendarError:null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, id))
        .run();
      this.database.addAuditLog(
        "meeting.provisioned",
        JSON.stringify({ id, externalMeetingId: row.externalMeetingId }),
        String(row.createdBy),
      );
    } catch (error) {
      const current = this.database.db
        .select()
        .from(meetings)
        .where(eq(meetings.id, id))
        .get()!;
      const ambiguous =
        !current.externalMeetingId &&
        error instanceof PlatformError &&
        error.ambiguous;
      this.database.db
        .update(meetings)
        .set({
          status: ambiguous ? "unknown" : "failed",
          ...(current.externalMeetingId && current.calendarConnectionId ? {calendarStatus:"failed",calendarError:error instanceof Error ? error.message : "日程创建失败"} : {}),
          error: error instanceof Error ? error.message : "预约失败",
          ...(!ambiguous && !current.externalMeetingId
            ? { provisionStep: "reserved" }
            : {}),
        })
        .where(eq(meetings.id, id))
        .run();
      throw error;
    }
  }
  retry(id: number, user: SessionUser) {
    const row = this.query.accessible(id, user, true);
    if (row.status !== "failed")
      throw new ConflictException(
        "仅失败任务可重试；结果不确定的会议先由管理员核对",
      );
    this.database.db.transaction(
      (tx) => {
        if (!row.externalMeetingId && this.registry.descriptor("meeting",row.connectionId).capabilities.accountPool) {
          const account = this.account(row),
            pool = row.accountPoolId
              ? tx
                  .select()
                  .from(accountPools)
                  .where(eq(accountPools.id, row.accountPoolId))
                  .get()
              : undefined;
          if (
            account.status !== "available" ||
            !account.verifiedAt ||
            (row.allocationSource === "pool" && !pool?.enabled)
          )
            throw new ConflictException("原账号或账号池已停用，请重新预约");
          if (Date.parse(row.endAt) <= Date.now())
            throw new ConflictException("会议时间已过，请重新预约");
          const busy = tx
            .select()
            .from(meetings)
            .where(
              and(
                eq(meetings.meetingAccountId, row.meetingAccountId!),
                occupiedMeeting(),
                sql`${meetings.id} <> ${id} AND ${meetings.startAt}<${row.endAt} AND ${meetings.endAt}>${row.startAt}`,
              ),
            )
            .get();
          if (busy)
            throw new ConflictException("原账号已被其他会议占用，请重新预约");
        }
        const pending = tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "meeting.provision"),
              inArray(jobs.status, ["queued", "running"]),
              sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
            ),
          )
          .get();
        if (pending?.status === "running")
          throw new ConflictException("任务正在执行");
        tx.update(meetings)
          .set({ status: "provisioning", error: null })
          .where(eq(meetings.id, id))
          .run();
        if (pending)
          tx.update(jobs)
            .set({ runAt: new Date().toISOString() })
            .where(eq(jobs.id, pending.id))
            .run();
        else
          tx.insert(jobs)
            .values({
              type: "meeting.provision",
              payloadJson: JSON.stringify({ id }),
              runAt: new Date().toISOString(),
            })
            .run();
      },
      { behavior: "immediate" },
    );
    this.database.addAuditLog("meeting.retry", String(id), String(user.id));
    this.database.notifyJobs();
    return { ok: true };
  }
  async updateMeeting(
    id: number,
    input: {
      subject: string;
      description?: string;
      startAt: string;
      endAt: string;
      attendeeIds: number[];
      attendeeEmails: string[];
      calendarTemplateId?: number | null;
      recordingEnabled: boolean;
      recordingTtlDays?: number;
    },
    user: SessionUser,
  ) {
    const row = this.query.accessible(id, user, true);
    if (row.status !== "scheduled")
      throw new ConflictException("只有已预约的会议可以编辑");
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
      throw new BadRequestException("会议时间格式无效");
    if (end <= start) throw new BadRequestException("结束时间必须晚于开始时间");
    if (start.getTime() < Date.now() - 60000)
      throw new BadRequestException("不能修改到过去的时间");
    const startAt = start.toISOString();
    const endAt = end.toISOString();
    const conflict = this.database.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          sql`${meetings.id} <> ${id}`,
          sql`${meetings.startAt} < ${endAt} AND ${meetings.endAt} > ${startAt}`,
          occupiedMeeting(),
          row.meetingAccountId
            ? eq(meetings.meetingAccountId, row.meetingAccountId)
            : row.hostExternalId
              ? eq(meetings.hostExternalId, row.hostExternalId)
              : undefined,
        ),
      )
      .get();
    if (conflict) throw new ConflictException("该时段发起账号已有其他会议");
    const provider = this.registry.meeting(row.connectionId);
    if (row.externalMeetingId && !provider.updateMeeting)
      throw new BadRequestException("当前会议平台不支持修改会议");
    const template = input.calendarTemplateId
      ? this.database.db
          .select()
          .from(calendarTemplates)
          .where(eq(calendarTemplates.id, input.calendarTemplateId))
          .get()
      : undefined;
    if (input.calendarTemplateId && (!template || !template.enabled))
      throw new BadRequestException("日程模板已停用或不存在");
    const uniqueIds = [...new Set(input.attendeeIds)];
    const people = provider.people(this.database.db, uniqueIds, user.id);
    if (people.length !== uniqueIds.length)
      throw new BadRequestException("部分参会人不存在或不可见");
    const emails = [
      ...new Set(
        input.attendeeEmails
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (
      emails.some(
        (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      )
    )
      throw new BadRequestException("外部邀请邮箱格式不正确");
    const oldAttendees = this.database.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, id))
      .all();
    const oldRecording = this.database.db
      .select()
      .from(recordings)
      .where(eq(recordings.meetingId, id))
      .get();
    let extensions: Record<string, any> = {};
    try {
      extensions = JSON.parse(row.extensionsJson || "{}");
    } catch {
      extensions = {};
    }
    const nextExtensions: Record<string, any> = {
      ...extensions,
      startAt,
      endAt,
      attendeeEmails: emails,
    };
    if (template) nextExtensions.calendarTemplateSnapshot = template;
    else delete nextExtensions.calendarTemplateSnapshot;
    const description = input.description?.trim() || null;
    const updatedRow = {
      ...row,
      subject: input.subject,
      description,
      startAt,
      endAt,
      calendarTemplateId: input.calendarTemplateId || null,
      recordingEnabled: input.recordingEnabled,
      recordingTtlDays: input.recordingTtlDays || row.recordingTtlDays,
      extensionsJson: JSON.stringify(nextExtensions),
    };
    const account = this.account(row);
    const component = this.registry.descriptor("meeting", row.connectionId);
    const oldPayload = this.query.eventPayload(row);
    const oldInviteeIds = oldAttendees
      .map((person) => person.externalId)
      .filter((value): value is string => Boolean(value));
    const supportsCohost =
      component.capabilities.cohost || component.capabilities.preassignHost;
    const replaceAttendees = (tx: any) => {
      tx.delete(meetingAttendees)
        .where(eq(meetingAttendees.meetingId, id))
        .run();
      for (const person of people)
        tx.insert(meetingAttendees)
          .values({
            meetingId: id,
            userId: person.id,
            email: person.email,
            displayName: person.displayName,
            externalId: person.externalId,
            isCohost:
              !!supportsCohost && !!person.externalId &&
              person.externalId !== row.hostExternalId,
            cohostStatus:
              !supportsCohost || !person.externalId
                ? "not_applicable"
                : person.externalId === row.hostExternalId
                  ? "host"
                  : "pending",
          })
          .run();
      for (const email of emails)
        tx.insert(meetingAttendees)
          .values({
            meetingId: id,
            email,
            displayName: email,
            isCohost: false,
            cohostStatus: "not_applicable",
          })
          .run();
    };
    this.database.db.transaction(
      (tx) => {
        tx.update(meetings)
          .set({
            subject: input.subject,
            description,
            startAt,
            endAt,
            calendarTemplateId: input.calendarTemplateId || null,
            recordingEnabled: input.recordingEnabled,
            recordingTtlDays: input.recordingTtlDays || row.recordingTtlDays,
            extensionsJson: JSON.stringify(nextExtensions),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(meetings.id, id))
          .run();
        replaceAttendees(tx);
        if (input.recordingEnabled && !oldRecording)
          tx.insert(recordings)
            .values({
              meetingId: id,
              storageType: "remote",
              deleteRemote:
                !!component.capabilities.deleteRecording &&
                this.database.recordingSettings().deleteRemote,
            })
            .run();
      },
      { behavior: "immediate" },
    );
    let newPayload: ReturnType<MeetingQueryService["eventPayload"]>;
    const targets = this.database.db
      .select()
      .from(meetingCalendarTargets)
      .where(eq(meetingCalendarTargets.meetingId, id))
      .all();
    const updatedTargets: {
      provider: ReturnType<PlatformRegistry["calendar"]>;
      eventId: string;
      calendarId: string;
    }[] = [];
    let remoteUpdated = false;
    const restoreLocal = () => {
      this.database.db.transaction(
        (tx) => {
          tx.update(meetings)
            .set({
              subject: row.subject,
              description: row.description,
              startAt: row.startAt,
              endAt: row.endAt,
              calendarTemplateId: row.calendarTemplateId,
              recordingEnabled: row.recordingEnabled,
              recordingTtlDays: row.recordingTtlDays,
              extensionsJson: row.extensionsJson,
            })
            .where(eq(meetings.id, id))
            .run();
          tx.delete(meetingAttendees)
            .where(eq(meetingAttendees.meetingId, id))
            .run();
          for (const person of oldAttendees)
            tx.insert(meetingAttendees).values(person).run();
          if (!oldRecording)
            tx.delete(recordings).where(eq(recordings.meetingId, id)).run();
        },
        { behavior: "immediate" },
      );
    };
    const rollbackRemote = async () => {
      if (remoteUpdated && row.externalMeetingId && provider.updateMeeting)
        await provider.updateMeeting(
          row.externalMeetingId,
          {
            subject: row.subject,
            startAt: row.startAt,
            endAt: row.endAt,
            inviteeIds: oldInviteeIds,
            recordingEnabled: row.recordingEnabled,
          },
          account,
        );
    };
    try {
      newPayload = this.query.eventPayload(updatedRow);
      if (row.externalMeetingId && provider.updateMeeting) {
        await provider.updateMeeting(
          row.externalMeetingId,
          {
            subject: input.subject,
            startAt,
            endAt,
            inviteeIds: people
              .map((person) => person.externalId)
              .filter((value): value is string => Boolean(value)),
            recordingEnabled: input.recordingEnabled,
          },
          account,
        );
        remoteUpdated = true;
      }
      for (const target of targets) {
        if (!target.eventId) continue;
        const calendar = this.registry.calendar(target.connectionId);
        const calendarId = target.calendarId || calendar.calendarId;
        await calendar.updateEvent(target.eventId, calendarId, newPayload);
        updatedTargets.push({
          provider: calendar,
          eventId: target.eventId,
          calendarId,
        });
        await calendar.replaceAttendees(
          target.eventId,
          calendarId,
          newPayload.attendees || [],
        );
      }
      this.database.db
        .update(meetings)
        .set({ calendarDescriptionText: eventDescription(newPayload) })
        .where(eq(meetings.id, id))
        .run();
    } catch (error) {
      try {
        for (const target of updatedTargets) {
          await target.provider.updateEvent(
            target.eventId,
            target.calendarId,
            oldPayload,
          );
          await target.provider.replaceAttendees(
            target.eventId,
            target.calendarId,
            oldPayload.attendees || [],
          );
        }
        await rollbackRemote();
      } catch {
        // Best effort; keep the original error for the operator.
      }
      restoreLocal();
      throw error;
    }
    this.database.addAuditLog(
      "meeting.update",
      JSON.stringify({ id, subject: input.subject, startAt, endAt }),
      String(user.id),
    );
    return this.query.calendarDetail(id, user);
  }
  async reschedule(
    id: number,
    input: { startAt: string; endAt: string },
    user: SessionUser,
  ) {
    const row = this.query.accessible(id, user, true);
    if (row.status !== "scheduled")
      throw new ConflictException("只有已预约的会议可以修改时间");
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
      throw new BadRequestException("会议时间格式无效");
    if (end <= start) throw new BadRequestException("结束时间必须晚于开始时间");
    if (start.getTime() < Date.now() - 60000)
      throw new BadRequestException("不能修改到过去的时间");
    const startAt = start.toISOString();
    const endAt = end.toISOString();
    const conflict = this.database.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          sql`${meetings.id} <> ${id}`,
          sql`${meetings.startAt} < ${endAt} AND ${meetings.endAt} > ${startAt}`,
          occupiedMeeting(),
          row.meetingAccountId
            ? eq(meetings.meetingAccountId, row.meetingAccountId)
            : row.hostExternalId
              ? eq(meetings.hostExternalId, row.hostExternalId)
              : undefined,
        ),
      )
      .get();
    if (conflict) throw new ConflictException("该时段发起账号已有其他会议");
    const account = this.account(row);
    const provider = this.registry.meeting(row.connectionId);
    if (row.externalMeetingId && !provider.updateMeeting)
      throw new BadRequestException("当前会议平台不支持修改会议时间");
    const targets = this.database.db
      .select()
      .from(meetingCalendarTargets)
      .where(eq(meetingCalendarTargets.meetingId, id))
      .all();
    const newPayload = this.query.eventPayload({ ...row, startAt, endAt });
    const oldPayload = this.query.eventPayload(row);
    const updatedTargets: {
      provider: ReturnType<PlatformRegistry["calendar"]>;
      eventId: string;
      calendarId: string;
    }[] = [];
    let remoteUpdated = false;
    const rollback = async () => {
      for (const target of updatedTargets)
        await target.provider.updateEvent(
          target.eventId,
          target.calendarId,
          oldPayload,
        );
      if (remoteUpdated && row.externalMeetingId && provider.updateMeeting)
        await provider.updateMeeting(
          row.externalMeetingId,
          { subject: row.subject, startAt: row.startAt, endAt: row.endAt },
          account,
        );
    };
    try {
      for (const target of targets) {
        if (!target.eventId) continue;
        const calendar = this.registry.calendar(target.connectionId);
        const calendarId = target.calendarId || calendar.calendarId;
        await calendar.updateEvent(target.eventId, calendarId, newPayload);
        updatedTargets.push({
          provider: calendar,
          eventId: target.eventId,
          calendarId,
        });
      }
      if (row.externalMeetingId && provider.updateMeeting) {
        await provider.updateMeeting(
          row.externalMeetingId,
          { subject: row.subject, startAt, endAt },
          account,
        );
        remoteUpdated = true;
      }
      let extensions: Record<string, unknown> = {};
      try {
        extensions = JSON.parse(row.extensionsJson || "{}");
      } catch {
        extensions = {};
      }
      this.database.db
        .update(meetings)
        .set({
          startAt,
          endAt,
          extensionsJson: JSON.stringify({ ...extensions, startAt, endAt }),
          calendarDescriptionText: eventDescription(newPayload),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, id))
        .run();
    } catch (error) {
      try {
        await rollback();
      } catch {
        // Keep the original platform error; operators can reconcile manually.
      }
      throw error;
    }
    this.database.addAuditLog(
      "meeting.reschedule",
      JSON.stringify({ id, startAt, endAt }),
      String(user.id),
    );
    return this.query.calendarDetail(id, user);
  }
  finish(id: number, user: SessionUser) {
    return this.database.db.transaction(
      (tx) => {
        const row = this.query.accessible(id, user, true);
        if (row.status === "finished") return { ok: true };
        if (row.status !== "scheduled")
          throw new ConflictException("仅已预约的会议可以结束");
        const active = tx
          .select()
          .from(jobs)
          .where(
            and(
              inArray(jobs.type, ["meeting.provision", "meeting.cancel"]),
              inArray(jobs.status, ["queued", "running"]),
              sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
            ),
          )
          .get();
        if (active)
          throw new ConflictException("会议任务尚未结束，请稍后结束会议");
        // Release only the local allocation; preserve remote bookings and times.
        tx.update(meetings)
          .set({
            status: "finished",
            error: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(meetings.id, id))
          .run();
        this.database.addAuditLog(
          "meeting.finished",
          String(id),
          String(user.id),
        );
        return { ok: true };
      },
      { behavior: "immediate" },
    );
  }
  cancel(id: number, user: SessionUser) {
    const row = this.query.accessible(id, user, true);
    if (row.status === "cancelled") return { ok: true };
    if (
      row.status === "unknown" ||
      (!row.externalMeetingId && row.provisionStep === "meeting_inflight")
    )
      throw new ConflictException("预约正在执行或结果不确定，请先等待或核对");
    this.database.db.transaction((tx) => {
      const creating = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "meeting.provision"),
            eq(jobs.status, "running"),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .get();
      if (creating) throw new ConflictException("预约任务正在执行，请稍后取消");
      tx.update(jobs)
        .set({
          status: "success",
          error: "预约已取消，创建任务已停止",
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(jobs.type, "meeting.provision"),
            eq(jobs.status, "queued"),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .run();
      if (
        tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "meeting.cancel"),
              inArray(jobs.status, ["queued", "running"]),
              sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
            ),
          )
          .get()
      )
        return;
      tx.update(meetings)
        .set({
          status: "cancelling",
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, id))
        .run();
      tx.insert(jobs)
        .values({
          type: "meeting.cancel",
          payloadJson: JSON.stringify({ id }),
          runAt: new Date().toISOString(),
        })
        .run();
    });
    this.database.addAuditLog("meeting.cancel", String(id), String(user.id));
    this.database.notifyJobs();
    return { ok: true };
  }
  remove(id: number, user: SessionUser) {
    if (user.role === "user")
      throw new ForbiddenException("仅管理员可以删除会议记录");
    const row = this.query.accessible(id, user);
    if (row.status !== "cancelled")
      throw new ConflictException(
        "请先取消会议，待会议和日程取消成功后再删除",
      );
    this.database.db.transaction((tx) => {
      const active = tx
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, ["meeting.provision", "meeting.cancel"]),
            inArray(jobs.status, ["queued", "running"]),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .get();
      if (active) throw new ConflictException("相关任务尚未结束，请稍后删除");
      // Retain the parent for cloud-recording TTL cleanup and immutable booking keys.
      tx.update(meetings)
        .set({
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, id))
        .run();
      this.database.addAuditLog(
        "meeting.delete",
        JSON.stringify({ id, subject: row.subject }),
        String(user.id),
      );
    });
    return { ok: true };
  }
  async performCancel(id: number) {
    const row = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, id))
      .get();
    if (!row || ["cancelled", "finished"].includes(row.status)) return;
    if (row.externalMeetingId && row.provisionStep !== "meeting_cancelled") {
      await this.registry.meeting(row.connectionId).cancel(row.externalMeetingId, this.account(row));
      this.database.db
        .update(meetings)
        .set({ provisionStep: "meeting_cancelled" })
        .where(eq(meetings.id, id))
        .run();
    }
    const calendarTargets = this.database.db
      .select()
      .from(meetingCalendarTargets)
      .where(eq(meetingCalendarTargets.meetingId, id))
      .all();
    for (const target of calendarTargets) {
      if (!target.eventId || !target.calendarId) continue;
      try {
        await this.registry
          .calendar(target.connectionId)
          .deleteEvent(target.eventId, target.calendarId);
      } catch (error: any) {
        if (!["193001", "193003"].includes(error.code)) throw error;
      }
      this.database.db
        .update(meetingCalendarTargets)
        .set({ status: "deleted", updatedAt: new Date().toISOString() })
        .where(eq(meetingCalendarTargets.id, target.id))
        .run();
    }
    if (!calendarTargets.length && row.calendarEventId && row.calendarId) {
      try {
        await this.registry.calendar(row.calendarConnectionId!).deleteEvent(row.calendarEventId, row.calendarId);
      } catch (error: any) {
        if (!["193001", "193003"].includes(error.code)) throw error;
      }
    }
    this.database.db
      .update(meetings)
      .set({
        status: "cancelled",
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(meetings.id, id))
      .run();
    this.database.db
      .update(recordings)
      .set({ status: "expired" })
      .where(
        and(
          eq(recordings.meetingId, id),
          eq(recordings.status, "scheduled"),
          sql`${row.startAt} > ${new Date().toISOString()}`,
        ),
      )
      .run();
    this.database.addAuditLog(
      "meeting.cancelled",
      String(id),
      String(row.createdBy),
    );
  }
  async reconcile(id: number, remoteId: string, user: SessionUser) {
    if (user.role !== "system_admin")
      throw new ForbiddenException("仅系统管理员可核对未知会议");
    const row = this.query.accessible(id, user, true);
    if (row.status !== "unknown")
      throw new BadRequestException("会议状态无需核对");
    const remote = await this.registry.meeting(row.connectionId).lookup(remoteId,this.account(row),row);
    if (this.query.accessible(id, user, true).status !== "unknown")
      throw new ConflictException("会议状态已改变，请刷新后重试");
    this.database.db
      .update(meetings)
      .set({
        externalMeetingId: remoteId,
        meetingCode: remote.code,
        providerResponseJson: JSON.stringify(remote.response || {}),
        meetingUrl: remote.url,
        provisionStep: "meeting_created",
        status: "failed",
      })
      .where(eq(meetings.id, id))
      .run();
    this.database.addAuditLog(
      "meeting.reconcile",
      JSON.stringify({ id, remoteId }),
      String(user.id),
    );
    return this.retry(id, user);
  }
  release(id: number, user: SessionUser) {
    if (user.role !== "system_admin") throw new ForbiddenException();
    const row = this.query.accessible(id, user, true);
    if (row.status !== "unknown")
      throw new ConflictException("仅待核对会议可释放");
    this.database.db.transaction((tx) => {
      tx.update(meetings)
        .set({
          status: "failed",
          provisionStep: "reserved",
          error: "管理员确认会议平台未创建，已释放账号时段；可重试或重新预约",
        })
        .where(eq(meetings.id, id))
        .run();
      tx.update(jobs)
        .set({ status: "failed", error: "管理员核对后释放" })
        .where(
          and(
            eq(jobs.type, "meeting.provision"),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .run();
    });
    this.database.addAuditLog(
      "meeting.confirm_not_created",
      String(id),
      String(user.id),
    );
    return { ok: true };
  }
  async cohosts(row: typeof meetings.$inferSelect) {
    if (
      !row.externalMeetingId ||
      !row.cohostEnabled ||
      row.status !== "scheduled" ||
      row.deletedAt
    )
      return;
    if(!this.registry.descriptor("meeting",row.connectionId).capabilities.cohost)return;
    await this.registry.meeting(row.connectionId).syncCohosts?.(row,this.account(row));
  }
}
