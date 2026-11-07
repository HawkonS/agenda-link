import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { ConfigurationService } from "./config/configuration.service.js";
@Injectable()
export class LogFilesService {
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
  ) {}
  private valid(name: string) {
    return (
      /^[\w.-]+\.log(?:[.-][\w-]+)?$/.test(name) &&
      !name.endsWith(".gz") &&
      !name.includes("..")
    );
  }
  private async directory() {
    const directory = path.resolve(
      this.config.workspaceRoot,
      this.config.get("logging.dir"),
    );
    if ((await lstat(directory)).isSymbolicLink())
      throw new BadRequestException("日志目录不能是符号链接");
    return realpath(directory);
  }
  private failure(error: unknown): never {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new NotFoundException("日志已轮转或删除，请刷新文件列表");
    if (code === "EACCES" || code === "EPERM")
      throw new ForbiddenException("没有读取该日志的权限");
    if (code === "ELOOP") throw new BadRequestException("不能访问符号链接");
    throw error;
  }
  private async file(name: string, write = false) {
    if (!this.valid(name)) throw new BadRequestException("无效的日志文件名");
    try {
      const filename = path.join(await this.directory(), name);
      const handle = await open(
        filename,
        (write ? constants.O_RDWR : constants.O_RDONLY) |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) {
        await handle.close();
        throw new BadRequestException("只允许访问普通日志文件");
      }
      return { handle, info, filename };
    } catch (e) {
      this.failure(e);
    }
  }
  async list() {
    try {
      const directory = await this.directory();
      const items = [];
      for (const name of await readdir(directory)) {
        if (!this.valid(name)) continue;
        try {
          const info = await lstat(path.join(directory, name));
          if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
            items.push({
              name,
              size: info.size,
              modifiedAt: info.mtime.toISOString(),
              active: ["server.log", "web.log"].includes(name),
            });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      return items.sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          b.modifiedAt.localeCompare(a.modifiedAt),
      );
    } catch (e) {
      this.failure(e);
    }
  }
  async tail(name: string, lines: number) {
    if (![200, 500, 1000].includes(lines))
      throw new BadRequestException("仅支持 200、500、1000 行");
    const { handle, info } = await this.file(name);
    try {
      const size = Math.min(info.size, 1024 * 1024);
      const buffer = Buffer.alloc(size);
      const offset = Math.max(0, info.size - size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        const first = text.indexOf("\n");
        text = first < 0 ? text : text.slice(first + 1);
      }
      const rows = text.replace(/\n$/, "").split("\n");
      return {
        name,
        text: rows.slice(-lines).join("\n"),
        truncated: offset > 0 || rows.length > lines,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }
  async download(name: string) {
    const { handle } = await this.file(name);
    return new StreamableFile(handle.createReadStream(), {
      type: "text/plain; charset=utf-8",
      disposition: `attachment; filename="${name}"`,
    });
  }
  async remove(name: string) {
    const { handle, filename, info } = await this.file(name, true);
    const active = ["server.log", "web.log"].includes(name);
    try {
      if (active) await handle.truncate(0);
      else {
        const current = await lstat(filename);
        if (current.ino !== info.ino || current.dev !== info.dev)
          throw new BadRequestException("日志已轮转，请刷新后重试");
        await unlink(filename);
      }
      return { ok: true, active };
    } finally {
      await handle.close();
    }
  }
}
