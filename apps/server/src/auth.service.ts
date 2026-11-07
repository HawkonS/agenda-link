import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  BadRequestException,
} from "@nestjs/common";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, gt, lt } from "drizzle-orm";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { users, sessions } from "./db/schema.js";
import {
  derivePassword,
  LoginProtection,
  passwordOptions,
} from "./security.js";
export const DEFAULT_ADMIN_USERNAME = "hawkon";
export type Role = "system_admin" | "operation_admin" | "user";
export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
};
export type AuthRequest = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};
@Injectable()
export class AuthService {
  readonly protection: LoginProtection;
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(DatabaseService) private database: DatabaseService,
  ) {
    this.protection = new LoginProtection(database);
  }
  hashPassword(password: string) {
    if (password.length < 12 || password.length > 256)
      throw new BadRequestException("密码长度必须为 12–256 个字符");
    const salt = randomBytes(16).toString("hex");
    return (
      "scrypt-v2$" +
      salt +
      "$" +
      scryptSync(password, salt, 64, passwordOptions).toString("hex")
    );
  }
  verifyPassword(password: string, encoded: string) {
    const [version, salt, hex] = encoded.split("$");
    if (
      !/^scrypt(?:-v2)?\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded) ||
      !salt ||
      !hex ||
      password.length > 256
    )
      return false;
    const a = scryptSync(
      password,
      salt,
      64,
      version === "scrypt-v2" ? passwordOptions : {},
    );
    const b = Buffer.from(hex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async hashPasswordAsync(password: string) {
    if (password.length < 12 || password.length > 256)
      throw new BadRequestException("密码长度必须为 12–256 个字符");
    const salt = randomBytes(16).toString("hex");
    return (
      "scrypt-v2$" +
      salt +
      "$" +
      (await derivePassword(password, salt)).toString("hex")
    );
  }
  async verifyPasswordAsync(password: string, encoded?: string | null) {
    const valid = /^scrypt(?:-v2)?\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(
      encoded || "",
    );
    const [, salt, hex] = valid
      ? encoded!.split("$")
      : ["", "0".repeat(32), "0".repeat(128)];
    const modern = !valid || encoded!.startsWith("scrypt-v2$");
    const derived = await derivePassword(password, salt!, modern);
    // Equalize work for legacy, modern and nonexistent accounts.
    await derivePassword(password, salt!, !modern);
    return valid && timingSafeEqual(derived, Buffer.from(hex!, "hex"));
  }
  createInitialAdmin(username: string, displayName: string, password: string) {
    if (
      this.database.db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .get()
    )
      return;
    this.database.db
      .insert(users)
      .values({
        username,
        displayName,
        passwordHash: this.hashPassword(password),
        role: "system_admin",
      })
      .run();
  }
  ensureInitialAdmin() {
    const existing = this.database.db.select().from(users).limit(1).get();
    if (existing) {
      this.renameLegacyInitialAdmin();
      return { created: false, passwordPath: this.initialPasswordPath };
    }
    mkdirSync(path.dirname(this.initialPasswordPath), { recursive: true });
    let password = existsSync(this.initialPasswordPath)
      ? readFileSync(this.initialPasswordPath, "utf8").trim()
      : "";
    if (password.length < 12) {
      password = randomBytes(18).toString("base64url");
      writeFileSync(this.initialPasswordPath, password + "\n", { mode: 0o600 });
    }
    chmodSync(this.initialPasswordPath, 0o600);
    this.createInitialAdmin(DEFAULT_ADMIN_USERNAME, "系统管理员", password);
    return { created: true, passwordPath: this.initialPasswordPath };
  }
  /**
   * 旧版本的内置管理员叫 admin。升级时只迁移这一个本地初始账号：
   * 保留用户 ID、密码和现有会话，避免其他自定义账号被误改。
   */
  private renameLegacyInitialAdmin() {
    const current = this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, DEFAULT_ADMIN_USERNAME))
      .get();
    if (current) return;
    const legacy = this.database.db
      .select()
      .from(users)
      .where(eq(users.username, "admin"))
      .get();
    if (
      !legacy ||
      legacy.role !== "system_admin" ||
      legacy.source !== "local" ||
      !legacy.passwordHash ||
      legacy.feishuOpenId ||
      legacy.feishuLoginOpenId ||
      legacy.feishuUserId
    )
      return;
    const first = this.database.db
      .select({ id: users.id })
      .from(users)
      .orderBy(users.id)
      .limit(1)
      .get();
    if (first?.id !== legacy.id) return;
    this.database.db
      .update(users)
      .set({
        username: DEFAULT_ADMIN_USERNAME,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, legacy.id))
      .run();
    console.log(`已将内置管理员账号 admin 重命名为 ${DEFAULT_ADMIN_USERNAME}`);
  }
  get initialPasswordPath() {
    return path.join(
      this.config.workspaceRoot,
      ".runtime",
      "initial-admin-password",
    );
  }
  private view(row: typeof users.$inferSelect): SessionUser {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      role: row.role,
    };
  }
  async issue(user: typeof users.$inferSelect) {
    const current = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .get();
    if (!current) throw new UnauthorizedException("此用户未获准登录系统");
    user = current;
    if (user.systemAccess !== "allowed")
      throw new UnauthorizedException("此用户未获准登录系统");
    if (user.status !== "active") throw new UnauthorizedException("账号已停用");
    const id = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 43200000).toISOString();
    this.database.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date().toISOString()))
      .run();
    this.database.db
      .insert(sessions)
      .values({ id, userId: user.id, expiresAt })
      .run();
    this.database.connection
      .prepare(
        "DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? ORDER BY expires_at DESC, rowid DESC LIMIT 20)",
      )
      .run(user.id, user.id);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setJti(id)
      .setIssuer("agenda-link")
      .setAudience("agenda-link")
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(new TextEncoder().encode(this.config.get("auth.jwt-secret")));
    return { token, user: this.view(user) };
  }
  async login(username: string, password: string, ip = "local") {
    this.protection.check(username, ip);
    let row = this.database.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    const verified = await this.verifyPasswordAsync(
      password,
      row?.passwordHash,
    );
    const previousHash = row?.passwordHash;
    row = this.database.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    this.protection.check(username, ip);
    if (
      !row ||
      !row.passwordHash ||
      row.status !== "active" ||
      row.systemAccess !== "allowed" ||
      row.passwordHash !== previousHash ||
      !verified
    ) {
      this.protection.fail(username, ip);
      throw new UnauthorizedException("用户名或密码错误");
    }
    this.protection.success(username, ip);
    if (row.passwordHash.startsWith("scrypt$")) {
      const upgraded = await this.hashPasswordAsync(password);
      const changed = this.database.db
        .update(users)
        .set({ passwordHash: upgraded })
        .where(and(eq(users.id, row.id), eq(users.passwordHash, previousHash!)))
        .run().changes;
      if (!changed)
        throw new UnauthorizedException("账号状态已变更，请重新登录");
      row = { ...row, passwordHash: upgraded };
    }
    return this.issue(row);
  }
  token(request: AuthRequest) {
    const authorization = request.headers.authorization;
    const cookie = request.headers.cookie;
    return typeof authorization === "string" &&
      authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : typeof cookie === "string"
        ? cookie
            .split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("agenda_link_session="))
            ?.slice("agenda_link_session=".length)
        : undefined;
  }
  async verify(request: AuthRequest) {
    const token = this.token(request);
    if (!token) throw new UnauthorizedException("请先登录");
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(this.config.get("auth.jwt-secret")),
        {
          issuer: "agenda-link",
          audience: "agenda-link",
          algorithms: ["HS256"],
        },
      );
      const session = this.database.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, payload.jti || ""),
            gt(sessions.expiresAt, new Date().toISOString()),
          ),
        )
        .get();
      if (!session || session.userId !== Number(payload.sub)) throw new Error();
      const row = this.database.db
        .select()
        .from(users)
        .where(eq(users.id, session.userId))
        .get();
      if (!row || row.status !== "active" || row.systemAccess !== "allowed")
        throw new Error();
      return { user: this.view(row), sessionId: session.id };
    } catch {
      throw new UnauthorizedException("登录已过期，请重新登录");
    }
  }
  async require(request: AuthRequest, roles?: Role[]) {
    const { user } = await this.verify(request);
    if (roles && !roles.includes(user.role))
      throw new ForbiddenException("没有操作权限");
    return user;
  }
  async logout(request: AuthRequest) {
    try {
      const { sessionId } = await this.verify(request);
      this.database.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    } catch {}
  }
  revokeUser(userId: number) {
    this.database.db.delete(sessions).where(eq(sessions.userId, userId)).run();
    const row = this.database.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (row?.username === DEFAULT_ADMIN_USERNAME) {
      try {
        unlinkSync(this.initialPasswordPath);
      } catch {}
    }
  }
  get secureCookies() {
    return (
      this.config.baseUrl.startsWith("https://") ||
      this.config.get("auth.cookie-secure") === "true"
    );
  }
  cookie(token: string, maxAge = 43200) {
    return (
      "agenda_link_session=" +
      token +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
      maxAge +
      (this.secureCookies ? "; Secure" : "")
    );
  }
}
