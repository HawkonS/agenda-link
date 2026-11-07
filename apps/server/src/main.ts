import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import { AppModule } from "./app.module.js";
import { ConfigurationService } from "./config/configuration.service.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PlatformError } from "./platforms/shared/http.js";
import { AuthService, DEFAULT_ADMIN_USERNAME } from "./auth.service.js";
import { RateLimitError, RequestLimiter } from "./security.js";
@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof RateLimitError)
      response.header("retry-after", error.retryAfter);
    if (error instanceof HttpException)
      return response.status(error.getStatus()).send(error.getResponse());
    if (error instanceof PlatformError)
      return response
        .status(502)
        .send({ statusCode: 502, message: error.message, code: error.code });
    console.error(
      "API operation failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return response
      .status(500)
      .send({ statusCode: 500, message: "操作失败，请检查任务和审计日志" });
  }
}
export async function createApplication() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: "127.0.0.1",
      bodyLimit: 1024 * 1024,
      requestTimeout: 30_000,
      connectionTimeout: 10_000,
      maxParamLength: 500,
      logger: {
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
        ],
        serializers: {
          req: (r: any) => ({
            method: r.method,
            url: String(r.url).split("?")[0],
            remoteAddress: r.ip,
          }),
        },
      },
    }),
  );
  await app.register(cookie as any);
  app.enableShutdownHooks();
  app.useGlobalFilters(new SafeErrors());
  const config = app.get(ConfigurationService);
  const origins = [
    new URL(config.baseUrl).origin,
    "http://localhost:" + config.getNumber("web.port", 15173),
    "http://127.0.0.1:" + config.getNumber("web.port", 15173),
  ];
  app.enableCors({ origin: origins, credentials: true });
  const server = app.getHttpAdapter().getInstance();
  const limiter = new RequestLimiter();
  server.addHook("onRequest", async (req: any, reply: any) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cache-control", "no-store");
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    const pathname = String(req.url).split("?")[0]!;
    try {
      limiter.consume("api:" + req.ip, config.getNumber("security.api-rate-limit", 240));
      if (pathname.startsWith("/api/auth/"))
        limiter.consume("auth:" + req.ip, config.getNumber("security.auth-rate-limit", 60));
      if (
        pathname === "/api/meeting-accounts/tencent" ||
        (req.method === "POST" &&
          (pathname === "/api/system/backups" ||
            /\/feishu-preview$|\/feishu\/read$|\/test$/.test(pathname)))
      )
        limiter.consume("expensive:" + req.ip, config.getNumber("security.expensive-rate-limit", 10));
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      return reply
        .header("retry-after", error.retryAfter)
        .status(429)
        .send(error.getResponse());
    }
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
      const origin = req.headers.origin;
      let throughWeb = false;
      try {
        throughWeb =
          req.raw.socket.remoteAddress === "127.0.0.1" &&
          Boolean(req.headers["x-forwarded-host"]) &&
          new URL(origin).host === req.headers["x-forwarded-host"] &&
          new URL(origin).protocol ===
            (req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:");
      } catch {}
      if (
        origin &&
        !origins.includes(origin) &&
        origin !== new URL(config.baseUrl).origin &&
        !throughWeb
      )
        return reply.status(403).send({ message: "请求来源不受信任" });
      if (
        req.headers.cookie &&
        !origin &&
        !(
          typeof req.headers.authorization === "string" &&
          req.headers.authorization.startsWith("Bearer ")
        ) &&
        req.headers["sec-fetch-site"] !== "same-origin"
      )
        return reply.status(403).send({ message: "禁止跨站请求" });
    }
  });
  await app.init();
  return app;
}
async function bootstrap() {
  const config = new ConfigurationService();
  const dir = path.join(config.workspaceRoot, ".runtime");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "server.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let active = false;
    try {
      process.kill(pid, 0);
      active = true;
    } catch {}
    if (active) throw new Error("已有 agenda-link 实例运行");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  process.on("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {}
  });
  const app = await createApplication();
  const auth = app.get(AuthService);
  const initial = auth.ensureInitialAdmin();
  if (initial.created)
    console.log(
      "已自动创建系统管理员 " +
        DEFAULT_ADMIN_USERNAME +
        "，初始密码文件：" +
        initial.passwordPath,
    );
  await app.listen({
    port: config.getNumber("app.port", 18480),
    host: config.get("app.bind-address") || "127.0.0.1",
  });
}
if (process.env.AGENDA_LINK_TEST !== "true")
  bootstrap().catch((error) => {
    console.error("启动失败：", error.message);
    process.exitCode = 1;
  });
