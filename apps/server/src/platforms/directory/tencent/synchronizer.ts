import { createHash } from "node:crypto";
import { loginSharesFeishuTenant } from "../../shared/feishu/identity.js";
import { parse, email } from "../../../validation.js";
import { z } from "zod";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ConfigurationService } from "../../../config/configuration.service.js";
import { DatabaseService } from "../../../database.service.js";
import {
  FeishuAdapter,
  type DirectoryDepartment,
  type DirectoryPerson,
} from "../../shared/feishu/client.js";
import { TencentAdapter } from "../../shared/tencent/client.js";
import { feishuAvatarUrl } from "../../shared/feishu/avatar.js";
import { tencentPhoneKey } from "../../shared/tencent/phone.js";
import type { PlatformConnectionService } from "../../../platform-connection.service.js";
import {
  syncPolicySchema,
  nextSyncAt,
  type SyncPolicy,
} from "../../../sync-policy.js";
import {
  departments,
  users,
  userDepartments,
  syncRules,
  platformIdentities,
  syncRuns,
  meetingAccounts,
} from "../../../db/schema.js";
export type SyncScope = "organization" | "users";
export type SyncOptions = {
  selectedIds?: string[];
  fetchedAt?: string;
  overwriteDepartments?: boolean;
  overwriteUsers?: boolean;
  preserveExistingPermissions?: boolean;
  disableMissingUsers?: boolean;
  /** Only the scheduled job may skip when the Feishu snapshot is unchanged. */
  skipUnchanged?: boolean;
};
type Snapshot = {
  appId: string;
  fetchedAt: string;
  departments: DirectoryDepartment[];
  people: DirectoryPerson[];
};
@Injectable()
export class FeishuTencentSync {
  private running = false;
  private pulling = false;
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(FeishuAdapter) private feishu: FeishuAdapter,
    @Inject(TencentAdapter) private tencent: TencentAdapter,
    @Inject("PlatformConnectionService")
    private connections: PlatformConnectionService,
  ) {}
  policy(): SyncPolicy {
    return syncPolicySchema.parse(
      JSON.parse(this.database.getState("sync.policy") || "{}"),
    );
  }

  policyView() {
    const policy = this.policy();
    const lastAttemptAt = this.database.getState("sync.last-attempt");
    const next = nextSyncAt(policy, lastAttemptAt || undefined);
    return {
      ...policy,
      lastAttemptAt: lastAttemptAt || null,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
    };
  }
  updatePolicy(patch: Partial<SyncPolicy>) {
    const previous = this.policy();
    const next = syncPolicySchema.parse({ ...previous, ...patch });
    const scheduleChanged =
      previous.automaticMode !== next.automaticMode ||
      previous.intervalMinutes !== next.intervalMinutes ||
      previous.dailyTime !== next.dailyTime;
    this.database.db.transaction(() => {
      this.database.setState("sync.policy", JSON.stringify(next));
      if (scheduleChanged)
        this.database.setState("sync.last-attempt", new Date().toISOString());
    });
    return this.policyView();
  }
  private snapshot(scope: SyncScope): Snapshot {
    const raw = this.database.getState("sync.snapshot." + scope);
    if (!raw)
      throw new BadRequestException(
        "请先从飞书读取" + (scope === "users" ? "用户" : "组织架构"),
      );
    const result = JSON.parse(raw) as Snapshot;
    if (
      result.appId !==
      String(this.connections.require("feishu-directory").appId)
    )
      throw new BadRequestException("飞书同步应用已变更，请重新读取数据");
    return result;
  }
  view(scope: SyncScope) {
    const raw = this.database.getState("sync.snapshot." + scope);
    if (!raw) return { fetchedAt: null, departments: [], people: [] };
    const snapshot = JSON.parse(raw) as Snapshot;
    if (
      snapshot.appId !==
      String(this.connections.get("feishu-directory").appId || "")
    )
      return { fetchedAt: null, departments: [], people: [] };
    const localDepartments = new Map(
      this.database.db
        .select()
        .from(departments)
        .where(eq(departments.connectionId, "feishu-directory"))
        .all()
        .map((d) => [d.externalId, d]),
    );
    const scopedPeople = this.database.db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.connectionId, "feishu-directory"),
          eq(platformIdentities.kind, "person"),
        ),
      )
      .all()
      .map((i) => {
        const p = i.userId
          ? this.database.db
              .select()
              .from(users)
              .where(eq(users.id, i.userId))
              .get()
          : undefined;
        return {
          ...p,
          feishuUserId: i.stableId,
          feishuOpenId: i.externalId,
          tencentUserId: p ? this.tencentIdentity(p.id)?.externalId : null,
          meetingUserType: p ? this.license(p.id) : "ordinary",
        };
      });
    const byUserId = new Map(
      scopedPeople
        .filter((p) => p.feishuUserId)
        .map((p) => [p.feishuUserId, p]),
    );
    const byOpenId = new Map(
      scopedPeople
        .filter((p) => p.feishuOpenId)
        .map((p) => [p.feishuOpenId, p]),
    );
    const departmentNames = new Map(
      snapshot.departments.map((d) => [d.open_department_id, d.name]),
    );
    return {
      fetchedAt: snapshot.fetchedAt,
      departments: snapshot.departments.map((d) => ({
        ...d,
        ...localDepartments.get(d.open_department_id),
      })),
      people: snapshot.people.map((p) => {
        const row =
          (p.user_id ? byUserId.get(p.user_id) : undefined) ||
          byOpenId.get(p.open_id);
        return {
          ...p,
          avatarUrl: feishuAvatarUrl(p) || row?.avatarUrl || null,
          id: row?.id,
          phone: row?.phone,
          tencentUserId: row?.tencentUserId,
          meetingUserType: row?.meetingUserType,
          syncError: row?.syncError,
          departmentNames: p.department_ids.map(
            (id) => departmentNames.get(id) || id,
          ),
        };
      }),
    };
  }
  private license(userId: number): "ordinary" | "advanced" {
    const identity = this.database.db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.connectionId, "tencent-meeting"),
          eq(platformIdentities.kind, "person"),
          eq(platformIdentities.userId, userId),
        ),
      )
      .get();
    return JSON.parse(identity?.profileJson || "{}").providerData?.advanced
      ? "advanced"
      : "ordinary";
  }
  private saveIdentity(
    providerId: string,
    connectionId: string,
    externalId: string,
    userId: number,
    name: string,
    profile: unknown,
    stableId?: string,
  ) {
    this.database.db
      .insert(platformIdentities)
      .values({
        providerId,
        connectionId,
        externalId,
        userId,
        name,
        profileJson: JSON.stringify(profile),
        stableId,
        kind: "person",
      })
      .onConflictDoUpdate({
        target: [
          platformIdentities.connectionId,
          platformIdentities.kind,
          platformIdentities.externalId,
        ],
        set: {
          userId,
          name,
          profileJson: JSON.stringify(profile),
          stableId,
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }
  private tencentIdentity(userId: number) {
    return this.database.db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.connectionId, "tencent-meeting"),
          eq(platformIdentities.kind, "person"),
          eq(platformIdentities.userId, userId),
        ),
      )
      .get();
  }
  private person(p: DirectoryPerson) {
    const identity = this.database.db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.connectionId, "feishu-directory"),
          eq(platformIdentities.kind, "person"),
          eq(platformIdentities.externalId, p.open_id),
        ),
      )
      .get();
    const row = identity?.userId
      ? this.database.db
          .select()
          .from(users)
          .where(eq(users.id, identity.userId))
          .get()
      : p.user_id &&
          loginSharesFeishuTenant(
            this.config,
            this.database,
            "feishu-directory",
          )
        ? this.database.db
            .select()
            .from(users)
            .where(eq(users.feishuUserId, p.user_id))
            .get()
        : undefined;
    return row
      ? {
          ...row,
          tencentUserId: this.tencentIdentity(row.id)?.externalId || null,
        }
      : undefined;
  }
  private store(source: Snapshot, includePeople: boolean) {
    const now = source.fetchedAt;
    const map = new Map(
      source.departments.map((d) => [d.open_department_id, d]),
    );
    const path = (d: DirectoryDepartment, seen = new Set<string>()): string => {
      if (seen.size >= 100)
        throw new BadRequestException("组织结构层级超过 100 层，无法处理");
      if (seen.has(d.open_department_id))
        throw new BadRequestException("组织结构存在循环");
      seen.add(d.open_department_id);
      const parent = map.get(d.parent_department_id);
      return parent ? path(parent, seen) + "/" + d.name : d.name;
    };
    // Build paths before changing local data; a partial/invalid read never replaces the preview.
    const paths = new Map(
      source.departments.map((d) => [d.open_department_id, path(d)]),
    );
    this.database.db.transaction((tx) => {
      for (const d of source.departments)
        tx.insert(departments)
          .values({
            externalId: d.open_department_id,
            name: d.name,
            parentExternalId: d.parent_department_id,
            path: paths.get(d.open_department_id),
          })
          .onConflictDoUpdate({
            target: [departments.connectionId, departments.externalId],
            set: {
              name: d.name,
              parentExternalId: d.parent_department_id,
              path: paths.get(d.open_department_id),
              updatedAt: now,
            },
          })
          .run();
      if (!includePeople) return;
      for (const p of source.people) {
        const old = this.person(p);
        const fields = {
          displayName: p.name,
          avatarUrl: feishuAvatarUrl(p) || old?.avatarUrl || null,
          email: p.email || old?.email || null,
          phone: p.mobile || old?.phone || null,
          source: "feishu",
          lastSeenAt: now,
          status: (p.status?.is_resigned || p.status?.is_frozen
            ? "disabled"
            : "active") as "active" | "disabled",
          updatedAt: now,
        };
        const row = old
          ? tx
              .update(users)
              .set(fields)
              .where(eq(users.id, old.id))
              .returning()
              .get()!
          : tx
              .insert(users)
              .values({
                ...fields,
                username: "feishu:" + p.open_id,
                systemAccess: "not_added",
              })
              .returning()
              .get();
        this.saveIdentity(
          "feishu",
          "feishu-directory",
          p.open_id,
          row.id,
          p.name,
          p,
          p.user_id,
        );
        tx.delete(userDepartments)
          .where(eq(userDepartments.userId, row.id))
          .run();
        for (const depId of [...new Set(p.department_ids)]) {
          const dep = tx
            .select()
            .from(departments)
            .where(
              and(
                eq(departments.externalId, depId),
                eq(departments.connectionId, "feishu-directory"),
              ),
            )
            .get();
          if (dep)
            tx.insert(userDepartments)
              .values({ userId: row.id, departmentId: dep.id })
              .run();
        }
      }
    });
  }
  async pull(scope: SyncScope, actorId?: number) {
    // 读取只写快照，不阻塞正在写腾讯的同步任务；只防止两次读取互相覆盖。
    if (this.pulling)
      throw new ConflictException("正在读取通讯录，请稍候再试");
    this.pulling = true;
    try {
      return await this.pullSource(scope, actorId);
    } catch (e) {
      this.database.addAuditLog(
        "sync.feishu.read.failed",
        JSON.stringify({
          scope,
          message: (e instanceof Error ? e.message : "读取失败").slice(0, 500),
        }),
        actorId ? String(actorId) : "worker",
      );
      throw e;
    } finally {
      this.pulling = false;
    }
  }
  private async pullSource(scope: SyncScope, actorId?: number) {
    const source = {
      ...(await this.feishu.directory("sync", scope === "users")),
      appId: String(this.connections.require("feishu-directory").appId),
      fetchedAt: new Date().toISOString(),
    };
    this.store(source, scope === "users");
    this.database.setState(
      "sync.snapshot.organization",
      JSON.stringify({ ...source, people: [] }),
    );
    if (scope === "users")
      this.database.setState("sync.snapshot.users", JSON.stringify(source));
    this.database.addAuditLog(
      "sync.feishu.read",
      JSON.stringify({
        scope,
        departments: source.departments.length,
        users: source.people.length,
      }),
      actorId ? String(actorId) : "worker",
    );
    return this.view(scope);
  }
  private sourceFingerprint(source: Snapshot) {
    const departments = [...source.departments]
      .sort((a, b) => a.open_department_id.localeCompare(b.open_department_id))
      .map((department) => ({
        id: department.open_department_id,
        name: department.name,
        parent: department.parent_department_id || "0",
      }));
    const people = [...source.people]
      .sort((a, b) => a.open_id.localeCompare(b.open_id))
      .map((person) => ({
        id: person.open_id,
        userId: person.user_id || null,
        name: person.name,
        email: person.email || null,
        phone: person.mobile || null,
        departmentIds: [...person.department_ids].sort(),
        resigned: Boolean(person.status?.is_resigned),
        frozen: Boolean(person.status?.is_frozen),
      }));
    return createHash("sha256")
      .update(JSON.stringify({ departments, people }))
      .digest("hex");
  }
  private sourceOptionsFingerprint(
    scope: SyncScope | "all",
    options: SyncOptions,
  ) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          scope,
          overwriteDepartments: Boolean(options.overwriteDepartments),
          overwriteUsers: Boolean(options.overwriteUsers),
          preserveExistingPermissions:
            options.preserveExistingPermissions !== false,
          disableMissingUsers: Boolean(options.disableMissingUsers),
          selectedIds: [...(options.selectedIds || [])].sort(),
        }),
      )
      .digest("hex");
  }
  private lastSourceState() {
    try {
      return JSON.parse(
        this.database.getState("sync.last-source-state") || "null",
      ) as {
        hash: string;
        options: string;
        scope: string;
        target: string;
        at: string;
      } | null;
    } catch {
      return null;
    }
  }
  async execute(
    scope: SyncScope | "all",
    options: SyncOptions = {},
    actorId?: number,
  ) {
    if (this.running) throw new ConflictException("已有同步任务运行中");
    if (this.pulling)
      throw new ConflictException("正在读取通讯录，请稍后再同步");
    this.connections.require("tencent-meeting");
    this.running = true;
    const run = this.database.db
      .insert(syncRuns)
      .values({ source: "feishu." + scope, status: "running" })
      .returning()
      .get();
    const result = {
      created: 0,
      updated: 0,
      skipped: 0,
      pendingActivation: 0,
      permissionsPreserved: 0,
      failed: 0,
      departmentsCount: 0,
      usersCount: 0,
      errors: [] as string[],
    };
    try {
      if (scope === "all") await this.pullSource("users", actorId);
      const source = this.snapshot(scope === "all" ? "users" : scope);
      if (options.fetchedAt && options.fetchedAt !== source.fetchedAt)
        throw new BadRequestException("预览已更新，请重新核对后同步");
      const fingerprint = this.sourceFingerprint(source);
      const optionFingerprint = this.sourceOptionsFingerprint(scope, options);
      const target = this.policy().targetConnectionId;
      const previous = this.lastSourceState();
      if (
        options.skipUnchanged &&
        previous &&
        previous.hash === fingerprint &&
        previous.options === optionFingerprint &&
        previous.scope === scope &&
        previous.target === target
      ) {
        const at = new Date().toISOString();
        this.database.db
          .update(syncRuns)
          .set({
            status: "success",
            resultJson: JSON.stringify({ ...result, unchanged: true }),
            error: null,
            finishedAt: at,
          })
          .where(eq(syncRuns.id, run.id))
          .run();
        this.database.setState("sync.last-run", at);
        this.database.setState(
          "sync.last-source-state",
          JSON.stringify({ ...previous, at }),
        );
        this.database.addAuditLog(
          "sync.skip",
          JSON.stringify({ runId: run.id, scope, reason: "飞书数据未变化" }),
          actorId ? String(actorId) : "worker",
        );
        return { id: run.id, status: "success", ...result, unchanged: true };
      }
      if (scope === "organization" || scope === "all") {
        const external = await this.tencent.departments();
        const wanted = new Set(
          options.selectedIds ||
            source.departments.map((d) => d.open_department_id),
        );
        const map = new Map(
          source.departments.map((d) => [d.open_department_id, d]),
        );
        for (const id of wanted)
          if (!map.has(id))
            throw new BadRequestException("所选部门已不在预览中，请重新读取");
        // Include ancestors so a selected child is created under the correct parent.
        for (const id of [...wanted]) {
          let parent = map.get(id)?.parent_department_id;
          const visited = new Set<string>();
          while (parent && map.has(parent)) {
            if (visited.has(parent))
              throw new BadRequestException("组织结构存在循环");
            visited.add(parent);
            wanted.add(parent);
            parent = map.get(parent)?.parent_department_id;
          }
        }
        const pending = source.departments.filter((d) =>
          wanted.has(d.open_department_id),
        );
        const done = new Set<string>();
        const mapping = new Map<string, string>();
        while (pending.length) {
          const index = pending.findIndex(
            (d) =>
              !wanted.has(d.parent_department_id) ||
              done.has(d.parent_department_id),
          );
          if (index < 0)
            throw new BadRequestException("组织结构存在循环或父部门不可见");
          const d = pending.splice(index, 1)[0]!;
          done.add(d.open_department_id);
          try {
            if (
              wanted.has(d.parent_department_id) &&
              !mapping.has(d.parent_department_id)
            )
              throw new Error("父部门同步失败，已跳过子部门");
            const row = this.database.db
              .select()
              .from(departments)
              .where(
                and(
                  eq(departments.connectionId, "feishu-directory"),
                  eq(departments.externalId, d.open_department_id),
                ),
              )
              .get()!;
            const existing =
              row.tencentDepartmentId ||
              external.find((x) => x.department_full_name === row.path)
                ?.department_id;
            let id = existing;
            if (!existing || options.overwriteDepartments) {
              const remote = await this.tencent.department(
                d.name,
                mapping.get(d.parent_department_id) || "0",
                existing,
              );
              id = remote.department_id || existing;
              if (!id) throw new Error("腾讯会议未返回部门 ID");
              if (existing) result.updated++;
              else result.created++;
            } else result.skipped++;
            mapping.set(d.open_department_id, String(id));
            this.database.db
              .update(departments)
              .set({
                tencentDepartmentId: String(id),
                updatedAt: new Date().toISOString(),
              })
              .where(eq(departments.id, row.id))
              .run();
            result.departmentsCount++;
          } catch (e) {
            result.failed++;
            result.errors.push(
              d.name + ": " + (e instanceof Error ? e.message : "同步失败"),
            );
          }
        }
      }
      if (scope === "users" || scope === "all") {
        const remoteList = await this.tencent.userList();
        // Enterprise UserIDs can differ from Feishu IDs. Resolve by bound ID, then phone.
        const remoteUsers: any[] = [];
        for (let i = 0; i < remoteList.length; i += 4)
          remoteUsers.push(
            ...(await Promise.all(
              remoteList.slice(i, i + 4).map(async (row) => ({
                ...row,
                ...(await this.tencent.user(row.userid)),
                userid: row.userid,
              })),
            )),
          );
        const remoteById = new Map(remoteUsers.map((u) => [u.userid, u]));
        const remoteByPhone = new Map<string, any[]>();
        for (const u of remoteUsers) {
          const phone = tencentPhoneKey(u.phone || u.mobile, u.area);
          if (phone)
            remoteByPhone.set(phone, [...(remoteByPhone.get(phone) || []), u]);
        }
        const rules = this.database.db
          .select()
          .from(syncRules)
          .where(eq(syncRules.enabled, true))
          .orderBy(syncRules.id)
          .all();
        const wanted = new Set(
          options.selectedIds || source.people.map((p) => p.open_id),
        );
        for (const id of wanted)
          if (!source.people.some((p) => p.open_id === id))
            throw new BadRequestException("所选用户已不在预览中，请重新读取");
        for (const p of source.people.filter((p) => wanted.has(p.open_id))) {
          const row = this.person(p)!;
          try {
            const ruleType =
              rules.find(
                (r) =>
                  (!r.departmentExternalId ||
                    p.department_ids.includes(r.departmentExternalId)) &&
                  (!r.departmentName ||
                    source.departments.some(
                      (d) =>
                        p.department_ids.includes(d.open_department_id) &&
                        d.name === r.departmentName,
                    )),
              )?.meetingUserType || "ordinary";
            const phone = tencentPhoneKey(row.phone);
            const matches = phone ? remoteByPhone.get(phone) || [] : [];
            let existing = remoteById.get(
              row.tencentUserId || p.user_id || p.open_id,
            );
            if (!existing && matches.length > 1)
              throw new Error("腾讯会议中有多个相同手机号，请先绑定具体账号");
            existing ||= matches[0];
            const id =
              existing?.userid || row.tencentUserId || p.user_id || p.open_id;
            const occupied = this.database.db
              .select()
              .from(platformIdentities)
              .where(
                and(
                  eq(platformIdentities.connectionId, "tencent-meeting"),
                  eq(platformIdentities.kind, "person"),
                  eq(platformIdentities.externalId, id),
                ),
              )
              .get();
            if (occupied && occupied.userId !== row.id)
              throw new Error("此腾讯账号已绑定其他飞书用户，请先核对身份");
            const preserve =
              options.preserveExistingPermissions !== false &&
              Boolean(existing);
            const type = preserve
              ? this.tencent.isAdvanced(existing)
                ? "advanced"
                : "ordinary"
              : ruleType;
            const mapped = [
              ...new Set(p.department_ids.filter((id) => id !== "0")),
            ].map((id) => {
              const department = source.departments.find(
                (d) => d.open_department_id === id,
              );
              const target =
                department &&
                this.database.db
                  .select()
                  .from(departments)
                  .where(
                    and(
                      eq(departments.externalId, id),
                      eq(departments.connectionId, "feishu-directory"),
                    ),
                  )
                  .get()?.tencentDepartmentId;
              if (!target)
                throw new Error("所属组织尚未同步到腾讯会议，请先完成组织同步");
              return target;
            });
            // Tencent accepts one department; root "0" must not be sent as an empty array.
            const targetDepartment = mapped[0] || "0";
            const departmentChanged =
              existing &&
              !this.tencent.isUserInDepartment(existing, targetDepartment);
            const remoteUnactivated =
              existing && Number((existing as any).status) === 3;
            const remoteAdvanced = existing
              ? this.tencent.isAdvanced(existing)
              : false;
            const nameChanged =
              existing &&
              String((existing as any).username || "") !== p.name;
            const licenseChanged = Boolean(
              existing &&
                !preserve &&
                remoteAdvanced !== (type === "advanced"),
            );
            const remoteDisabled = existing
              ? Number((existing as any).status) !== 1
              : false;
            const statusChanged = Boolean(
              existing && !remoteUnactivated && remoteDisabled !== (row.status === "disabled"),
            );
            const profileChanged = Boolean(
              existing && options.overwriteUsers && nameChanged,
            );
            const changed =
              !existing ||
              profileChanged ||
              departmentChanged ||
              licenseChanged ||
              statusChanged;
            if (!changed) {
              result.skipped++;
            } else if (
              !existing ||
              profileChanged ||
              statusChanged
            ) {
              await this.tencent.upsertUser({
                id,
                name: p.name,
                email: row.email,
                phone: row.phone,
                departmentIds: existing ? [targetDepartment] : mapped,
                advanced: preserve ? undefined : type === "advanced",
                disabled: row.status === "disabled",
                exists: Boolean(existing),
                wasDisabled:
                  existing && (existing as any).status !== undefined
                    ? Number((existing as any).status) !== 1
                    : undefined,
                unactivated: remoteUnactivated,
              });
              if (remoteUnactivated) result.pendingActivation++;
              if (existing) result.updated++;
              else result.created++;
            } else {
              await this.tencent.updateUserAssignment(
                id,
                departmentChanged ? targetDepartment : undefined,
                licenseChanged ? type === "advanced" : undefined,
              );
              result.updated++;
            }
            if (preserve) result.permissionsPreserved++;
            this.database.db
              .update(users)
              .set({
                syncError: null,
              })
              .where(eq(users.id, row.id))
              .run();
            this.saveIdentity(
              "tencent",
              "tencent-meeting",
              id,
              row.id,
              row.displayName,
              { providerData: { advanced: type === "advanced" } },
            );
            // Verified personal accounts are usable even before an operator adds them to a pool.
            const account = this.database.db
              .select()
              .from(meetingAccounts)
              .where(
                and(
                  eq(meetingAccounts.connectionId, "tencent-meeting"),
                  eq(meetingAccounts.accountId, id),
                ),
              )
              .get();
            if (type === "advanced" && !account)
              this.database.db
                .insert(meetingAccounts)
                .values({
                  name: row.displayName,
                  accountId: id,
                  verifiedAt: new Date().toISOString(),
                })
                .run();
            if (account && type !== "advanced")
              this.database.db
                .update(meetingAccounts)
                .set({
                  verifiedAt: null,
                  status: "disabled",
                  lastError: "当前腾讯账号没有高级许可",
                })
                .where(eq(meetingAccounts.id, account.id))
                .run();
            const remote = {
              ...existing,
              userid: id,
              phone: row.phone,
              department_list:
                targetDepartment === "0"
                  ? []
                  : [{ department_id: targetDepartment }],
              user_account_type: preserve
                ? existing.user_account_type
                : type === "advanced"
                  ? 9
                  : 2,
            };
            remoteById.set(id, remote);
            if (phone) remoteByPhone.set(phone, [remote]);
            result.usersCount++;
          } catch (e) {
            const message = e instanceof Error ? e.message : "同步失败";
            this.database.db
              .update(users)
              .set({ syncError: message })
              .where(eq(users.id, row.id))
              .run();
            result.failed++;
            result.errors.push(p.name + ": " + message);
          }
        }
        if (
          scope === "all" &&
          (options.disableMissingUsers ?? this.policy().disableMissingUsers)
        ) {
          for (const identity of this.database.db
            .select()
            .from(platformIdentities)
            .where(
              and(
                eq(platformIdentities.connectionId, "feishu-directory"),
                eq(platformIdentities.kind, "person"),
              ),
            )
            .all()
            .filter(
              (i) => !source.people.some((p) => p.open_id === i.externalId),
            )) {
            if (!identity.userId) continue;
            const u = {
              id: identity.userId,
              tencentUserId: this.tencentIdentity(identity.userId)?.externalId,
            };
            if (!u.tencentUserId) continue;
            const remote = remoteById.get(u.tencentUserId);
            const inactive =
              remote &&
              (Number(remote.status) === 3 || Number(remote.status) !== 1);
            if (!inactive) {
              try {
                await this.tencent.request(
                  "/v1/users/" +
                    encodeURIComponent(u.tencentUserId) +
                    "/enable",
                  "PUT",
                  {
                    enable: false,
                    operator_id: this.tencent.operator,
                    operator_id_type: 1,
                  },
                );
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "禁用失败";
                // Tencent cannot disable an unactivated account (60005);
                // it is already inactive, so treat it as a skipped write.
                if (!/60005|未激活/.test(message)) {
                  result.failed++;
                  result.errors.push(message);
                  continue;
                }
                result.skipped++;
              }
            } else {
              result.skipped++;
            }
            this.database.db
              .update(users)
              .set({ status: "disabled" })
              .where(eq(users.id, u.id))
              .run();
          }
        }
      }
      const status = result.failed ? "failed" : "success";
      const finishedAt = new Date().toISOString();
      this.database.setState("sync.last-run", finishedAt);
      if (status === "success")
        this.database.setState(
          "sync.last-source-state",
          JSON.stringify({
            hash: fingerprint,
            options: optionFingerprint,
            scope,
            target,
            at: finishedAt,
          }),
        );
      this.database.db
        .update(syncRuns)
        .set({
          status,
          departmentsCount: result.departmentsCount,
          usersCount: result.usersCount,
          resultJson: JSON.stringify(result),
          error: result.errors.length
            ? result.errors.join("\n").slice(0, 10000)
            : null,
          finishedAt: new Date().toISOString(),
        })
        .where(eq(syncRuns.id, run.id))
        .run();
      this.database.addAuditLog(
        "sync.tencent.write",
        JSON.stringify({ runId: run.id, scope, options, ...result }),
        actorId ? String(actorId) : "worker",
      );
      return { id: run.id, status, ...result };
    } catch (e) {
      this.database.db
        .update(syncRuns)
        .set({
          status: "failed",
          resultJson: JSON.stringify(result),
          error: e instanceof Error ? e.message : "同步失败",
          finishedAt: new Date().toISOString(),
        })
        .where(eq(syncRuns.id, run.id))
        .run();
      throw e;
    } finally {
      this.running = false;
    }
  }
  async updatePerson(id: number, input: unknown, actorId: number) {
    const b = parse(
      z.object({
        phone: z.string().max(30).optional(),
        email: email.optional(),
        tencentUserId: z.string().max(100).optional(),
      }),
      input,
    );
    const row = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (
      !row ||
      !this.database.db
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.connectionId, "feishu-directory"),
            eq(platformIdentities.userId, id),
          ),
        )
        .get()
    )
      throw new NotFoundException("飞书人员不存在");
    let meetingUserType = this.license(row.id);
    if (b.tencentUserId) {
      const remote = await this.tencent.user(b.tencentUserId);
      meetingUserType = this.tencent.isAdvanced(remote)
        ? "advanced"
        : "ordinary";
      const other = this.database.db
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.connectionId, "tencent-meeting"),
            eq(platformIdentities.kind, "person"),
            eq(platformIdentities.externalId, b.tencentUserId),
          ),
        )
        .get();
      if (other && other.userId !== row.id)
        throw new ConflictException("腾讯账号已绑定其他人员");
    }
    this.database.db
      .update(users)
      .set({
        phone: b.phone,
        email: b.email,
      })
      .where(eq(users.id, row.id))
      .run();
    if (b.tencentUserId)
      this.saveIdentity(
        "tencent",
        "tencent-meeting",
        b.tencentUserId,
        row.id,
        row.displayName,
        { providerData: { advanced: meetingUserType === "advanced" } },
      );
    this.database.addAuditLog(
      "sync.person.update",
      JSON.stringify({ id: row.id }),
      String(actorId),
    );
    return { ok: true };
  }
  run(actorId?: number) {
    // 定时任务与手动任务撞车时跳过本轮，避免把一次可避免的冲突记成失败。
    if (this.running || this.pulling)
      return Promise.resolve({ skipped: true, reason: "已有同步任务运行中" });
    return this.execute(
      "all",
      { ...this.policy(), skipUnchanged: true },
      actorId,
    );
  }
}
