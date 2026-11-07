import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService } from "./database.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import {eventDescription,type EventPayload} from "./platforms/calendar/contract.js";
import { calendarEvents, jobs, platformIdentities, users } from "./db/schema.js";
import { eventSchema, parse } from "./validation.js";
import { PlatformError } from "./platforms/shared/http.js";
import type { SessionUser } from "./auth.service.js";
export const personalEventSchema = eventSchema.safeExtend({
  providerId:z.string().max(100).optional(),connectionId:z.string().max(100).optional(),
  attendees: z
    .array(
      z
        .object({
          openId: z.string().min(1).max(100).optional(),
          userId: z.string().min(1).max(100).optional(),
          email: z.string().email().max(254).optional(),
        })
        .refine((p) => p.openId || p.userId || p.email, {
          message: "参与人需要飞书 ID 或邮箱",
        }),
    )
    .max(100)
    .optional(),
});
@Injectable()
export class CalendarService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(PlatformRegistry) private registry: PlatformRegistry,
  ) {}
  list(
    user: SessionUser,
    range: { from?: string; to?: string } = {},
    page: { limit?: number; offset?: number } = {},
    owner?: "self" | "all" | number,
    participant?: number,
  ) {
    const where = and(
      isNull(calendarEvents.deletedAt),
      user.role === "user"
        ? eq(calendarEvents.createdBy, user.id)
        : undefined,
      owner === "self"
        ? eq(calendarEvents.createdBy, user.id)
        : typeof owner === "number"
          ? eq(calendarEvents.createdBy, owner)
          : undefined,
      range.from ? gte(calendarEvents.endAt, range.from) : undefined,
      range.to ? lte(calendarEvents.startAt, range.to) : undefined,
    );
    const query = this.database.db
      .select()
      .from(calendarEvents)
      .where(where);
    let rows = query.all();
    if (participant) {
      const matches = this.participantMatcher(participant);
      rows = rows.filter((row) => matches(row));
    }
    if (page.limit !== undefined)
      rows = rows.slice(page.offset ?? 0, (page.offset ?? 0) + page.limit);
    return rows.map(({ calendarDescriptionText: _note, ...row }) => ({
      ...row,
      platformName: this.registry.descriptor("calendar", row.connectionId).name,
    }));
  }
  count(
    user: SessionUser,
    range: { from?: string; to?: string } = {},
    owner?: "self" | "all" | number,
    participant?: number,
  ) {
    if (participant)
      return this.list(user, range, {}, owner, participant).length;
    return (
      this.database.db
        .select({ n: count() })
        .from(calendarEvents)
        .where(
          and(
            isNull(calendarEvents.deletedAt),
            user.role === "user"
              ? eq(calendarEvents.createdBy, user.id)
              : undefined,
            owner === "self"
              ? eq(calendarEvents.createdBy, user.id)
              : typeof owner === "number"
                ? eq(calendarEvents.createdBy, owner)
                : undefined,
            range.from ? gte(calendarEvents.endAt, range.from) : undefined,
            range.to ? lte(calendarEvents.startAt, range.to) : undefined,
          ),
        )
        .get()?.n ?? 0
    );
  }
  private participantMatcher(userId: number) {
    const user = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    const identities = this.database.db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.userId, userId),
          eq(platformIdentities.kind, "person"),
        ),
      )
      .all();
    const ids = new Set(
      [String(userId), ...identities.flatMap((identity) => [identity.externalId, identity.stableId])]
        .filter((value): value is string => Boolean(value)),
    );
    const emails = new Set(
      [user?.email, ...identities.map((identity) => {
        try {
          return JSON.parse(identity.profileJson || "{}").email as string | undefined;
        } catch {
          return undefined;
        }
      })]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
    return (row: typeof calendarEvents.$inferSelect) => {
      try {
        const payload = JSON.parse(row.payloadJson || "{}");
        return (payload.attendees || []).some(
          (attendee: any) =>
            (attendee.userId && ids.has(String(attendee.userId))) ||
            (attendee.openId && ids.has(String(attendee.openId))) ||
            (attendee.email && emails.has(String(attendee.email).toLowerCase())),
        );
      } catch {
        return false;
      }
    };
  }
  async detail(id: number, user: SessionUser) {
    let row = this.own(id, user);
    if (
      row.calendarDescriptionText === null &&
      row.calendarEventId &&
      row.calendarId
    ) {
      try {
        const description = await this.registry.calendar(row.connectionId).readEventDescription(
          row.calendarEventId,
          row.calendarId,
        );
        if (description !== undefined)
          this.database.db
            .update(calendarEvents)
            .set({ calendarDescriptionText: description })
            .where(
              and(
                eq(calendarEvents.id, id),
                isNull(calendarEvents.calendarDescriptionText),
                eq(calendarEvents.calendarEventId, row.calendarEventId),
              ),
            )
            .run();
      } catch {
        // A Feishu outage must not prevent opening a locally saved schedule.
      }
      row = this.own(id, user);
    }
    const payload = JSON.parse(row.payloadJson) as EventPayload;
    const { calendarDescriptionText, ...publicRow } = row;
    return {
      ...publicRow,platformName:this.registry.descriptor("calendar",row.connectionId).name,
      calendarDescription: calendarDescriptionText ?? eventDescription(payload),
      location: payload.location || null,
      attendees: payload.attendees || [],
    };
  }
  own(id: number, user: SessionUser) {
    const row = this.database.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .get();
    if (!row || row.deletedAt) throw new NotFoundException("日程不存在");
    if (row.createdBy !== user.id && user.role === "user")
      throw new ForbiddenException("只能维护自己的日程");
    return row;
  }
  private enqueue(id: number, type: string) {
    this.database.db
      .insert(jobs)
      .values({
        type,
        payloadJson: JSON.stringify({ id }),
        runAt: new Date().toISOString(),
      })
      .run();
  }
  create(body: unknown, key: string, user: SessionUser) {
    const p = parse(personalEventSchema, body);
    parse(
      z
        .string()
        .min(32)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/),
      key,
    );
    const existing = this.database.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.requestKey, key))
      .get();
    if (existing) {
      if (existing.deletedAt)
        throw new ConflictException("此日程已删除，请重新创建");
      if (
        existing.createdBy !== user.id ||
        existing.payloadJson !== JSON.stringify(p)
      )
        throw new ConflictException("幂等键已被使用");
      return existing;
    }
    const component=this.registry.select("calendar",p.connectionId,p.providerId);
    const provider=this.registry.calendar(component.connectionId);
    const row = this.database.db.transaction((tx) => {
      const row = tx
        .insert(calendarEvents)
        .values({
          providerId:component.providerId,connectionId:component.connectionId,
          subject: p.subject,
          description: p.description,
          startAt: p.startAt,
          endAt: p.endAt,
          createdBy: user.id,
          requestKey: key,
          payloadJson: JSON.stringify(p),
          calendarId: provider.calendarId,
        })
        .returning()
        .get();
      this.enqueue(row.id, "calendar.provision");
      return row;
    });
    this.database.addAuditLog(
      "calendar.create",
      String(row.id),
      String(user.id),
    );
    this.database.notifyJobs();
    return row;
  }
  async provision(id: number) {
    let row = this.database.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .get();
    if (
      !row ||
      row.deletedAt ||
      ["cancelled", "cancelling", "cancel_failed"].includes(row.status)
    )
      return;
    const creationWasUncertain = row.creationUncertain;
    const p = JSON.parse(row.payloadJson) as EventPayload;
    const owner = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, row.createdBy))
      .get();
    p.attendees = [
      ...(p.attendees || []),
      ...this.registry.calendar(row.connectionId).attendeesForUsers(owner?[owner.id]:[]),
    ];
    try {
      if (!row.calendarEventId) {
        this.database.db
          .update(calendarEvents)
          .set({ creationUncertain: true })
          .where(eq(calendarEvents.id, id))
          .run();
        const remote = await this.registry.calendar(row.connectionId).createEvent(
          p,
          row.requestKey,
          row.calendarId!,
        );
        this.database.db
          .update(calendarEvents)
          .set({
            calendarEventId: remote.id,
            creationUncertain: false,
            calendarDescriptionText: eventDescription(p),
          })
          .where(eq(calendarEvents.id, id))
          .run();
        row = this.database.db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.id, id))
          .get()!;
      } else {
        await this.registry.calendar(row.connectionId).updateEvent(
          row.calendarEventId,
          row.calendarId!,
          p,
        );
        this.database.db
          .update(calendarEvents)
          .set({ calendarDescriptionText: eventDescription(p) })
          .where(eq(calendarEvents.id, id))
          .run();
      }
      await this.registry.calendar(row.connectionId).replaceAttendees(
        row.calendarEventId!,
        row.calendarId!,
        p.attendees,
      );
      this.database.db
        .update(calendarEvents)
        .set({
          status: "synced",
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(calendarEvents.id, id))
        .run();
    } catch (error) {
      const definite =
        error instanceof HttpException ||
        (error instanceof PlatformError && !error.ambiguous);
      this.database.db
        .update(calendarEvents)
        .set({
          status: "failed",
          ...(definite && !creationWasUncertain
            ? { creationUncertain: false }
            : {}),
          error: error instanceof Error ? error.message : "日程同步失败",
        })
        .where(eq(calendarEvents.id, id))
        .run();
      throw error;
    }
  }
  update(id: number, body: unknown, user: SessionUser) {
    const row = this.own(id, user);
    const p = parse(personalEventSchema, body);
    if (row.status !== "synced" || !row.calendarEventId)
      throw new ConflictException("仅已同步的日程可以修改");
    this.database.db.transaction((tx) => {
      tx.update(calendarEvents)
        .set({
          subject: p.subject,
          description: p.description,
          startAt: p.startAt,
          endAt: p.endAt,
          payloadJson: JSON.stringify(p),
          status: "pending",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(calendarEvents.id, id))
        .run();
      this.enqueue(id, "calendar.provision");
    });
    this.database.addAuditLog("calendar.update", String(id), String(user.id));
    this.database.notifyJobs();
    return { ok: true };
  }
  retry(id: number, user: SessionUser) {
    const row = this.own(id, user);
    if (row.status !== "failed")
      throw new ConflictException("仅失败日程可以重试");
    this.database.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "calendar.provision"),
            inArray(jobs.status, ["queued", "running"]),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .get();
      if (existing?.status === "running")
        throw new ConflictException("任务正在执行");
      if (existing)
        tx.update(jobs)
          .set({ runAt: new Date().toISOString() })
          .where(eq(jobs.id, existing.id))
          .run();
      else this.enqueue(id, "calendar.provision");
      tx.update(calendarEvents)
        .set({ status: "pending", error: null })
        .where(eq(calendarEvents.id, id))
        .run();
    });
    this.database.addAuditLog("calendar.retry", String(id), String(user.id));
    this.database.notifyJobs();
    return { ok: true };
  }
  cancel(id: number, user: SessionUser) {
    const row = this.own(id, user);
    if (row.creationUncertain && !row.calendarEventId)
      throw new ConflictException(
        "飞书创建结果尚未确认，请先重试同步，再取消日程",
      );
    if (row.status === "cancelled") return { ok: true };
    this.database.db.transaction((tx) => {
      const active = tx
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, ["calendar.provision", "calendar.cancel"]),
            eq(jobs.status, "running"),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .get();
      if (active?.type === "calendar.provision")
        throw new ConflictException("日程正在同步，请稍后再取消");
      if (
        active ||
        tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "calendar.cancel"),
              eq(jobs.status, "queued"),
              sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
            ),
          )
          .get()
      )
        return;
      tx.update(jobs)
        .set({
          status: "success",
          error: "日程已取消，创建任务已停止",
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(jobs.type, "calendar.provision"),
            eq(jobs.status, "queued"),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .run();
      tx.update(calendarEvents)
        .set({
          status: "cancelling",
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(calendarEvents.id, id))
        .run();
      this.enqueue(id, "calendar.cancel");
    });
    this.database.addAuditLog("calendar.cancel", String(id), String(user.id));
    this.database.notifyJobs();
    return { ok: true };
  }
  remove(id: number, user: SessionUser) {
    if (user.role === "user")
      throw new ForbiddenException("仅管理员可以删除日程记录");
    const row = this.own(id, user);
    if (row.status !== "cancelled")
      throw new ConflictException("请先取消日程，待飞书取消成功后再删除");
    this.database.db.transaction((tx) => {
      const active = tx
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, ["calendar.provision", "calendar.cancel"]),
            inArray(jobs.status, ["queued", "running"]),
            sql`json_extract(${jobs.payloadJson}, '$.id') = ${id}`,
          ),
        )
        .get();
      if (active) throw new ConflictException("相关任务尚未结束，请稍后删除");
      tx.update(calendarEvents)
        .set({
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(calendarEvents.id, id))
        .run();
      this.database.addAuditLog(
        "calendar.delete",
        JSON.stringify({ id, subject: row.subject }),
        String(user.id),
      );
    });
    return { ok: true };
  }
  async performCancel(id: number) {
    const row = this.database.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .get();
    if (!row || row.status === "cancelled") return;
    if (row.calendarEventId) {
      try {
        await this.registry.calendar(row.connectionId).deleteEvent(row.calendarEventId, row.calendarId!);
      } catch (error: any) {
        if (!["193001", "193003"].includes(error.code)) throw error;
      }
    }
    this.database.db
      .update(calendarEvents)
      .set({ status: "cancelled", error: null })
      .where(eq(calendarEvents.id, id))
      .run();
  }
}
