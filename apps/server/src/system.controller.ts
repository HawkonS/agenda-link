import { LogFilesService } from "./log-files.service.js";
import { z } from "zod";
import { parse } from "./validation.js";
import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Query,
  Patch,
  Body,
  StreamableFile,
  BadRequestException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { AuthService } from "./auth.service.js";
@Controller("api/system")
export class SystemController {
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(LogFilesService) private logFiles: LogFilesService,
  ) {}
  @Get("branding") branding() {
    return this.config.publicBranding();
  }
  @Get("logs") async logList(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin", "operation_admin"]);
    return this.logFiles.list();
  }
  @Get("logs/:name/download") async downloadLog(
    @Req() req: FastifyRequest,
    @Param("name") name: string,
  ) {
    await this.auth.require(req, ["system_admin", "operation_admin"]);
    return this.logFiles.download(name);
  }
  @Get("logs/:name") async logs(
    @Req() req: FastifyRequest,
    @Param("name") name: string,
    @Query("lines") lines?: string,
  ) {
    await this.auth.require(req, ["system_admin", "operation_admin"]);
    return this.logFiles.tail(
      name,
      parse(z.coerce.number().default(200), lines),
    );
  }
  @Delete("logs/:name") async clearLog(
    @Req() req: FastifyRequest,
    @Param("name") name: string,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const result = await this.logFiles.remove(name);
    this.database.addAuditLog(
      result.active ? "system.log.clear" : "system.log.delete",
      JSON.stringify({ name }),
      String(user.id),
    );
    return result;
  }
  @Get("configuration") async configuration(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin"]);
    return this.config.configuration();
  }
  @Patch("configuration") async updateConfiguration(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
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
    this.database.addAuditLog(
      "system.configuration",
      JSON.stringify({ keys: Object.keys(input.values) }),
      String(user.id),
    );
    return result;
  }
  @Get("business-settings") async businessSettings(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin"]);
    return this.database.recordingSettings();
  }
  @Get("booking-defaults") async bookingDefaults(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin"]);
    return this.database.bookingDefaults();
  }
  @Patch("booking-defaults") async updateBookingDefaults(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const input = parse(
      z
        .object({
          meetingConnectionId: z.string().max(100),
          calendarConnectionIds: z.array(z.string().max(100)).max(20),
        })
        .strict(),
      body,
    );
    this.database.setState("booking.defaults", JSON.stringify(input));
    this.database.addAuditLog(
      "system.booking-defaults",
      JSON.stringify(input),
      String(user.id),
    );
    return input;
  }
  @Patch("business-settings") async updateBusinessSettings(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const input = parse(
      z
        .object({
          ttlDays: z.number().int().min(1).max(365),
          deleteRemote: z.boolean(),
        })
        .strict(),
      body,
    );
    this.database.setState("recording.settings", JSON.stringify(input));
    this.database.addAuditLog(
      "system.business-settings",
      JSON.stringify(input),
      String(user.id),
    );
    return input;
  }
  @Get("branding/:asset") asset(@Param("asset") asset: string) {
    const k =
      asset === "favicon"
        ? "platform.favicon"
        : asset === "logo"
          ? "platform.logo"
          : "";
    const name = k ? this.config.get(k) : "";
    const requestedPath =
      name && !/^https?:/.test(name)
        ? path.resolve(this.config.workspaceRoot, name)
        : "";
    const p =
      requestedPath && existsSync(requestedPath)
        ? realpathSync(requestedPath)
        : "";
    if (
      !p ||
      !existsSync(p) ||
      !statSync(p).isFile() ||
      statSync(p).size > 2 * 1024 * 1024 ||
      ![".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(
        path.extname(p).toLowerCase(),
      )
    )
      throw new NotFoundException("品牌图片不存在");
    const mime: Record<string, string> = {
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
    };
    return new StreamableFile(createReadStream(p), {
      type: mime[path.extname(p).toLowerCase()],
    });
  }
  private get backupDir() {
    return path.resolve(
      this.config.workspaceRoot,
      this.config.get("storage.data-dir"),
      "backups",
    );
  }
  @Get("backups") async backups(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin"]);
    await mkdir(this.backupDir, { recursive: true });
    const names = (await readdir(this.backupDir)).filter((n) =>
      /^backup-[\dT-]+\.sqlite$/.test(n),
    );
    return Promise.all(
      names.map(async (name) => ({
        name,
        size: (await stat(path.join(this.backupDir, name))).size,
      })),
    );
  }
  @Post("backups") async backup(@Req() req: FastifyRequest) {
    const user = await this.auth.require(req, ["system_admin"]);
    await mkdir(this.backupDir, { recursive: true });
    const name =
      "backup-" + new Date().toISOString().replace(/[:.Z]/g, "-") + ".sqlite";
    await this.database.connection.backup(path.join(this.backupDir, name));
    await chmod(path.join(this.backupDir, name), 0o600);
    this.database.addAuditLog("system.backup", name, String(user.id));
    return { name };
  }
  @Get("backups/:name") async downloadBackup(
    @Req() req: FastifyRequest,
    @Param("name") name: string,
  ) {
    await this.auth.require(req, ["system_admin"]);
    if (
      !/^backup-[\dT-]+\.sqlite$/.test(name) ||
      !existsSync(path.join(this.backupDir, name))
    )
      throw new NotFoundException("备份不存在");
    return new StreamableFile(
      createReadStream(path.join(this.backupDir, name)),
      {
        type: "application/octet-stream",
        disposition: 'attachment; filename="' + name + '"',
      },
    );
  }
}
