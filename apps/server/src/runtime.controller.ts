import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createConnection } from "node:net";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigurationService } from "./config/configuration.service.js";
import { AuthService } from "./auth.service.js";
import { DatabaseService } from "./database.service.js";
import { WorkerService } from "./worker.service.js";
import { parse } from "./validation.js";

export const bootId = randomUUID();
const revisionCache = new Map<string, string>();
export function revision(root: string) {
  if (revisionCache.has(root)) return revisionCache.get(root)!;
  try {
    const value = execFileSync(
      "git",
      ["-c", "safe.directory=" + root, "rev-parse", "HEAD"],
      { cwd: root, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    revisionCache.set(root, value);
    return value;
  } catch {
    revisionCache.set(root, "");
    return "";
  }
}
export async function maintenanceRequest(data: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(
      "/run/agenda-link-maintenance/control.sock",
    );
    let buffer = "";
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("维护服务响应超时")),
    );
    socket.on("connect", () => socket.write(JSON.stringify(data) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 262144) {
        socket.destroy(new Error("维护结果过长"));
        return;
      }
      if (buffer.includes("\n")) {
        try {
          const response = JSON.parse(buffer.split("\n")[0]!);
          socket.end();
          response.ok
            ? resolve(response.data)
            : reject(new ConflictException(response.error));
        } catch (e) {
          socket.destroy();
          reject(e);
        }
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n")) reject(new Error("维护服务连接中断"));
    });
  });
}
@Controller("api/system/runtime")
export class RuntimeController {
  private readonly commit: string;
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(WorkerService) private worker: WorkerService,
  ) {
    this.commit = revision(config.workspaceRoot);
  }
  @Get() async status(@Req() req: FastifyRequest) {
    await this.auth.require(req, ["system_admin"]);
    let maintenance: any = {
      available: false,
      reason:
        "未安装 systemd 维护服务，请通过 SSH 执行 sudo tools/install-maintenance.sh。",
    };
    try {
      maintenance = await maintenanceRequest({ method: "status" });
    } catch {
      /* Local development has no systemd broker. */
    }
    let web = false;
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.config.get("web.port")}/api/health`,
        { signal: AbortSignal.timeout(1500) },
      );
      web = response.ok;
    } catch {}
    let pkg = { version: "0.1.0" };
    try {
      pkg = JSON.parse(
        readFileSync(
          path.join(this.config.workspaceRoot, "package.json"),
          "utf8",
        ),
      );
    } catch {}
    return {
      version: pkg.version,
      revision: this.commit,
      bootId,
      uptime: Math.floor(process.uptime()),
      api: true,
      web,
      worker: this.worker.runtimeStatus(),
      ports: {
        api: this.config.get("app.port"),
        web: this.config.get("web.port"),
      },
      mode: maintenance.available ? "systemd" : "standalone",
      maintenance,
    };
  }
  @Post("operations") async submit(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const input = parse(
      z
        .object({
          action: z.enum([
            "restart",
            "stop",
            "check-update",
            "upgrade",
            "enable",
            "disable",
          ]),
        })
        .strict(),
      body,
    );
    if (process.platform !== "linux")
      throw new BadRequestException("当前环境不支持 systemd 维护操作");
    const result = await maintenanceRequest({
      method: "submit",
      action: input.action,
      bootId,
    }).catch((e) => {
      if (e instanceof ConflictException) throw e;
      throw new BadRequestException("维护服务不可用，请通过 SSH 检查");
    });
    this.database.addAuditLog(
      "system.maintenance",
      JSON.stringify({ id: result.id, action: input.action }),
      String(user.id),
    );
    return result;
  }
}
