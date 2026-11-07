import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { PlatformConnectionService } from "./platform-connection.service.js";
import { MeetingQueryService } from "./meeting-query.service.js";
import { MeetingLifecycleService } from "./meeting-lifecycle.service.js";
import {
  calendarTemplates,
  jobs,
  meetingAttendees,
  meetingCalendarTargets,
  meetings,
  recordings,
} from "./db/schema.js";
import { type SessionUser } from "./auth.service.js";
import { parse } from "./validation.js";
import { bookingSchema, noHostMessage } from "./meeting-shared.js";

@Injectable()
export class MeetingService {
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(PlatformRegistry) readonly registry: PlatformRegistry,
    @Inject(PlatformConnectionService)
    private connections: PlatformConnectionService,
    @Optional() @Inject(MeetingQueryService) queryService?: MeetingQueryService,
    @Optional() @Inject(MeetingLifecycleService)
    lifecycleService?: MeetingLifecycleService,
  ) {
    // 兼容测试里直接 new MeetingService(db, config, registry, connections) 的旧写法。
    this.query =
      queryService ?? new MeetingQueryService(this.database, this.registry, this.config);
    this.lifecycle =
      lifecycleService ??
      new MeetingLifecycleService(
        this.database,
        this.registry,
        this.config,
        this.query,
      );
  }
  private query: MeetingQueryService;
  private lifecycle: MeetingLifecycleService;
  accessible(...args: Parameters<MeetingQueryService["accessible"]>) {
    return this.query.accessible(...args);
  }
  publicMeeting<
    T extends {
      providerResponseJson?: unknown;
      calendarDescriptionText?: unknown;
    },
  >(row: T) {
    return this.query.publicMeeting(row);
  }
  visibility(...args: Parameters<MeetingQueryService["visibility"]>) {
    return this.query.visibility(...args);
  }
  list(...args: Parameters<MeetingQueryService["list"]>) {
    return this.query.list(...args);
  }
  count(...args: Parameters<MeetingQueryService["count"]>) {
    return this.query.count(...args);
  }
  personal(...args: Parameters<MeetingQueryService["personal"]>) {
    return this.query.personal(...args);
  }
  previewHost(...args: Parameters<MeetingQueryService["previewHost"]>) {
    return this.query.previewHost(...args);
  }
  detail(...args: Parameters<MeetingQueryService["detail"]>) {
    return this.query.detail(...args);
  }
  calendarDetail(...args: Parameters<MeetingQueryService["calendarDetail"]>) {
    return this.query.calendarDetail(...args);
  }
  eventPayload(...args: Parameters<MeetingQueryService["eventPayload"]>) {
    return this.query.eventPayload(...args);
  }
  account(...args: Parameters<MeetingLifecycleService["account"]>) {
    return this.lifecycle.account(...args);
  }
  provision(...args: Parameters<MeetingLifecycleService["provision"]>) {
    return this.lifecycle.provision(...args);
  }
  retry(...args: Parameters<MeetingLifecycleService["retry"]>) {
    return this.lifecycle.retry(...args);
  }
  finish(...args: Parameters<MeetingLifecycleService["finish"]>) {
    return this.lifecycle.finish(...args);
  }
  reschedule(...args: Parameters<MeetingLifecycleService["reschedule"]>) {
    return this.lifecycle.reschedule(...args);
  }
  updateMeeting(...args: Parameters<MeetingLifecycleService["updateMeeting"]>) {
    return this.lifecycle.updateMeeting(...args);
  }
  cancel(...args: Parameters<MeetingLifecycleService["cancel"]>) {
    return this.lifecycle.cancel(...args);
  }
  remove(...args: Parameters<MeetingLifecycleService["remove"]>) {
    return this.lifecycle.remove(...args);
  }
  performCancel(...args: Parameters<MeetingLifecycleService["performCancel"]>) {
    return this.lifecycle.performCancel(...args);
  }
  reconcile(...args: Parameters<MeetingLifecycleService["reconcile"]>) {
    return this.lifecycle.reconcile(...args);
  }
  release(...args: Parameters<MeetingLifecycleService["release"]>) {
    return this.lifecycle.release(...args);
  }
  cohosts(...args: Parameters<MeetingLifecycleService["cohosts"]>) {
    return this.lifecycle.cohosts(...args);
  }
  reserve(input: unknown, requestKey: string, user: SessionUser) {
    const body = parse(bookingSchema, input);
    if (!(input as Record<string, unknown>)?.recordingTtlDays)
      body.recordingTtlDays = this.database.recordingSettings().ttlDays;
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(requestKey))
      throw new BadRequestException(
        "预约需要 Idempotency-Key（32–128 个字母数字字符）",
      );
    if (Date.parse(body.startAt) < Date.now() - 60000)
      throw new BadRequestException("不能预约过去的时间");
    const existing = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.requestKey, requestKey))
      .get();
    if (existing) {
      if (existing.deletedAt)
        throw new ConflictException("此会议已删除，请重新预约");
      if (existing.createdBy !== user.id)
        throw new ConflictException("幂等键已被其他用户使用");
      const previous = JSON.parse(existing.extensionsJson || "{}");
      delete previous.calendarTemplateSnapshot;
      if (JSON.stringify(previous) !== JSON.stringify(body))
        throw new ConflictException("同一个幂等键不能用于不同的预约");
      return this.query.detail(existing.id, user);
    }
    const template = body.calendarTemplateId
      ? this.database.db
          .select()
          .from(calendarTemplates)
          .where(eq(calendarTemplates.id, body.calendarTemplateId))
          .get()
      : undefined;
    if (body.calendarTemplateId && (!template || !template.enabled))
      throw new BadRequestException("日程模板已停用或不存在");
    // Fail before allocating resources if calendar or platform configuration is missing.
    const component=this.registry.select("meeting",body.connectionId,body.providerId);
    const provider=this.registry.meeting(component.connectionId);
    provider.validate(body);
    if(body.recordingEnabled && !component.capabilities.recording)
      throw new BadRequestException("当前会议方式不支持云录制");
    const requestedCalendarIds =
      body.calendarConnectionIds !== undefined
        ? [...new Set(body.calendarConnectionIds)]
        : body.calendarConnectionId === undefined
          ? (() => {
              const id = this.registry
                .list()
                .find((c) => c.capability === "calendar" && c.configured)
                ?.connectionId;
              return id ? [id] : [];
            })()
          : body.calendarConnectionId
            ? [body.calendarConnectionId]
            : [];
    const calendarTargets = requestedCalendarIds.map((id) => {
      const provider = this.registry.calendar(id);
      return { connectionId: id, calendarId: provider.calendarId };
    });
    const firstCalendar = calendarTargets[0];
    const record = this.database.db.transaction(
      (tx) => {
        const attendees = provider.people(tx, body.attendeeIds, user.id);
        const choice = provider.selectHost(tx, body, user.id);
        if (!choice) throw new ConflictException(noHostMessage(body.hostMode));
        const row = tx
          .insert(meetings)
          .values({
            providerId:component.providerId,connectionId:component.connectionId,
            calendarConnectionId:firstCalendar?.connectionId || null,
            calendarStatus:calendarTargets.length ? "pending" : "not_requested",
            hostExternalId:choice.hostAccountId,hostName:choice.hostAccountName,
            subject: body.subject,
            description: body.description || null,
            startAt: body.startAt,
            endAt: body.endAt,
            createdBy: user.id,
            accountPoolId: choice.accountPoolId,
            allocationSource: choice.allocationSource,
            meetingAccountId: choice.meetingAccountId,
            status: "provisioning",
            requestKey,
            recordingEnabled: body.recordingEnabled,
            recordingTtlDays: body.recordingTtlDays,
            calendarTemplateId: body.calendarTemplateId || null,
            extensionsJson: JSON.stringify({
              ...body,
              ...(template ? { calendarTemplateSnapshot: template } : {}),
            }),
            calendarId: firstCalendar?.calendarId || null,
          })
          .returning()
          .get();
        for (const attendee of attendees)
          tx.insert(meetingAttendees)
            .values({
              meetingId: row.id,
              userId: attendee!.id,
              email: attendee!.email,
              displayName: attendee!.displayName,
              externalId: attendee!.externalId,
              isCohost:
                !!(component.capabilities.cohost || component.capabilities.preassignHost) && !!attendee!.externalId &&
                attendee!.externalId !== choice.hostAccountId,
              cohostStatus: !(component.capabilities.cohost || component.capabilities.preassignHost) || !attendee!.externalId
                ? "not_applicable"
                : attendee!.externalId === choice.hostAccountId
                  ? "host"
                  : "pending",
            })
            .run();
        for (const address of [...new Set(body.attendeeEmails)])
          tx.insert(meetingAttendees)
            .values({
              meetingId: row.id,
              email: address,
              displayName: address,
              isCohost: false,
              cohostStatus: "not_applicable",
            })
            .run();
        tx.insert(jobs)
          .values({
            type: "meeting.provision",
            payloadJson: JSON.stringify({ id: row.id }),
            runAt: new Date().toISOString(),
          })
          .run();
        if (body.recordingEnabled)
          tx.insert(recordings)
            .values({
              meetingId: row.id,
              storageType: "remote",
              deleteRemote: !!component.capabilities.deleteRecording && this.database.recordingSettings().deleteRemote,
            })
            .run();
        return row;
      },
      { behavior: "immediate" },
    );
    this.database.addAuditLog(
      "meeting.reserve",
      JSON.stringify({ id: record.id, subject: record.subject }),
      String(user.id),
    );
    this.database.notifyJobs();
    return this.query.detail(record.id, user);
  }
}
