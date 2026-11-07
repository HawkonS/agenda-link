import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  GoneException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  NotFoundException,
} from "@nestjs/common";
import type { FastifyRequest, FastifyReply } from "fastify";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthService, type SessionUser } from "./auth.service.js";
import { DatabaseService } from "./database.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { MeetingService } from "./meeting.service.js";
import { CalendarService } from "./calendar.service.js";
import { RecordingService } from "./recording.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { DirectoryService } from "./directory.service.js";
import {
  PlatformConnectionService,
  type ConnectionKind,
} from "./platform-connection.service.js";
import {
  platformIdentities,
  accountPoolMembers,
  accountPools,
  calendarTemplates,
  departments,
  jobs,
  meetingAccounts,
  meetings,
  recordings,
  syncRules,
  syncRuns,
  userDepartments,
  users,
} from "./db/schema.js";
import { SyncService } from "./sync.service.js";
import { syncPolicyPatchSchema } from "./sync-policy.js";
import { SystemUsersService } from "./system-users.service.js";
import { parse, idSchema, roles, text, email } from "./validation.js";

const managers: SessionUser["role"][] = ["system_admin", "operation_admin"];
const templateSchema = z.object({
  name: text,
  titleTemplate: text,
  descriptionTemplate: z.string().max(10000).optional(),
  locationTemplate: z.string().max(500).optional(),
  reminders: z.array(z.number().int().min(0).max(10080)).max(5).default([10]),
  extensions: z
    .record(z.string().max(100), z.string().max(2000))
    .refine((v) => Object.keys(v).length <= 50, "扩展字段最多 50 项")
    .default({}),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
const ruleSchema = z.object({
  name: text,
  departmentExternalId: z.string().max(100).optional(),
  departmentName: z.string().max(100).optional(),
  meetingUserType: z.enum(["ordinary", "advanced"]).default("advanced"),
  enabled: z.boolean().default(true),
});
const poolSchema = z.object({
  connectionId: z.string().optional(),
  name: text,
  description: z.string().max(2000).optional(),
  accountIds: z.array(idSchema).max(100).default([]),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
const publicAccount = (a: typeof meetingAccounts.$inferSelect) => ({
  providerId: a.providerId,
  connectionId: a.connectionId,
  id: a.id,
  name: a.name,
  accountId: a.accountId,
  status: a.status,
  lastError: a.lastError,
  verifiedAt: a.verifiedAt,
  hasOwnCredentials: Boolean(a.secretId && a.secretKey),
});
@Controller("api")
export class BusinessController {
  constructor(
    @Inject(SyncService) private sync: SyncService,
    @Inject(SystemUsersService) private systemUsers: SystemUsersService,
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(MeetingService) private booking: MeetingService,
    @Inject(CalendarService) private calendar: CalendarService,
    @Inject(RecordingService) private recording: RecordingService,
    @Inject(PlatformRegistry) private registry: PlatformRegistry,
    @Inject(DirectoryService) private directory: DirectoryService,
    @Inject(PlatformConnectionService)
    private connections: PlatformConnectionService,
  ) {}
  private async current(
    request: FastifyRequest,
    allowed?: SessionUser["role"][],
  ) {
    return this.auth.require(request, allowed);
  }
  private id(id: string) {
    return parse(idSchema, id);
  }
  /** 可选分页：limit 1-500，offset 非负；不传 limit 时返回全部。 */
  private page(query: Record<string, string>) {
    const page: { limit?: number; offset?: number } = {};
    if (query.limit !== undefined) {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new BadRequestException("limit 必须是 1-500 的整数");
      page.limit = limit;
    }
    if (query.offset !== undefined) {
      const offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0)
        throw new BadRequestException("offset 必须是非负整数");
      page.offset = offset;
    }
    return page;
  }
  /** 可选的 ISO 时间窗；不传则返回全部，保持旧客户端兼容。 */
  private range(query: Record<string, string>) {
    const result: { from?: string; to?: string } = {};
    for (const key of ["from", "to"] as const) {
      const value = query[key];
      if (!value) continue;
      const time = Date.parse(value);
      if (!Number.isFinite(time))
        throw new BadRequestException("时间范围格式无效");
      result[key] = new Date(time).toISOString();
    }
    if (result.from && result.to && result.from >= result.to)
      throw new BadRequestException("时间范围无效");
    return result;
  }
  /** 自己 / 所有人 / 指定用户；只有运营或系统管理员能看他人。 */
  private owner(
    query: Record<string, string>,
    actor: SessionUser,
  ): "self" | "all" | number | undefined {
    const raw = query.owner;
    if (!raw) return undefined;
    if (raw === "self") return "self";
    if (actor.role === "user")
      throw new ForbiddenException("无权查看他人日程");
    if (raw === "all") return "all";
    return parse(z.coerce.number().int().positive(), raw);
  }
  private participant(query: Record<string, string>): number | undefined {
    const raw = query.participant;
    if (!raw) return undefined;
    return parse(z.coerce.number().int().positive(), raw);
  }
  private audit(action: string, value: unknown, user: SessionUser) {
    this.database.addAuditLog(action, JSON.stringify(value), String(user.id));
  }
  @Get("platforms") async platforms(@Req() request: FastifyRequest) {
    const actor = await this.current(request);
    return this.registry.list(actor.role === "system_admin");
  }
  @Get("directory/connections/:connectionId") async platformDirectory(
    @Req() request: FastifyRequest,
    @Param("connectionId") connectionId: string,
  ) {
    await this.current(request, managers);
    return this.directory.view(connectionId);
  }
  @Post("directory/connections/:connectionId/read") async readPlatformDirectory(
    @Req() request: FastifyRequest,
    @Param("connectionId") connectionId: string,
  ) {
    const actor = await this.current(request, managers);
    return this.directory.read(connectionId, actor.id);
  }
  @Post("directory/connections/:connectionId/import")
  async importPlatformDirectory(
    @Req() request: FastifyRequest,
    @Param("connectionId") connectionId: string,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, managers);
    const body = parse(
      z.object({
        selectedIds: z.array(z.string().min(1).max(300)).max(5000),
        fetchedAt: z.string().min(1),
      }),
      input,
    );
    return this.directory.import(
      connectionId,
      body.selectedIds,
      body.fetchedAt,
      actor.id,
    );
  }
  @Get("booking/options") async bookingOptions(@Req() request: FastifyRequest) {
    await this.current(request);
    return {
      recordingTtlDays: this.database.recordingSettings().ttlDays,
      bookingDefaults: this.database.bookingDefaults(),
      platforms: this.registry.list(),
    };
  }
  @Post("booking/host-preview") async previewHost(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    return this.booking.previewHost(input, await this.current(request));
  }
  @Get("profile") async profile(@Req() request: FastifyRequest) {
    const actor = await this.current(request);
    const row = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, actor.id))
      .get()!;
    const { passwordHash, ...safe } = row;
    return {
      ...safe,
      platformIdentities: this.database.db
        .select({
          providerId: platformIdentities.providerId,
          connectionId: platformIdentities.connectionId,
          externalId: platformIdentities.externalId,
        })
        .from(platformIdentities)
        .where(eq(platformIdentities.userId, actor.id))
        .all(),
    };
  }
  @Patch("profile") async profileUpdate(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request);
    const body = parse(
      z.object({ displayName: text, email: email.optional() }),
      input,
    );
    this.database.db
      .update(users)
      .set({
        ...body,
        email: body.email || null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, actor.id))
      .run();
    this.audit("profile.update", { id: actor.id }, actor);
    return this.profile(request);
  }
  @Post("profile/password") async password(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const actor = await this.current(request);
    const b = parse(
      z.object({
        currentPassword: z.string().max(256),
        newPassword: z.string().min(12).max(256),
      }),
      input,
    );
    const row = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, actor.id))
      .get()!;
    this.auth.protection.check(actor.username, request.ip);
    const verified = await this.auth.verifyPasswordAsync(
      b.currentPassword,
      row.passwordHash,
    );
    if (!row.passwordHash || !verified) {
      this.auth.protection.fail(actor.username, request.ip);
      throw new ForbiddenException("当前密码错误");
    }
    this.auth.protection.success(actor.username, request.ip);
    const passwordHash = await this.auth.hashPasswordAsync(b.newPassword);
    const latest = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, actor.id))
      .get();
    if (
      !latest ||
      latest.passwordHash !== row.passwordHash ||
      latest.status !== "active" ||
      latest.systemAccess !== "allowed"
    )
      throw new ConflictException("账号状态已变更，请重新登录后修改密码");
    this.database.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, actor.id))
      .run();
    this.auth.revokeUser(actor.id);
    response.header("set-cookie", this.auth.cookie("", 0));
    return { ok: true };
  }
  @Get("dashboard/summary") async summary(@Req() request: FastifyRequest) {
    const actor = await this.current(request);
    const personal = this.booking.personal(actor);
    const total = (table: any) =>
      this.database.db
        .select({ count: sql<number>`count(*)` })
        .from(table)
        .get()?.count || 0;
    return {
      users: actor.role === "user" ? 1 : total(users),
      feishuPeople:
        actor.role === "user"
          ? 0
          : this.database.db
              .select({ count: sql<number>`count(*)` })
              .from(platformIdentities)
              .where(
                and(
                  eq(platformIdentities.connectionId, "feishu-directory"),
                  eq(platformIdentities.kind, "person"),
                ),
              )
              .get()?.count || 0,
      departments: actor.role === "user" ? 0 : total(departments),
      accountPools: actor.role === "user" ? 0 : total(accountPools),
      meetings:
        this.database.db
          .select({ count: sql<number>`count(*)` })
          .from(meetings)
          .where(and(personal, ne(meetings.status, "cancelled")))
          .get()?.count || 0,
      recordings:
        this.database.db
          .select({ count: sql<number>`count(*)` })
          .from(recordings)
          .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
          .where(
            and(
              this.booking.visibility(actor),
              ne(meetings.status, "cancelled"),
              eq(recordings.status, "ready"),
              or(
                isNull(recordings.expiresAt),
                gt(recordings.expiresAt, new Date().toISOString()),
              ),
            ),
          )
          .get()?.count || 0,
      upcoming: this.database.db
        .select()
        .from(meetings)
        .where(
          and(
            personal,
            eq(meetings.status, "scheduled"),
            gt(meetings.endAt, new Date().toISOString()),
          ),
        )
        .orderBy(meetings.startAt)
        .limit(5)
        .all()
        .map((row) => ({
          ...this.booking.publicMeeting(row),
          meetingUrl: this.registry.joinUrl(row.meetingUrl, row.connectionId),
          platformName: this.registry.descriptor("meeting", row.connectionId).name,
          capabilities: this.registry.descriptor("meeting", row.connectionId).capabilities,
        })),
    };
  }
  @Get("directory/people") async people(
    @Req() request: FastifyRequest,
    @Query("connectionId") connectionId?: string,
  ) {
    await this.current(request);
    if (!connectionId)
      return this.database.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.status, "active"))
        .all();
    return this.registry
      .meeting(connectionId)
      .listPeople(this.database.db)
      .map(({ email, status, ...p }) => p);
  }
  @Get(["users", "system-users"]) async users(@Req() request: FastifyRequest) {
    await this.current(request, ["system_admin"]);
    const memberships = this.database.db
      .select({
        userId: userDepartments.userId,
        id: departments.id,
        name: departments.name,
      })
      .from(userDepartments)
      .innerJoin(departments, eq(departments.id, userDepartments.departmentId))
      .all();
    const grouped = new Map<number, { id: number; name: string }[]>();
    for (const { userId, id, name } of memberships) {
      const list = grouped.get(userId) || [];
      list.push({ id, name });
      grouped.set(userId, list);
    }
    return this.database.db
      .select()
      .from(users)
      .where(ne(users.systemAccess, "not_added"))
      .all()
      .map(({ passwordHash, ...row }) => ({
        ...row,
        departments: grouped.get(row.id) || [],
      }));
  }
  @Post(["users", "system-users"]) async createUser(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, ["system_admin"]);
    const b = parse(
      z.object({
        username: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_.@-]+$/),
        displayName: text,
        password: z.string().min(12).max(256),
        email: email.optional(),
        phone: z.string().max(30).optional(),
        role: roles.default("user"),
        systemAccess: z.enum(["allowed", "blocked"]).default("allowed"),
      }),
      input,
    );
    if (
      this.database.db
        .select()
        .from(users)
        .where(eq(users.username, b.username))
        .get()
    )
      throw new ConflictException("用户名已存在");
    const { password, ...fields } = b;
    const passwordHash = await this.auth.hashPasswordAsync(password);
    const row = this.database.db
      .insert(users)
      .values({
        ...fields,
        email: b.email || null,
        passwordHash,
      })
      .returning({ id: users.id })
      .get();
    this.audit("user.create", row, actor);
    return row;
  }
  @Patch(["users/:id", "system-users/:id"]) async updateUser(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, ["system_admin"]);
    const target = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, this.id(id)))
      .get();
    if (!target || target.systemAccess === "not_added")
      throw new NotFoundException("系统用户不存在");
    const b = parse(
      z.object({
        displayName: text.optional(),
        email: email.optional(),
        phone: z.string().max(30).optional(),
        role: roles.optional(),
        systemAccess: z.enum(["allowed", "blocked"]).optional(),
        password: z.string().min(12).max(256).optional(),
      }),
      input,
    );
    const { password, ...fields } = b;
    const passwordHash = password
      ? await this.auth.hashPasswordAsync(password)
      : undefined;
    if (
      target.role === "system_admin" &&
      ((b.role && b.role !== "system_admin") || b.systemAccess === "blocked")
    ) {
      const count = this.database.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.role, "system_admin"),
            eq(users.status, "active"),
            eq(users.systemAccess, "allowed"),
          ),
        )
        .all().length;
      if (count <= 1)
        throw new ConflictException("必须保留至少一个可登录的系统管理员");
    }
    this.database.db
      .update(users)
      .set({
        ...fields,
        ...(passwordHash ? { passwordHash } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, target.id))
      .run();
    if (password || b.role || b.systemAccess) this.auth.revokeUser(target.id);
    this.audit("user.update", { id: target.id }, actor);
    return { ok: true };
  }
  @Post("system-users/feishu-preview") async systemUserPreview(
    @Req() request: FastifyRequest,
  ) {
    await this.current(request, ["system_admin"]);
    return this.systemUsers.preview();
  }
  @Post("system-users/feishu-import") async systemUserImport(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, ["system_admin"]);
    const b = parse(
      z.object({
        selectedIds: z.array(z.string().min(1).max(100)).min(1).max(5000),
        role: roles.default("user"),
      }),
      input,
    );
    return this.systemUsers.import(b.selectedIds, b.role, actor.id);
  }
  @Post("system-users/:id/feishu-binding") async bindSystemUser(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, ["system_admin"]);
    const b = parse(
      z.object({ openId: z.string().min(1).max(100).nullable() }),
      input,
    );
    const result = this.systemUsers.bind(this.id(id), b.openId, actor.id);
    this.auth.revokeUser(this.id(id));
    return result;
  }
  @Get("sync/directory") async syncDirectory(
    @Req() request: FastifyRequest,
    @Query("scope") scope: unknown,
  ) {
    await this.current(request, managers);
    return this.sync.view(parse(z.enum(["organization", "users"]), scope));
  }
  @Post("sync/feishu/read") async readDirectory(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, managers);
    const b = parse(
      z.object({ scope: z.enum(["organization", "users"]) }),
      input,
    );
    return this.sync.pull(b.scope, actor.id);
  }
  @Get("sync/policy") async syncPolicy(@Req() request: FastifyRequest) {
    await this.current(request, managers);
    return this.sync.policyView();
  }
  @Patch("sync/policy") async updateSyncPolicy(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, managers);
    const b = parse(syncPolicyPatchSchema, input);
    const result = this.sync.updatePolicy(b);
    this.audit("sync.policy.update", b, actor);
    return result;
  }
  @Post("sync/organization") async syncOrganization(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    return this.queueSync(request, "organization", input);
  }
  @Post("sync/users") async syncUsers(
    @Req() request: FastifyRequest,
    @Body() input: unknown,
  ) {
    return this.queueSync(request, "users", input);
  }
  private async queueSync(
    request: FastifyRequest,
    scope: "organization" | "users",
    input: unknown,
  ) {
    const actor = await this.current(request, managers);
    this.connections.require(this.sync.policy().targetConnectionId);
    const b = parse(
      z.object({
        selectedIds: z.array(z.string().min(1).max(100)).min(1).max(5000),
        overwriteDepartments: z.boolean().default(false),
        overwriteUsers: z.boolean().default(false),
        preserveExistingPermissions: z.boolean().default(true),
        fetchedAt: z.string().optional(),
      }),
      input,
    );
    const preview = this.sync.view(scope);
    const ids =
      scope === "organization"
        ? preview.departments.map((d) => d.open_department_id)
        : preview.people.map((p) => p.open_id);
    const availableIds = new Set(ids);
    if (
      !preview.fetchedAt ||
      (b.fetchedAt && b.fetchedAt !== preview.fetchedAt) ||
      b.selectedIds.some((id) => !availableIds.has(id))
    )
      throw new BadRequestException("请先读取飞书数据并选择预览中的记录");
    const result = this.database.db.transaction(
      (tx) => {
        if (
          tx
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.type, "sync"),
                inArray(jobs.status, ["queued", "running"]),
              ),
            )
            .get()
        )
          throw new ConflictException("同步已排队或运行中");
        const job = tx
          .insert(jobs)
          .values({
            type: "sync",
            payloadJson: JSON.stringify({
              scope,
              options: {
                ...this.sync.policy(),
                ...b,
                fetchedAt: preview.fetchedAt,
              },
              actorId: actor.id,
            }),
            runAt: new Date().toISOString(),
          })
          .returning()
          .get();
        this.audit("sync.queued", { id: job.id, scope, ...b }, actor);
        return { id: job.id, status: "queued" };
      },
      { behavior: "immediate" },
    );
    this.database.notifyJobs();
    return result;
  }
  @Patch("sync/people/:id") async updateDirectoryPerson(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const actor = await this.current(request, managers);
    return this.sync.updatePerson(this.id(id), input, actor.id);
  }
  @Get("departments") async departments(@Req() request: FastifyRequest) {
    await this.current(request);
    return this.database.db.select().from(departments).all();
  }
  @Get("sync/runs") async syncRuns(@Req() request: FastifyRequest) {
    await this.current(request, managers);
    return this.database.db
      .select()
      .from(syncRuns)
      .orderBy(desc(syncRuns.id))
      .limit(100)
      .all();
  }
  @Get("sync/rules") async rules(@Req() request: FastifyRequest) {
    await this.current(request, managers);
    return this.database.db.select().from(syncRules).all();
  }
  @Post("sync/rules") async addRule(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ) {
    const u = await this.current(request, managers);
    const b = parse(ruleSchema, body);
    const row = this.database.db.insert(syncRules).values(b).returning().get();
    this.audit("sync.rule.create", { id: row.id }, u);
    return row;
  }
  @Patch("sync/rules/:id") async editRule(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(request, managers);
    this.database.db
      .update(syncRules)
      .set(parse(ruleSchema, body))
      .where(eq(syncRules.id, this.id(id)))
      .run();
    this.audit("sync.rule.update", { id }, u);
    return { ok: true };
  }
  @Delete("sync/rules/:id") async deleteRule(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(request, managers);
    this.database.db
      .delete(syncRules)
      .where(eq(syncRules.id, this.id(id)))
      .run();
    this.audit("sync.rule.delete", { id }, u);
    return { ok: true };
  }
  @Post("sync/run") async runSync(@Req() request: FastifyRequest) {
    const u = await this.current(request, managers);
    this.connections.require(this.sync.policy().sourceConnectionId);
    this.connections.require(this.sync.policy().targetConnectionId);
    const result = this.database.db.transaction((tx) => {
      if (
        tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "sync"),
              inArray(jobs.status, ["queued", "running"]),
            ),
          )
          .get()
      )
        throw new ConflictException("同步已排队或运行中");
      const job = tx
        .insert(jobs)
        .values({
          type: "sync",
          payloadJson: JSON.stringify({
            actorId: u.id,
            options: this.sync.policy(),
          }),
          runAt: new Date().toISOString(),
        })
        .returning()
        .get();
      this.audit("sync.queued", { id: job.id }, u);
      return { id: job.id, status: "queued" };
    });
    this.database.notifyJobs();
    return result;
  }
  @Get("account-pools") async pools(@Req() request: FastifyRequest) {
    const u = await this.current(request);
    return this.database.db
      .select()
      .from(accountPools)
      .all()
      .filter((p) => u.role !== "user" || p.enabled)
      .map((p) =>
        u.role === "user"
          ? {
              id: p.id,
              name: p.name,
              isDefault: p.isDefault,
              connectionId: p.connectionId,
              providerId: p.providerId,
            }
          : {
              ...p,
              members: this.database.db
                .select({
                  id: meetingAccounts.id,
                  name: meetingAccounts.name,
                  accountId: meetingAccounts.accountId,
                  status: meetingAccounts.status,
                })
                .from(accountPoolMembers)
                .innerJoin(
                  meetingAccounts,
                  eq(meetingAccounts.id, accountPoolMembers.accountId),
                )
                .where(eq(accountPoolMembers.poolId, p.id))
                .all(),
            },
      );
  }
  private writePool(body: unknown, id?: number) {
    const b = parse(poolSchema, body);
    const ids = [...new Set(b.accountIds)];
    const old = id
      ? this.database.db
          .select()
          .from(accountPools)
          .where(eq(accountPools.id, id))
          .get()
      : undefined;
    const component = this.registry.select(
      "meeting",
      old?.connectionId || b.connectionId,
    );
    if (!component.capabilities.accountPool)
      throw new BadRequestException("此组件不支持账号池");
    for (const id of ids) {
      const account = this.database.db
        .select()
        .from(meetingAccounts)
        .where(eq(meetingAccounts.id, id))
        .get();
      if (!account || account.connectionId !== component.connectionId)
        throw new BadRequestException("账号池成员必须属于同一连接");
      if (!account.verifiedAt)
        throw new BadRequestException("请先验证所有成员账号的高级许可");
    }
    return this.database.db.transaction((tx) => {
      let poolId = id;
      const isDefault = b.enabled && b.isDefault;
      if (isDefault)
        tx.update(accountPools)
          .set({ isDefault: false })
          .where(
            and(
              eq(accountPools.isDefault, true),
              eq(accountPools.connectionId, component.connectionId),
            ),
          )
          .run();
      if (id) {
        if (
          !tx.select().from(accountPools).where(eq(accountPools.id, id)).get()
        )
          throw new NotFoundException("账号池不存在");
        tx.update(accountPools)
          .set({
            providerId: component.providerId,
            connectionId: component.connectionId,
            name: b.name,
            description: b.description,
            enabled: b.enabled,
            isDefault,
          })
          .where(eq(accountPools.id, id))
          .run();
        tx.delete(accountPoolMembers)
          .where(eq(accountPoolMembers.poolId, id))
          .run();
      } else
        poolId = tx
          .insert(accountPools)
          .values({
            providerId: component.providerId,
            connectionId: component.connectionId,
            name: b.name,
            description: b.description,
            enabled: b.enabled,
            isDefault,
          })
          .returning()
          .get().id;
      for (const accountId of ids)
        tx.insert(accountPoolMembers)
          .values({ poolId: poolId!, accountId })
          .run();
      return { id: poolId };
    });
  }
  @Post("account-pools") async addPool(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, managers);
    const row = this.writePool(body);
    this.audit("pool.create", row, u);
    return row;
  }
  @Patch("account-pools/:id") async editPool(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, managers);
    const row = this.writePool(body, this.id(id));
    this.audit("pool.update", row, u);
    return row;
  }
  @Delete("account-pools/:id") async deletePool(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, managers);
    if (
      this.database.db
        .select()
        .from(meetings)
        .where(eq(meetings.accountPoolId, this.id(id)))
        .get()
    )
      throw new ConflictException("该账号池有会议记录，请停用而非删除");
    this.database.db
      .delete(accountPools)
      .where(eq(accountPools.id, this.id(id)))
      .run();
    this.audit("pool.delete", { id }, u);
    return { ok: true };
  }
  @Get("meeting-accounts") async accounts(@Req() req: FastifyRequest) {
    await this.current(req, managers);
    return this.database.db
      .select()
      .from(meetingAccounts)
      .all()
      .map(publicAccount);
  }
  @Get("meeting-accounts/platform/:connectionId") async platformAccountPreview(
    @Param("connectionId") connectionId: string,
    @Req() req: FastifyRequest,
  ) {
    await this.current(req, managers);
    const accounts = this.registry.meeting(connectionId).accounts;
    if (!accounts) throw new BadRequestException("此组件不支持账号导入");
    return accounts.preview();
  }
  @Post("meeting-accounts/platform/:connectionId/import")
  async importPlatformAccounts(
    @Param("connectionId") connectionId: string,
    @Req() req: FastifyRequest,
    @Body() input: unknown,
  ) {
    const actor = await this.current(req, managers);
    const b = parse(
      z.object({
        accountIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
        poolId: idSchema.optional(),
      }),
      input,
    );
    const accounts = this.registry.meeting(connectionId).accounts;
    if (!accounts) throw new BadRequestException("此组件不支持账号导入");
    return accounts.import(b.accountIds, b.poolId, actor.id);
  }
  @Post("meeting-accounts") async addAccount(
    @Req() req: FastifyRequest,
    @Body() input: unknown,
  ) {
    const u = await this.current(req, managers);
    const b = parse(
      z.object({
        connectionId: z.string().optional(),
        name: text,
        accountId: text,
        secretId: z.string().max(500).optional(),
        secretKey: z.string().max(500).optional(),
      }),
      input,
    );
    const component = this.registry.select("meeting", b.connectionId);
    if (!component.capabilities.accountPool)
      throw new BadRequestException("此组件不使用账号池");
    if (Boolean(b.secretId) !== Boolean(b.secretKey))
      throw new BadRequestException(
        "独立凭据需要同时填写 Secret ID 和 Secret Key",
      );
    if (
      this.database.db
        .select()
        .from(meetingAccounts)
        .where(
          and(
            eq(meetingAccounts.accountId, b.accountId),
            eq(meetingAccounts.connectionId, component.connectionId),
          ),
        )
        .get()
    )
      throw new ConflictException("账号已存在");
    const row = this.database.db
      .insert(meetingAccounts)
      .values({
        ...b,
        providerId: component.providerId,
        connectionId: component.connectionId,
        secretKey: b.secretKey ? this.config.encrypt(b.secretKey) : null,
        status: "disabled",
      })
      .returning()
      .get();
    this.audit("account.create", { id: row.id }, u);
    return publicAccount(row);
  }
  @Patch("meeting-accounts/:id") async editAccount(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const u = await this.current(req, managers);
    const b = parse(
      z.object({
        name: text.optional(),
        status: z.enum(["available", "disabled"]).optional(),
        secretId: z.string().max(500).optional(),
        secretKey: z.string().max(500).optional(),
      }),
      input,
    );
    const row = this.database.db
      .select()
      .from(meetingAccounts)
      .where(eq(meetingAccounts.id, this.id(id)))
      .get();
    if (!row) throw new NotFoundException("账号不存在");
    if (b.status === "available" && !row.verifiedAt)
      throw new BadRequestException("请先测试账号并验证高级许可");
    if ((b.secretId === undefined) !== (b.secretKey === undefined))
      throw new BadRequestException("请同时提供两项凭据");
    const { secretKey, ...fields } = b;
    this.database.db
      .update(meetingAccounts)
      .set({
        ...fields,
        ...(secretKey !== undefined
          ? {
              secretKey: secretKey ? this.config.encrypt(secretKey) : null,
              verifiedAt: null,
              status: "disabled",
            }
          : {}),
      })
      .where(eq(meetingAccounts.id, row.id))
      .run();
    this.audit("account.update", { id }, u);
    return { ok: true };
  }
  @Post("meeting-accounts/:id/test") async testAccount(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, managers);
    const row = this.database.db
      .select()
      .from(meetingAccounts)
      .where(eq(meetingAccounts.id, this.id(id)))
      .get();
    if (!row) throw new NotFoundException("账号不存在");
    try {
      const result = await this.registry
        .meeting(row.connectionId)
        .verifyAccount(row);
      this.database.db
        .update(meetingAccounts)
        .set({
          status: "available",
          verifiedAt: new Date().toISOString(),
          lastError: null,
        })
        .where(eq(meetingAccounts.id, row.id))
        .run();
      this.audit("account.verified", { id }, u);
      return result;
    } catch (error) {
      this.database.db
        .update(meetingAccounts)
        .set({
          status: "error",
          verifiedAt: null,
          lastError: error instanceof Error ? error.message : "验证失败",
        })
        .where(eq(meetingAccounts.id, row.id))
        .run();
      throw error;
    }
  }
  @Delete("meeting-accounts/:id") async deleteAccount(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, managers);
    if (
      this.database.db
        .select()
        .from(meetings)
        .where(eq(meetings.meetingAccountId, this.id(id)))
        .get()
    )
      throw new ConflictException("账号有会议历史，请停用而非删除");
    this.database.db
      .delete(meetingAccounts)
      .where(eq(meetingAccounts.id, this.id(id)))
      .run();
    this.audit("account.delete", { id }, u);
    return { ok: true };
  }
  @Get("calendar-templates") async templates(@Req() req: FastifyRequest) {
    const u = await this.current(req);
    return this.database.db
      .select()
      .from(calendarTemplates)
      .all()
      .filter((t) => u.role !== "user" || t.enabled);
  }
  private templateValues(body: unknown) {
    const b = parse(templateSchema, body);
    const { extensions, reminders, ...rest } = b;
    return {
      ...rest,
      isDefault: b.enabled && b.isDefault,
      extensionsJson: JSON.stringify(extensions),
      remindersJson: JSON.stringify(reminders),
    };
  }
  @Post("calendar-templates") async addTemplate(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, managers);
    const row = this.database.db.transaction((tx) => {
      const values = this.templateValues(body);
      if (values.isDefault)
        tx.update(calendarTemplates)
          .set({ isDefault: false })
          .where(eq(calendarTemplates.isDefault, true))
          .run();
      return tx.insert(calendarTemplates).values(values).returning().get();
    });
    this.audit("template.create", { id: row.id }, u);
    return row;
  }
  @Patch("calendar-templates/:id") async editTemplate(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, managers);
    this.database.db.transaction((tx) => {
      const values = this.templateValues(body);
      if (values.isDefault)
        tx.update(calendarTemplates)
          .set({ isDefault: false })
          .where(eq(calendarTemplates.isDefault, true))
          .run();
      tx.update(calendarTemplates)
        .set(values)
        .where(eq(calendarTemplates.id, this.id(id)))
        .run();
    });
    this.audit("template.update", { id }, u);
    return { ok: true };
  }
  @Post("calendar-templates/:id/default") async defaultTemplate(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, managers);
    const templateId = this.id(id);
    this.database.db.transaction((tx) => {
      const row = tx
        .select()
        .from(calendarTemplates)
        .where(eq(calendarTemplates.id, templateId))
        .get();
      if (!row) throw new NotFoundException("日程模板不存在");
      if (!row.enabled) throw new BadRequestException("请先启用此模板");
      tx.update(calendarTemplates)
        .set({ isDefault: false })
        .where(eq(calendarTemplates.isDefault, true))
        .run();
      tx.update(calendarTemplates)
        .set({ isDefault: true })
        .where(eq(calendarTemplates.id, templateId))
        .run();
    });
    this.audit("template.default", { id: templateId }, u);
    return { ok: true };
  }
  @Delete("calendar-templates/:id") async deleteTemplate(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, managers);
    if (
      this.database.db
        .select()
        .from(meetings)
        .where(eq(meetings.calendarTemplateId, this.id(id)))
        .get()
    )
      throw new ConflictException("模板有会议历史，请停用");
    this.database.db
      .delete(calendarTemplates)
      .where(eq(calendarTemplates.id, this.id(id)))
      .run();
    this.audit("template.delete", { id }, u);
    return { ok: true };
  }
  @Get("meetings") async meetings(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.current(req),
      range = this.range(query),
      page = this.page(query),
      owner = this.owner(query, actor),
      participant = this.participant(query);
    if (page.limit !== undefined)
      reply.header(
        "X-Total-Count",
        String(this.booking.count(actor, range, owner, participant)),
      );
    return this.booking.list(actor, range, page, owner, participant);
  }
  @Get("meetings/:id") async detail(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.booking.calendarDetail(this.id(id), await this.current(req));
  }
  @Get("meetings/:id/recordings") async meetingRecordings(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.recording.forMeeting(this.id(id), await this.current(req));
  }
  @Post("meetings") async createMeeting(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const u = await this.current(req);
    return this.booking.reserve(
      body,
      String(req.headers["idempotency-key"] || ""),
      u,
    );
  }
  @Patch("meetings/:id/schedule") async rescheduleMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({ startAt: text, endAt: text }),
      body,
    );
    return this.booking.reschedule(this.id(id), b, await this.current(req));
  }
  @Patch("meetings/:id") async updateMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        subject: text,
        description: z.string().optional(),
        startAt: text,
        endAt: text,
        attendeeIds: z.array(z.number().int().positive()).default([]),
        attendeeEmails: z.array(z.string()).default([]),
        calendarTemplateId: z.number().int().positive().nullable().optional(),
        recordingEnabled: z.boolean().default(false),
        recordingTtlDays: z.number().int().positive().optional(),
      }),
      body,
    );
    return this.booking.updateMeeting(
      this.id(id),
      b,
      await this.current(req),
    );
  }
  @Post("meetings/:id/finish") async finishMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.booking.finish(this.id(id), await this.current(req));
  }
  @Post("meetings/:id/cancel") async cancelMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.booking.cancel(this.id(id), await this.current(req));
  }
  @Delete("meetings/:id") async deleteMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.booking.remove(this.id(id), await this.current(req, managers));
  }
  @Post("meetings/:id/retry") async retryMeeting(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.booking.retry(this.id(id), await this.current(req));
  }
  @Post("meetings/:id/reconcile") async reconcile(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, ["system_admin"]);
    const b = parse(z.object({ externalMeetingId: text }), body);
    return this.booking.reconcile(this.id(id), b.externalMeetingId, u);
  }
  @Post("meetings/:id/release") async release(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, ["system_admin"]);
    parse(z.object({ confirmedNotCreated: z.literal(true) }), body);
    return this.booking.release(this.id(id), u);
  }
  @Get("calendar-owners") async calendarOwners(@Req() req: FastifyRequest) {
    await this.auth.require(req, managers);
    return this.database.connection
      .prepare(
        `SELECT u.id,
                u.display_name AS name,
                u.username AS username,
                (SELECT count(*) FROM meetings m WHERE m.created_by=u.id AND m.deleted_at IS NULL) +
                (SELECT count(*) FROM calendar_events c WHERE c.created_by=u.id AND c.deleted_at IS NULL) AS count
         FROM users u
         WHERE u.status='active'
         ORDER BY u.display_name`,
      )
      .all() as { id: number; name: string; username: string; count: number }[];
  }
  @Get("calendar-events") async events(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = await this.current(req),
      range = this.range(query),
      page = this.page(query),
      owner = this.owner(query, actor),
      participant = this.participant(query);
    if (page.limit !== undefined)
      reply.header(
        "X-Total-Count",
        String(this.calendar.count(actor, range, owner, participant)),
      );
    return this.calendar.list(actor, range, page, owner, participant);
  }
  @Get("calendar-events/:id") async eventDetail(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.calendar.detail(this.id(id), await this.current(req));
  }
  @Post("calendar-events") async addEvent(@Req() req: FastifyRequest) {
    await this.current(req);
    throw new GoneException(
      "独立日程预约已停用，请刷新页面，使用会议预约选择平台及关联日程。",
    );
  }
  @Patch("calendar-events/:id") async editEvent(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.calendar.update(this.id(id), body, await this.current(req));
  }
  @Post("calendar-events/:id/cancel") async cancelEvent(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.calendar.cancel(this.id(id), await this.current(req));
  }
  @Delete("calendar-events/:id") async deleteEvent(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.calendar.remove(this.id(id), await this.current(req, managers));
  }
  @Post("calendar-events/:id/retry") async retryEvent(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.calendar.retry(this.id(id), await this.current(req));
  }
  @Get("recordings") async recordings(@Req() req: FastifyRequest) {
    return this.recording.list(await this.current(req));
  }
  @Get("recordings/:id/download") async download(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Query("fileId") fileId: string,
  ) {
    return this.recording.download(
      this.id(id),
      parse(text, fileId),
      await this.current(req),
    );
  }
  @Post("recordings/:id/retry") async retryRecording(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.recording.retry(this.id(id), await this.current(req, managers));
  }
  @Delete("recordings/:id") async deleteRecording(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    return this.recording.delete(
      this.id(id),
      await this.current(req, ["system_admin"]),
    );
  }
  @Get("system/settings") async settings(@Req() req: FastifyRequest) {
    await this.current(req, ["system_admin"]);
    return {
      values: this.config.settings(),
      databasePath: this.config.databasePath,
      connections: this.connections.all(),
      recording: this.database.recordingSettings(),
    };
  }

  @Get("platform-connections") async platformConnections(
    @Req() req: FastifyRequest,
  ) {
    await this.current(req, ["system_admin"]);
    return this.connections.all();
  }

  @Patch("platform-connections/:kind") async updatePlatformConnection(
    @Req() req: FastifyRequest,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, ["system_admin"]);
    this.connections.definition(kind);
    const values = parse(
      z.record(
        z.string(),
        z.union([z.string().max(1000), z.number(), z.boolean()]),
      ),
      body,
    );
    const result = this.connections.update(kind as ConnectionKind, values);
    this.audit("platform.connection.update", { kind }, u);
    return result;
  }

  @Post("platform-connections/:kind/test") async testPlatformConnection(
    @Req() req: FastifyRequest,
    @Param("kind") kind: string,
  ) {
    const u = await this.current(req, ["system_admin"]);
    const result = await this.registry.test(kind);
    this.audit("platform.connection.test", { kind }, u);
    return result;
  }
  @Patch("system/settings") async saveSettings(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const u = await this.current(req, ["system_admin"]);
    const input = parse(
      z
        .object({
          revision: z.string().length(64),
          values: z.record(z.string(), z.string().max(10000)),
        })
        .strict(),
      body,
    );
    const allowed = Object.keys(this.config.configuration().values);
    if (Object.keys(input.values).some((k) => !allowed.includes(k)))
      throw new BadRequestException("包含不可修改的配置键");
    const result = await this.config.updateConfiguration(
      input.values,
      input.revision,
    );
    this.audit("system.configuration", { keys: Object.keys(input.values) }, u);
    return {
      ...result,
      ok: true,
      restartRequired: result.pendingRestart.length > 0,
    };
  }

  @Post("connections/:platform/test") async connectionTest(
    @Req() req: FastifyRequest,
    @Param("platform") platform: string,
  ) {
    await this.current(req, managers);
    const connection = this.registry.components.find(
      (c) => c.providerId === platform || c.connectionId === platform,
    );
    if (!connection) throw new BadRequestException("未知平台");
    return this.registry.test(connection.connectionId);
  }
  @Post("system/jobs/:id/retry") async retryJob(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const u = await this.current(req, ["system_admin"]);
    const job = this.database.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, this.id(id)))
      .get();
    if (!job || job.status !== "failed")
      throw new BadRequestException("仅失败任务可以重试");
    if (job.type === "meeting.provision")
      return this.booking.retry(JSON.parse(job.payloadJson!).id, u);
    if (job.type === "meeting.cancel")
      return this.booking.cancel(JSON.parse(job.payloadJson!).id, u);
    if (job.type === "calendar.provision")
      return this.calendar.retry(JSON.parse(job.payloadJson!).id, u);
    if (job.type === "calendar.cancel")
      return this.calendar.cancel(JSON.parse(job.payloadJson!).id, u);
    if (job.type !== "sync") throw new BadRequestException("此任务不能重试");
    if (
      this.database.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "sync"),
            inArray(jobs.status, ["queued", "running"]),
          ),
        )
        .get()
    )
      throw new ConflictException("已有同步任务在排队或执行");
    this.database.db
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        error: null,
        runAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, job.id))
      .run();
    this.audit("job.retry", { id }, u);
    this.database.notifyJobs();
    return { ok: true };
  }
}
