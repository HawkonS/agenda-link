import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, or, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { FeishuAdapter } from "./platforms/shared/feishu/client.js";
import { feishuAvatarUrl } from "./platforms/shared/feishu/avatar.js";
import { SystemUsersService } from "./system-users.service.js";
import { users } from "./db/schema.js";
import { parse } from "./validation.js";
@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(SystemUsersService) private systemUsers: SystemUsersService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(FeishuAdapter) private feishu: FeishuAdapter,
  ) {}
  @Post("login")
  async login(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const body = parse(
      z.object({
        username: z.string().trim().min(1).max(100),
        password: z.string().max(256),
      }),
      input,
    );
    const result = await this.auth.login(
      body.username,
      body.password,
      request.ip,
    );
    response.header("set-cookie", this.auth.cookie(result.token));
    this.database.addAuditLog("auth.login", "本地登录", String(result.user.id));
    return { user: result.user };
  }
  @Post("logout")
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    await this.auth.logout(request);
    response.header("set-cookie", this.auth.cookie("", 0));
    return { ok: true };
  }
  @Get("me") async me(@Req() request: FastifyRequest) {
    return { user: await this.auth.require(request) };
  }
  @Get("feishu/status") status() {
    return {
      enabled: Boolean(
        this.config.get("feishu.login.app-id") &&
        this.config.get("feishu.login.app-secret") &&
        this.config.get("feishu.login.redirect-uri"),
      ),
    };
  }
  @Get("feishu/url")
  async url(
    @Query("bind") bind: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    for (const key of [
      "feishu.login.app-id",
      "feishu.login.app-secret",
      "feishu.login.redirect-uri",
    ])
      if (!this.config.get(key))
        throw new BadRequestException("请先在系统设置中配置飞书登录应用");
    const actor = bind === "true" ? await this.auth.require(request) : null;
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.database.setState("oauth:" + state, String(Date.now() + 600000));
    const ticket = await new SignJWT({ state, verifier, userId: actor?.id })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .setAudience("feishu-oauth")
      .sign(new TextEncoder().encode(this.config.get("auth.jwt-secret")));
    response.header(
      "set-cookie",
      "agenda_link_oauth=" +
        ticket +
        "; Path=/api/auth/feishu; HttpOnly; SameSite=Lax; Max-Age=600" +
        (this.auth.secureCookies ? "; Secure" : ""),
    );
    const url = new URL(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    for (const [k, v] of Object.entries({
      client_id: this.config.get("feishu.login.app-id"),
      redirect_uri: this.config.get("feishu.login.redirect-uri"),
      response_type: "code",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(k, v);
    return { url: url.toString() };
  }
  @Get("feishu/callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ) {
    try {
      const ticket = request.cookies.agenda_link_oauth || "";
      const { payload } = await jwtVerify(
        ticket,
        new TextEncoder().encode(this.config.get("auth.jwt-secret")),
        { audience: "feishu-oauth", algorithms: ["HS256"] },
      );
      const expected = Buffer.from(String(payload.state));
      const actual = Buffer.from(state || "");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        !code
      )
        throw new BadRequestException("OAuth state 校验失败");
      const valid =
        Number(this.database.getState("oauth:" + state) || 0) > Date.now();
      const consumed = this.database.connection
        .prepare("DELETE FROM system_state WHERE key=?")
        .run("oauth:" + state).changes;
      if (!valid || !consumed)
        throw new BadRequestException("OAuth 登录已过期或已使用");
      const identity = await this.feishu.oauth(code, String(payload.verifier));
      if (
        this.config.get("feishu.login.tenant-key") &&
        identity.tenant_key !== this.config.get("feishu.login.tenant-key")
      )
        throw new ForbiddenException("飞书企业不匹配");
      let row = this.database.db
        .select()
        .from(users)
        .where(
          or(
            eq(users.feishuLoginOpenId, identity.open_id),
            ...(identity.user_id
              ? [
                  and(
                    eq(users.feishuUserId, identity.user_id),
                    isNotNull(users.feishuLoginOpenId),
                  ),
                ]
              : []),
          ),
        )
        .get();
      if (payload.userId) {
        const actor = await this.auth.require(request);
        if (actor.id !== payload.userId)
          throw new ForbiddenException("绑定会话不匹配");
        this.systemUsers.bindIdentity(
          actor.id,
          {
            open_id: identity.open_id,
            user_id: identity.user_id,
            avatar_url: identity.avatar_url,
          },
          actor.id,
        );
        row = this.database.db
          .select()
          .from(users)
          .where(eq(users.id, actor.id))
          .get();
      }
      if (!row)
        throw new ForbiddenException("请先由管理员同步或绑定此飞书用户");
      const avatarUrl = feishuAvatarUrl(identity);
      if (
        avatarUrl &&
        row.systemAccess === "allowed" &&
        row.status === "active"
      )
        row = this.database.db
          .update(users)
          .set({ avatarUrl })
          .where(eq(users.id, row.id))
          .returning()
          .get()!;
      const result = await this.auth.issue(row);
      response.header("set-cookie", [
        this.auth.cookie(result.token),
        "agenda_link_oauth=; Path=/api/auth/feishu; HttpOnly; SameSite=Lax; Max-Age=0",
      ]);
      this.database.addAuditLog("auth.feishu", "飞书登录", String(row.id));
      response.redirect(this.config.baseUrl + "/dashboard", 302);
      return;
    } catch (error) {
      response.header(
        "set-cookie",
        "agenda_link_oauth=; Path=/api/auth/feishu; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      response.redirect(
        this.config.baseUrl + "/login?auth_error=feishu_login_failed",
        302,
      );
      return;
    }
  }
}
