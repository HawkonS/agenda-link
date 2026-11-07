import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { EventPayload } from "./platforms/calendar/contract.js";
import { eventDescription } from "./platforms/calendar/contract.js";
import { DatabaseService } from "./database.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { ConfigurationService } from "./config/configuration.service.js";
import {
  accountPools,
  calendarTemplates,
  meetingAccounts,
  meetingAttendees,
  meetings,
  recordings,
  users,
} from "./db/schema.js";
import type { SessionUser } from "./auth.service.js";
import { parse } from "./validation.js";
import {
  hostSelectionSchema,
  meetingPlatformLabel,
  noHostMessage,
  render,
  templateDateTime,
} from "./meeting-shared.js";

@Injectable()
export class MeetingQueryService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(PlatformRegistry) private registry: PlatformRegistry,
    @Inject(ConfigurationService) private config: ConfigurationService,
  ) {}

  accessible(
    id: number,
    user: SessionUser,
    write = false,
    includeDeleted = false,
  ) {
    const row = this.database.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, id))
      .get();
    if (!row || (row.deletedAt && !includeDeleted))
      throw new NotFoundException("会议不存在");
    const invited = this.database.db
      .select()
      .from(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.meetingId, id),
          eq(meetingAttendees.userId, user.id),
        ),
      )
      .get();
    if (
      user.role === "user" &&
      row.createdBy !== user.id &&
      (write || !invited)
    )
      throw new ForbiddenException("只能管理自己的会议");
    return { ...row, meetingUrl: this.registry.joinUrl(row.meetingUrl,row.connectionId) };
  }

  /** The raw provider response can contain a meeting password and is kept
   * server-side for template rendering. Never include it in API responses. */
  publicMeeting<
    T extends { providerResponseJson?: unknown; calendarDescriptionText?: unknown },
  >(row: T) {
    const {
      providerResponseJson: _privateResponse,
      calendarDescriptionText: _note,
      ...publicRow
    } = row;
    return publicRow;
  }
  visibility(user: SessionUser, includeDeleted = false) {
    return and(
      includeDeleted ? undefined : isNull(meetings.deletedAt),
      user.role === "user"
        ? or(
            eq(meetings.createdBy, user.id),
            inArray(
              meetings.id,
              this.database.db
                .select({ id: meetingAttendees.meetingId })
                .from(meetingAttendees)
                .where(eq(meetingAttendees.userId, user.id)),
            ),
          )
        : undefined,
    );
  }
  /** 与“我的”一致：自己创建或被邀请的会议。 */
  private personalFor(userId: number) {
    return and(
      isNull(meetings.deletedAt),
      or(
        eq(meetings.createdBy, userId),
        inArray(
          meetings.id,
          this.database.db
            .select({ id: meetingAttendees.meetingId })
            .from(meetingAttendees)
            .where(eq(meetingAttendees.userId, userId)),
        ),
      ),
    );
  }
  personal(user: SessionUser) {
    return this.personalFor(user.id);
  }
  private ownerFilter(
    user: SessionUser,
    owner?: "self" | "all" | number,
  ) {
    if (owner === "self") return this.personal(user);
    if (typeof owner === "number") return this.personalFor(owner);
    return undefined;
  }

  private participantFilter(participant?: number) {
    if (!participant) return undefined;
    return inArray(
      meetings.id,
      this.database.db
        .select({ id: meetingAttendees.meetingId })
        .from(meetingAttendees)
        .where(eq(meetingAttendees.userId, participant)),
    );
  }
  list(
    user: SessionUser,
    range: { from?: string; to?: string } = {},
    page: { limit?: number; offset?: number } = {},
    owner?: "self" | "all" | number,
    participant?: number,
  ) {
    // 时间窗只影响日历视图；分页只在显式传 limit 时生效，旧客户端行为不变。
    const visible = and(
      this.visibility(user),
      this.ownerFilter(user, owner),
      this.participantFilter(participant),
      range.from ? gte(meetings.endAt, range.from) : undefined,
      range.to ? lte(meetings.startAt, range.to) : undefined,
    );
    const base = this.database.db
      .select({
        meeting: meetings,
        hostAccountId: meetingAccounts.accountId,
        hostAccountName: meetingAccounts.name,
        accountPoolName: accountPools.name,
      })
      .from(meetings)
      .leftJoin(
        meetingAccounts,
        eq(meetingAccounts.id, meetings.meetingAccountId),
      )
      .leftJoin(accountPools, eq(accountPools.id, meetings.accountPoolId))
      .where(visible)
      .orderBy(meetings.startAt);
    const rows =
      page.limit === undefined
        ? base.all()
        : base.limit(page.limit).offset(page.offset ?? 0).all();
    const attendees =
      rows.length === 0
        ? []
        : this.database.db
            .select({ attendee: meetingAttendees })
            .from(meetingAttendees)
            .innerJoin(meetings, eq(meetings.id, meetingAttendees.meetingId))
            .where(
              and(
                visible,
                inArray(
                  meetingAttendees.meetingId,
                  rows.map((row) => row.meeting.id),
                ),
              ),
            )
            .all();
    const grouped = new Map<number, (typeof meetingAttendees.$inferSelect)[]>();
    for (const { attendee } of attendees) {
      const list = grouped.get(attendee.meetingId) || [];
      list.push(attendee);
      grouped.set(attendee.meetingId, list);
    }
    return rows.map(
      ({ meeting, hostAccountId, hostAccountName, accountPoolName }) => ({
        ...this.publicMeeting(meeting),
        meetingUrl: this.registry.joinUrl(meeting.meetingUrl,meeting.connectionId),
        platformName:this.registry.descriptor("meeting",meeting.connectionId).name,
        calendarPlatformName:meeting.calendarConnectionId?this.registry.descriptor("calendar",meeting.calendarConnectionId).name:null,
        capabilities:this.registry.descriptor("meeting",meeting.connectionId).capabilities,
        hostAccountId:hostAccountId || meeting.hostExternalId,
        hostAccountName:hostAccountName || meeting.hostName,
        accountPoolName,
        attendees: grouped.get(meeting.id) || [],
      }),
    );
  }
  count(
    user: SessionUser,
    range: { from?: string; to?: string } = {},
    owner?: "self" | "all" | number,
    participant?: number,
  ) {
    return (
      this.database.db
        .select({ n: count() })
        .from(meetings)
        .where(
          and(
            this.visibility(user),
            this.ownerFilter(user, owner),
            range.from ? gte(meetings.endAt, range.from) : undefined,
            range.to ? lte(meetings.startAt, range.to) : undefined,
          ),
        )
        .get()?.n ?? 0
    );
  }
  previewHost(input: unknown, user: SessionUser) {
    const body = parse(hostSelectionSchema, input);
    const component=this.registry.select("meeting",body.connectionId,body.providerId);
    const provider=this.registry.meeting(component.connectionId);
    provider.validate(body);
    const host = provider.selectHost(this.database.db, body, user.id);
    return host
      ? { available: true as const, ...host }
      : {
          available: false as const,
          reason: noHostMessage(body.hostMode),
        };
  }
  detail(id: number, user: SessionUser) {
    const row = this.accessible(id, user);
    const account = row.meetingAccountId
      ? this.database.db
          .select({
            hostAccountId: meetingAccounts.accountId,
            hostAccountName: meetingAccounts.name,
          })
          .from(meetingAccounts)
          .where(eq(meetingAccounts.id, row.meetingAccountId))
          .get()
      : undefined;
    const pool = row.accountPoolId
      ? this.database.db
          .select({ accountPoolName: accountPools.name })
          .from(accountPools)
          .where(eq(accountPools.id, row.accountPoolId))
          .get()
      : undefined;
    const payload = this.eventPayload(row);
    let description = eventDescription(payload);
    // Legacy meetings have no saved note. Include an already successful
    // recording backwrite when Feishu is temporarily unreachable.
    if (row.calendarDescriptionText === null && row.calendarEventId) {
      const recording = this.database.db
        .select()
        .from(recordings)
        .where(eq(recordings.meetingId, id))
        .get();
      if (
        recording?.status === "ready" &&
        !recording.error?.startsWith("日程回写待重试：")
      )
        description = eventDescription({
          ...payload,
          description:
            (payload.description || "") +
            "\n录制：" +
            this.config.baseUrl +
            `/calendar?meeting=${row.id}`,
        });
    }
    return {
      ...this.publicMeeting(row),
      hostAccountId:row.hostExternalId,hostAccountName:row.hostName,
      ...account,
      platformName:this.registry.descriptor("meeting",row.connectionId).name,
      calendarPlatformName:row.calendarConnectionId?this.registry.descriptor("calendar",row.calendarConnectionId).name:null,
      capabilities:this.registry.descriptor("meeting",row.connectionId).capabilities,
      ...pool,
      calendarDescription: row.calendarDescriptionText ?? description,
      location: payload.location || null,
      attendeeEmails:
        JSON.parse(row.extensionsJson || "{}").attendeeEmails || [],
      attendees: this.database.db
        .select()
        .from(meetingAttendees)
        .where(eq(meetingAttendees.meetingId, id))
        .all(),
    };
  }
  async calendarDetail(id: number, user: SessionUser) {
    const row = this.accessible(id, user);
    // Recover old notes once, on demand. Normal list polling never calls Feishu.
    if (
      row.calendarDescriptionText === null &&
      row.calendarEventId &&
      row.calendarId
    ) {
      try {
        const description = await this.registry.calendar(row.calendarConnectionId!).readEventDescription(
          row.calendarEventId,
          row.calendarId,
        );
        if (description !== undefined)
          this.database.db
            .update(meetings)
            .set({ calendarDescriptionText: description })
            .where(
              and(
                eq(meetings.id, id),
                isNull(meetings.calendarDescriptionText),
                eq(meetings.calendarEventId, row.calendarEventId),
              ),
            )
            .run();
      } catch {
        // Existing notes remain readable using the saved template and join details.
      }
    }
    return this.detail(id, user);
  }

  eventPayload(row: typeof meetings.$inferSelect): EventPayload {
    const data = JSON.parse(row.extensionsJson || "{}");
    const attendees = this.database.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, row.id))
      .all();
    const owner = row.createdBy
      ? this.database.db
          .select()
          .from(users)
          .where(eq(users.id, row.createdBy))
          .get()
      : undefined;
    const p: EventPayload = {
      meetingProviderName:this.registry.descriptor("meeting",row.connectionId).name,
      subject: row.subject,
      description: row.description || "",
      startAt: row.startAt,
      endAt: row.endAt,
      meetingUrl: row.meetingUrl || undefined,
      location: data.location,
      reminders: data.reminders,
      extensions: data.extensions,
      attendees: row.calendarConnectionId ? [
        ...this.registry.calendar(row.calendarConnectionId).attendeesForUsers([...new Set([...attendees.map(a=>a.userId).filter((id):id is number=>!!id),...(owner?[owner.id]:[])])]),
        ...attendees.filter(a=>!a.userId && a.email).map(a=>({email:a.email!})),
      ] : [],
    };
    const baseDescription = (row.description || "").trim();
    const appendMeetingDetails = (value: string) => {
      let result = value.trim();
      const details = [
        row.meetingCode ? `${this.registry.descriptor("meeting",row.connectionId).name} · 会议号：${row.meetingCode}` : "",
        row.meetingUrl ? `加入${this.registry.descriptor("meeting",row.connectionId).name}：${row.meetingUrl}` : "",
      ].filter(Boolean);
      for (const detail of details) {
        const raw = detail.slice(detail.indexOf("：") + 1);
        if (raw && !result.includes(raw))
          result = [result, detail].filter(Boolean).join("\n\n");
      }
      return result;
    };
    if (row.calendarTemplateId) {
      const t =
        data.calendarTemplateSnapshot ||
        this.database.db
          .select()
          .from(calendarTemplates)
          .where(eq(calendarTemplates.id, row.calendarTemplateId))
          .get();
      if (!t) throw new BadRequestException("日程模板不存在");
      let providerResponse: unknown = {};
      try {
        providerResponse = JSON.parse(row.providerResponseJson || "{}");
      } catch {
        providerResponse = {};
      }
      const values = {
        subject: row.subject,
        description: row.description || "",
        meetingId: row.externalMeetingId || "",
        meetingCode: row.meetingCode || "",
        meetingNumber: row.meetingCode || "",
        meetingUrl: row.meetingUrl || "",
        hostAccountId: row.meetingAccountId
          ? this.database.db
              .select({ accountId: meetingAccounts.accountId })
              .from(meetingAccounts)
              .where(eq(meetingAccounts.id, row.meetingAccountId))
              .get()?.accountId || ""
          : row.hostExternalId || "",
        startAt: templateDateTime(row.startAt),
        endAt: templateDateTime(row.endAt),
        platformName: meetingPlatformLabel(
          row.connectionId,
          this.registry.descriptor("meeting", row.connectionId).name,
        ),
      };
      const providerId = this.registry.descriptor(
        "meeting",
        row.connectionId,
      ).providerId;
      p.subject = render(t.titleTemplate, values, providerResponse, providerId);
      const renderedDescription = render(
        t.descriptionTemplate ?? "{description}\n{meetingUrl}",
        values,
        providerResponse,
        providerId,
      );
      // A custom template may intentionally omit {description}. Preserve the
      // text entered during booking so the Feishu note never loses the user's
      // invitation or agenda, then append the returned Tencent join details.
      p.description = appendMeetingDetails(
        baseDescription &&
          !String(t.descriptionTemplate || "").includes("{description}")
          ? [baseDescription, renderedDescription].filter(Boolean).join("\n\n")
          : renderedDescription || baseDescription,
      );
      p.location = render(
        t.locationTemplate || "",
        values,
        providerResponse,
        providerId,
      );
      p.reminders = data.reminders ?? JSON.parse(t.remindersJson || "[10]");
      p.extensions = {
        ...JSON.parse(t.extensionsJson || "{}"),
        ...p.extensions,
      };
    } else {
      // Without a template, use a useful default Feishu note instead of only
      // sending a bare URL. This also keeps the meeting number available to
      // attendees when Tencent returns one.
      p.description = appendMeetingDetails(baseDescription);
    }
    return p;
  }
}
