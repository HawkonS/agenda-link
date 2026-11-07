import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { and, asc, eq, gt, lt, lte, ne, or, sql } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { MeetingService } from "./meeting.service.js";
import { CalendarService } from "./calendar.service.js";
import { RecordingService } from "./recording.service.js";
import { SyncService } from "./sync.service.js";
import { nextSyncAt } from "./sync-policy.js";
import { PlatformConnectionService } from "./platform-connection.service.js";
import {
  jobs,
  meetings,
  recordings,
  syncRuns,
  calendarEvents,
} from "./db/schema.js";
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private cohostTimer?: NodeJS.Timeout;
  private jobTimer?: NodeJS.Timeout;
  private wakeHandle?: NodeJS.Immediate;
  private unsubscribeJobs?: () => void;
  private automatic = false;
  private pendingJobs = false;
  private pendingCohosts = false;
  private busy = false;
  private stopped = false;
  private lastCleanup = 0;
  private readonly logger = new Logger("Worker");
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(MeetingService) private booking: MeetingService,
    @Inject(CalendarService) private calendar: CalendarService,
    @Inject(RecordingService) private recording: RecordingService,
    @Inject(SyncService) private sync: SyncService,
    @Inject(PlatformConnectionService)
    private connections: PlatformConnectionService,
  ) {}
  runtimeStatus() {
    return { enabled: this.automatic && !this.stopped, busy: this.busy };
  }
  onModuleInit() {
    this.database.db
      .update(jobs)
      .set({ status: "queued" })
      .where(eq(jobs.status, "running"))
      .run();
    this.database.db
      .update(meetings)
      .set({
        status: "unknown",
        error: "服务在平台创建过程中中断，请管理员到原平台核对会议结果",
      })
      .where(
        and(
          eq(meetings.provisionStep, "meeting_inflight"),
          sql`${meetings.externalMeetingId} IS NULL`,
        ),
      )
      .run();
    this.database.db
      .update(syncRuns)
      .set({
        status: "failed",
        error: "服务重启中断同步，请重试",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(syncRuns.status, "running"))
      .run();
    if (process.env.AGENDA_LINK_DISABLE_WORKER === "true") return;
    this.automatic = true;
    this.unsubscribeJobs = this.database.onJobsAvailable(() => this.wake());
    this.timer = setInterval(
      () => void this.runOnce(),
      Math.max(5, this.config.getNumber("worker.interval-seconds", 60)) * 1000,
    );
    this.timer.unref();
    this.cohostTimer = setInterval(() => {
      this.pendingCohosts = true;
      this.wake();
    }, 15000);
    this.cohostTimer.unref();
    void this.runOnce();
  }

  private wake() {
    if (!this.automatic || this.stopped) return;
    this.pendingJobs = true;
    if (this.busy || this.wakeHandle) return;
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = undefined;
    // Coalesce notifications and let the HTTP request finish its transaction.
    this.wakeHandle = setImmediate(() => {
      this.wakeHandle = undefined;
      void this.runOnce(false);
    });
    this.wakeHandle.unref();
  }

  private scheduleNextJob() {
    if (!this.automatic || this.stopped) return;
    const next = this.database.db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .orderBy(asc(jobs.runAt))
      .limit(1)
      .get();
    if (!next) return;
    const delay = Date.parse(next.runAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    this.jobTimer = setTimeout(
      () => {
        this.jobTimer = undefined;
        this.wake();
      },
      Math.min(2147483647, Math.max(0, delay)),
    );
    this.jobTimer.unref();
  }

  async runOnce(maintenance = true) {
    if (this.stopped) return;
    if (this.busy) {
      if (this.automatic) this.pendingJobs = true;
      return;
    }
    this.busy = true;
    this.pendingJobs = false;
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = undefined;
    try {
      if (Date.now() - this.lastCleanup > 3_600_000) {
        this.database.cleanupSecurityState();
        this.lastCleanup = Date.now();
      }
      const queued = this.database.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            lte(jobs.runAt, new Date().toISOString()),
          ),
        )
        .orderBy(
          sql`CASE WHEN ${jobs.type} IN ('meeting.cancel','calendar.cancel') THEN 0 WHEN ${jobs.type} IN ('meeting.provision','calendar.provision') THEN 1 ELSE 2 END`,
          asc(jobs.runAt),
          asc(jobs.id),
        )
        .limit(10)
        .all();
      for (const job of queued) {
        if (this.stopped) break;
        const claimed = this.database.db
          .update(jobs)
          .set({
            status: "running",
            attempts: job.attempts + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
          .run();
        if (!claimed.changes) continue;
        const startedAt = performance.now();
        const queueMs = Math.max(0, Date.now() - Date.parse(job.runAt));
        let payload: Record<string, any> = {};
        try {
          const parsed = JSON.parse(job.payloadJson || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("任务数据无效");
          payload = parsed;
          if (
            job.type.startsWith("meeting.") ||
            job.type.startsWith("calendar.") ||
            job.type.startsWith("recording.")
          )
            if (!Number.isSafeInteger(payload.id) || payload.id <= 0)
              throw new Error("任务 ID 无效");
          switch (job.type) {
            case "meeting.provision":
              await this.booking.provision(payload.id);
              this.pendingCohosts = true;
              break;
            case "meeting.cancel":
              await this.booking.performCancel(payload.id);
              break;
            case "calendar.cancel":
              await this.calendar.performCancel(payload.id);
              break;
            case "calendar.provision":
              await this.calendar.provision(payload.id);
              break;
            case "recording.sync": {
              const row = this.database.db
                .select()
                .from(recordings)
                .where(eq(recordings.id, payload.id))
                .get();
              if (row) await this.recording.poll(row);
              break;
            }
            case "recording.delete":
              await this.recording.performDelete(payload.id);
              break;
            case "sync":
              if (payload.scope)
                await this.sync.execute(
                  payload.scope,
                  payload.options,
                  payload.actorId,
                );
              else if(payload.options)await this.sync.execute("all",payload.options,payload.actorId);
              else await this.sync.run(payload.actorId);
              break;
            default:
              throw new Error("未知任务类型");
          }
          this.database.db
            .update(jobs)
            .set({
              status: "success",
              error: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, job.id))
            .run();
          this.logger.log(
            `任务 ${job.id} (${job.type}) 完成，排队 ${queueMs}ms，执行 ${Math.round(performance.now() - startedAt)}ms`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "任务失败";
          const row = payload.id
            ? this.database.db
                .select()
                .from(meetings)
                .where(eq(meetings.id, payload.id))
                .get()
            : undefined;
          const safeRetry =
            job.type.startsWith("calendar.") ||
            job.type === "meeting.cancel" ||
            job.type === "recording.delete" ||
            (job.type === "meeting.provision" &&
              Boolean(row?.externalMeetingId) &&
              row?.status !== "unknown");
          this.database.db
            .update(jobs)
            .set({
              status: safeRetry && job.attempts < 4 ? "queued" : "failed",
              error: message,
              runAt: new Date(
                Date.now() + Math.min(3600, 30 * 2 ** job.attempts) * 1000,
              ).toISOString(),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, job.id))
            .run();
          if (job.type === "meeting.cancel")
            this.database.db
              .update(meetings)
              .set({
                status: job.attempts < 4 ? "cancelling" : "cancel_failed",
                error: message,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(meetings.id, payload.id))
              .run();
          if (job.type === "recording.delete")
            this.database.db
              .update(recordings)
              .set({
                status: job.attempts < 4 ? "deleting" : "delete_failed",
                error: message,
              })
              .where(eq(recordings.id, payload.id))
              .run();
          if (job.type === "calendar.cancel")
            this.database.db
              .update(calendarEvents)
              .set({
                status: job.attempts < 4 ? "cancelling" : "cancel_failed",
                error: message,
              })
              .where(eq(calendarEvents.id, payload.id))
              .run();
          this.logger.warn(
            `任务 ${job.id} (${job.type}) 失败，排队 ${queueMs}ms，执行 ${Math.round(performance.now() - startedAt)}ms：${message}`,
          );
        }
      }
      if (
        this.database.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.status, "queued"),
              lte(jobs.runAt, new Date().toISOString()),
            ),
          )
          .limit(1)
          .get()
      )
        this.pendingJobs = true;
      if (this.pendingJobs) return;
      if (maintenance || this.pendingCohosts) {
        this.pendingCohosts = false;
        await this.checkCohosts();
      }
      // Maintenance keeps its own interval and yields to interactive work.
      if (!maintenance || this.pendingJobs) return;
      const nextSync = nextSyncAt(
        this.sync.policy(),
        this.database.getState("sync.last-attempt") || undefined,
      );
      if (
        nextSync !== null &&
        this.connections.isConfigured(this.sync.policy().sourceConnectionId) &&
        this.connections.isConfigured(this.sync.policy().targetConnectionId) &&
        Date.now() >= nextSync
      ) {
        this.database.setState("sync.last-attempt", new Date().toISOString());
        try {
          await this.sync.run();
        } catch (error) {
          this.logger.warn(
            error instanceof Error ? error.message : "定时同步失败",
          );
        }
      }
      if (this.pendingJobs) return;
      const now = Date.now();
      this.database.db
        .update(meetings)
        .set({ status: "finished" })
        .where(
          and(
            eq(meetings.status, "scheduled"),
            lt(meetings.endAt, new Date(now).toISOString()),
          ),
        )
        .run();
      for (const { recording: r } of this.database.db
        .select({ recording: recordings })
        .from(recordings)
        .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
        .where(
          and(
            sql`${recordings.status} NOT IN ('expired','deleted','deleting','delete_failed','unavailable')`,
            or(
              lte(recordings.expiresAt, new Date(now).toISOString()),
              and(
                lte(meetings.endAt, new Date(now).toISOString()),
                or(
                  sql`${recordings.lastPolledAt} IS NULL`,
                  lte(
                    recordings.lastPolledAt,
                    new Date(now - 300000).toISOString(),
                  ),
                ),
                or(
                  ne(recordings.status, "ready"),
                  sql`${recordings.error} IS NOT NULL`,
                  gt(meetings.endAt, new Date(now - 86400000).toISOString()),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(recordings.lastPolledAt), asc(recordings.id))
        .limit(50)
        .all()) {
        if (this.pendingJobs || this.stopped) return;
        try {
          this.database.db
            .update(recordings)
            .set({ lastPolledAt: new Date(now).toISOString() })
            .where(eq(recordings.id, r.id))
            .run();
          if (r.status === "expired") continue;
          if (r.expiresAt && Date.parse(r.expiresAt) <= now)
            await this.recording.expire(r);
          else if (
            (["scheduled", "processing", "failed"].includes(r.status) ||
              (r.status === "ready" &&
                (Boolean(r.error) ||
                  now -
                    Date.parse(
                      this.database.db
                        .select()
                        .from(meetings)
                        .where(eq(meetings.id, r.meetingId))
                        .get()?.endAt || "1970-01-01",
                    ) <
                    86400000))) &&
            (!r.lastPolledAt || now - Date.parse(r.lastPolledAt) > 300000)
          )
            await this.recording.poll(r);
        } catch (error) {
          this.database.db
            .update(recordings)
            .set({
              error: error instanceof Error ? error.message : "录制处理失败",
            })
            .where(eq(recordings.id, r.id))
            .run();
          this.logger.warn(
            error instanceof Error ? error.message : "录制任务失败",
          );
        }
      }
    } catch (error) {
      this.logger.error(
        "后台任务轮次失败：" +
          (error instanceof Error ? error.name : "unknown"),
      );
    } finally {
      this.busy = false;
      if (this.automatic && !this.stopped) {
        if (this.pendingJobs) this.wake();
        else this.scheduleNextJob();
      }
    }
  }
  private async checkCohosts() {
    const now = new Date().toISOString();
    for (const m of this.database.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.status, "scheduled"),
          eq(meetings.cohostEnabled, true),
          sql`${meetings.deletedAt} IS NULL`,
          lte(meetings.startAt, now),
          gt(meetings.endAt, now),
        ),
      )
      .limit(100)
      .all()) {
      if (this.pendingJobs || this.stopped) return;
      try {
        await this.booking.cohosts(m);
      } catch (error) {
        this.logger.warn(
          `会议 ${m.id} 联席设置失败：${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.unsubscribeJobs?.();
    if (this.timer) clearInterval(this.timer);
    if (this.cohostTimer) clearInterval(this.cohostTimer);
    if (this.jobTimer) clearTimeout(this.jobTimer);
    if (this.wakeHandle) clearImmediate(this.wakeHandle);
    for (let i = 0; i < 100 && this.busy; i++)
      await new Promise((r) => setTimeout(r, 100));
  }
}
