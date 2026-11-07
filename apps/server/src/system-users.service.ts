import {loginSharesFeishuTenant} from "./platforms/shared/feishu/identity.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and,eq, or } from "drizzle-orm";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { FeishuAdapter, type DirectoryPerson } from "./platforms/shared/feishu/client.js";
import {
  feishuAvatarUrl,
  type FeishuAvatarSource,
} from "./platforms/shared/feishu/avatar.js";
import { platformIdentities,users, userDepartments, meetingAttendees } from "./db/schema.js";
import type { Role } from "./auth.service.js";
type LoginPreview = {
  appId: string;
  fetchedAt: string;
  people: DirectoryPerson[];
  departments: { open_department_id: string; name: string }[];
};
@Injectable()
export class SystemUsersService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(FeishuAdapter) private feishu: FeishuAdapter,
  ) {}
  private find(p: DirectoryPerson) {
    const login = this.database.db
      .select()
      .from(users)
      .where(
        or(
          eq(users.feishuLoginOpenId, p.open_id),
          ...(p.user_id ? [eq(users.feishuUserId, p.user_id)] : []),
        ),
      )
      .get();
    if(login)return login;
    if(!p.user_id || !loginSharesFeishuTenant(this.config,this.database,"feishu-directory"))return;
    const identity=this.database.db.select().from(platformIdentities).where(and(eq(platformIdentities.connectionId,"feishu-directory"),eq(platformIdentities.kind,"person"),eq(platformIdentities.stableId,p.user_id))).get();
    return identity?.userId ? this.database.db.select().from(users).where(eq(users.id,identity.userId)).get() : undefined;
  }
  async preview() {
    const directory = await this.feishu.directory("login");
    const snapshot = {
      ...directory,
      appId: this.config.get("feishu.login.app-id"),
      fetchedAt: new Date().toISOString(),
    };
    this.database.setState(
      "system-users.feishu-preview",
      JSON.stringify(snapshot),
    );
    const people = this.database.db
      .select({
        id: users.id,
        avatarUrl: users.avatarUrl,
        systemAccess: users.systemAccess,
        feishuLoginOpenId: users.feishuLoginOpenId,
        feishuUserId: users.feishuUserId,
      })
      .from(users)
      .all();
    const byOpenId = new Map(
      people
        .filter((p) => p.feishuLoginOpenId)
        .map((p) => [p.feishuLoginOpenId, p]),
    );
    const byUserId = new Map(
      people.filter((p) => p.feishuUserId).map((p) => [p.feishuUserId, p]),
    );
    const departmentNames = new Map(
      snapshot.departments.map((d) => [d.open_department_id, d.name]),
    );
    return {
      fetchedAt: snapshot.fetchedAt,
      appId: snapshot.appId,
      people: snapshot.people.map((p) => {
        const row =
          byOpenId.get(p.open_id) ||
          (p.user_id ? byUserId.get(p.user_id) : undefined) || this.find(p);
        return {
          ...p,
          avatarUrl: feishuAvatarUrl(p) || row?.avatarUrl || null,
          systemUserId: row?.id,
          systemAccess: row?.systemAccess || "not_added",
          departmentNames: p.department_ids.map(
            (id) => departmentNames.get(id) || id,
          ),
        };
      }),
    };
  }
  private snapshot() {
    const raw = this.database.getState("system-users.feishu-preview");
    if (!raw) throw new BadRequestException("请先读取飞书登录应用的通讯录");
    const snapshot = JSON.parse(raw) as LoginPreview;
    if (
      snapshot.appId !== this.config.get("feishu.login.app-id") ||
      Date.now() - Date.parse(snapshot.fetchedAt) > 3600000
    )
      throw new BadRequestException("通讯录预览已过期或应用已更换，请重新读取");
    return snapshot;
  }
  import(selectedIds: string[], role: Role, actorId: number) {
    const snapshot = this.snapshot();
    const availableIds = new Set(snapshot.people.map((p) => p.open_id));
    const selected = new Set(selectedIds);
    if (selectedIds.some((id) => !availableIds.has(id)))
      throw new BadRequestException("所选人员不在预览中");
    let created = 0,
      updated = 0;
    this.database.db.transaction((tx) => {
      for (const p of snapshot.people.filter((p) => selected.has(p.open_id))) {
        if (p.status?.is_resigned || p.status?.is_frozen)
          throw new BadRequestException(p.name + " 的飞书账号已停用");
        const row = this.find(p);
        const fields = {
          feishuLoginOpenId: p.open_id,
          feishuUserId: p.user_id || row?.feishuUserId || null,
          displayName: p.name,
          avatarUrl: feishuAvatarUrl(p) || row?.avatarUrl || null,
          email: p.email || row?.email || null,
          phone: p.mobile || row?.phone || null,
          updatedAt: new Date().toISOString(),
        };
        if (row) {
          tx.update(users)
            .set({
              ...fields,
              ...(row.systemAccess === "not_added"
                ? { systemAccess: "allowed" as const, role }
                : {}),
            })
            .where(eq(users.id, row.id))
            .run();
          updated++;
        } else {
          tx.insert(users)
            .values({
              ...fields,
              username: "feishu:" + p.open_id,
              source: "feishu",
              systemAccess: "allowed",
              role,
            })
            .run();
          created++;
        }
      }
    });
    this.database.addAuditLog(
      "system-users.feishu.import",
      JSON.stringify({ selectedIds, role, created, updated }),
      String(actorId),
    );
    return { created, updated };
  }
  bind(id: number, openId: string | null, actorId: number) {
    const target = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (!target || target.systemAccess === "not_added")
      throw new NotFoundException("系统用户不存在");
    if (!openId) {
      this.database.db
        .update(users)
        .set({ feishuLoginOpenId: null })
        .where(eq(users.id, id))
        .run();
      this.database.addAuditLog(
        "system-users.feishu.bind",
        JSON.stringify({ id, bound: false }),
        String(actorId),
      );
      return { ok: true };
    }
    const p = this.snapshot().people.find((p) => p.open_id === openId);
    if (!p) throw new BadRequestException("所选飞书用户不在预览中");
    return this.bindIdentity(id, p, actorId);
  }
  bindIdentity(
    id: number,
    p: Pick<DirectoryPerson, "open_id" | "user_id" | "status"> &
      FeishuAvatarSource,
    actorId: number,
  ) {
    const target = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (!target || target.systemAccess === "not_added")
      throw new NotFoundException("系统用户不存在");
    if (p.status?.is_resigned || p.status?.is_frozen)
      throw new BadRequestException("此飞书身份已停用");
    const duplicate = this.find({ ...p, name: "", department_ids: [] });
    if (
      duplicate &&
      duplicate.id !== id &&
      duplicate.systemAccess !== "not_added"
    )
      throw new ConflictException("此飞书身份已绑定其他系统用户");
    if (target.feishuUserId && p.user_id && target.feishuUserId !== p.user_id)
      throw new ConflictException(
        "该用户已关联另一位飞书人员；请为新人员添加独立的系统用户",
      );
    this.database.db.transaction((tx) => {
      if (duplicate && duplicate.id !== id) {
        const memberships = tx
          .select()
          .from(userDepartments)
          .where(eq(userDepartments.userId, duplicate.id))
          .all();
        tx.update(meetingAttendees)
          .set({ userId: id })
          .where(eq(meetingAttendees.userId, duplicate.id))
          .run();
        tx.delete(userDepartments)
          .where(eq(userDepartments.userId, duplicate.id))
          .run();
        tx.update(platformIdentities).set({userId:id}).where(eq(platformIdentities.userId,duplicate.id)).run();
        tx.delete(users).where(eq(users.id, duplicate.id)).run();
        for (const d of memberships)
          tx.insert(userDepartments)
            .values({ userId: id, departmentId: d.departmentId })
            .onConflictDoNothing()
            .run();
      }
      tx.update(users)
        .set({
          feishuLoginOpenId: p.open_id,
          avatarUrl:
            feishuAvatarUrl(p) ||
            target.avatarUrl ||
            duplicate?.avatarUrl ||
            null,
          feishuUserId: p.user_id || target.feishuUserId || null,
          ...(duplicate && duplicate.id !== id
            ? {
                feishuOpenId: duplicate.feishuOpenId,
                source: duplicate.source,
                phone: target.phone || duplicate.phone,
                email: target.email || duplicate.email,
              }
            : {}),
        })
        .where(eq(users.id, id))
        .run();
    });
    this.database.addAuditLog(
      "system-users.feishu.bind",
      JSON.stringify({ id, bound: true }),
      String(actorId),
    );
    return { ok: true };
  }
}
