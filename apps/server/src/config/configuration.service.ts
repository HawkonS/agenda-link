import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import path from "node:path";
import { isIP } from "node:net";
import {
  DEFAULT_PROPERTIES,
  parseProperties,
  type Properties,
  writeProperties,
  writePropertiesSync,
} from "./properties.js";

export const secretKeys = ["auth.jwt-secret", "feishu.login.app-secret"];
export const requiredKeys = ["storage.data-dir", "logging.dir"];
function findRoot(): string {
  if (process.env.AGENDA_LINK_WORKSPACE)
    return path.resolve(process.env.AGENDA_LINK_WORKSPACE);
  let current = process.cwd();
  while (!existsSync(path.join(current, "apps"))) {
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}
@Injectable()
export class ConfigurationService {
  readonly workspaceRoot = findRoot();
  readonly filePath = path.join(this.workspaceRoot, "agenda-link.properties");
  private values: Properties = {};
  private legacyValues: Properties = {};
  private savedValues: Properties = {};
  private updateQueue: Promise<unknown> = Promise.resolve();
  static restartKeys = [
    "app.port",
    "app.bind-address",
    "web.port",
    "web.bind-address",
    "web.trust-proxy",
    "app.base-url",
    "logging.dir",
    "worker.interval-seconds",
    "security.api-rate-limit",
    "security.auth-rate-limit",
    "security.expensive-rate-limit",
    "auth.cookie-secure",
  ];
  private revision() {
    return createHash("sha256")
      .update(readFileSync(this.filePath))
      .digest("hex");
  }
  configuration() {
    const mask = (values: Properties) =>
      Object.fromEntries(
        Object.entries(values)
          .filter(
            ([k]) =>
              k !== "auth.jwt-secret" &&
              k in parseProperties(DEFAULT_PROPERTIES),
          )
          .map(([k, v]) => [k, secretKeys.includes(k) && v ? "********" : v]),
      );
    return {
      values: mask(this.savedValues),
      effective: mask(this.values),
      revision: this.revision(),
      encryptionKeyConfigured: !!this.get("auth.jwt-secret"),
      pendingRestart: ConfigurationService.restartKeys.filter(
        (k) => this.savedValues[k] !== this.values[k],
      ),
    };
  }
  retireBusinessProperties() {
    for (const key of [
      "recording.ttl-days",
      "recording.delete-remote",
      "sync.interval-minutes",
      "sync.disable-missing",
    ]) {
      delete this.savedValues[key];
      delete this.values[key];
    }
    writePropertiesSync(this.filePath, this.savedValues);
  }
  updateConfiguration(input: Properties, revision: string) {
    const task = this.updateQueue.then(async () => {
      if (revision !== this.revision())
        throw new ConflictException("配置已被修改，请重新读取后保存");
      await this.update(input);
      return this.configuration();
    });
    this.updateQueue = task.catch(() => {});
    return task;
  }
  constructor() {
    this.loadSync();
  }
  async load() {
    this.loadSync();
  }
  get(key: string) {
    return this.values[key] ?? "";
  }
  legacy(key: string) {
    return this.legacyValues[key] ?? "";
  }
  getNumber(key: string, fallback: number) {
    const value = this.get(key);
    const n = Number(value);
    return value.trim() && Number.isFinite(n) ? n : fallback;
  }
  isInitialized() {
    return true;
  }
  missingRequired(input: Properties = {}) {
    const values = { ...this.values, ...input };
    return requiredKeys.filter((k) => !values[k]?.trim());
  }
  publicBranding() {
    const asset = (k: string) =>
      ["/logo.svg", "/favicon.svg"].includes(this.get(k))
        ? this.get(k)
        : /^https?:\/\//.test(this.get(k))
          ? this.get(k)
          : this.get(k) &&
              existsSync(path.resolve(this.workspaceRoot, this.get(k)))
            ? "/api/system/branding/" + k.split(".")[1]
            : "";
    return {
      name: this.get("platform.name"),
      title: this.get("platform.title") || this.get("platform.name"),
      logo: asset("platform.logo") || "/logo.svg",
      favicon: asset("platform.favicon") || "/favicon.svg",
      primaryColor: this.get("platform.primary-color"),
      footer: this.get("platform.name"),
    };
  }
  setupDefaults(): Properties {
    const keys = [
      "storage.data-dir",
      "logging.dir",
      "app.base-url",
      "platform.name",
      "platform.title",
      "platform.logo",
      "platform.favicon",
      "platform.primary-color",
      "feishu.login.redirect-uri",
    ];
    return {
      ...Object.fromEntries(keys.map((k) => [k, this.get(k)])),
      "platform.logo": this.get("platform.logo") || "/logo.svg",
      "platform.favicon": this.get("platform.favicon") || "/favicon.svg",
    };
  }
  settings() {
    return Object.fromEntries(
      Object.entries(this.values)
        .filter(
          ([k]) =>
            ![
              "system.initialized",
              "auth.jwt-secret",
              "bootstrap.admin-password",
              // Legacy platform credentials are intentionally hidden after migration.
              "feishu.app-id",
              "feishu.app-secret",
              "feishu.redirect-uri",
              "feishu.tenant-key",
              "feishu.calendar-id",
              "feishu.root-department-id",
              "feishu.verification-token",
              "feishu.encrypt-key",
              "tencent.meeting.app-id",
              "tencent.meeting.sdk-id",
              "tencent.meeting.secret-id",
              "tencent.meeting.secret-key",
              "tencent.meeting.enterprise-id",
              "tencent.meeting.operator-id",
              "tencent.meeting.advanced-type",
            ].includes(k),
        )
        .map(([k, v]) => [
          k,
          secretKeys.includes(k) ? (v ? "********" : "") : v,
        ]),
    );
  }
  async update(input: Properties, bootstrap = false) {
    const known = Object.keys(parseProperties(DEFAULT_PROPERTIES));
    const next = { ...this.savedValues };
    for (const [k, v] of Object.entries(input)) {
      if (
        !known.includes(k) ||
        [
          "auth.jwt-secret",
          "system.initialized",
          "bootstrap.admin-password",
        ].includes(k)
      )
        continue;
      if (!bootstrap && ["storage.data-dir"].includes(k) && v !== this.get(k))
        throw new BadRequestException("初始化后数据目录只能停机迁移");
      if (typeof v !== "string" || v === "********" || /[\r\n]/.test(k))
        continue;
      if (/[\r\0]/.test(v))
        throw new BadRequestException(k + " 不能包含控制字符");
      next[k] = v.trim();
    }
    for (const k of ["app.port", "web.port"]) {
      const n = Number(next[k]);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        throw new BadRequestException(k + " 必须是有效端口");
    }
    if (next["app.port"] === next["web.port"])
      throw new BadRequestException("前后端端口不能相同");
    for (const k of ["app.bind-address", "web.bind-address"])
      if (!isIP(next[k]!))
        throw new BadRequestException(k + " 必须是有效的 IP 地址");
    if (!/^#[0-9a-f]{6}$/i.test(next["platform.primary-color"]!))
      throw new BadRequestException("主色需要 #RRGGBB 格式");
    for (const k of ["worker.interval-seconds"]) {
      const n = Number(next[k]);
      if (!Number.isInteger(n) || n < 1)
        throw new BadRequestException(k + " 必须为有效整数");
      if (n > (k === "worker.interval-seconds" ? 3600 : 10080))
        throw new BadRequestException(k + " 超出允许范围");
    }
    for (const k of [
      "app.base-url",
      "feishu.login.redirect-uri",
      "platform.logo",
      "platform.favicon",
    ]) {
      const value = next[k];
      if (!value) continue;
      if (k.startsWith("platform.") && !/^https?:/.test(value)) continue;
      try {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new Error();
      } catch {
        throw new BadRequestException(k + " 必须是有效的 HTTP(S) 地址");
      }
    }
    for (const k of ["storage.data-dir", "logging.dir"])
      if (!next[k] || /[\r\n\0]/.test(next[k]!))
        throw new BadRequestException(k + " 路径无效");
    for (const k of ["auth.cookie-secure", "web.trust-proxy"])
      if (!["true", "false"].includes(next[k]!))
        throw new BadRequestException(k + " 必须是 true 或 false");
    await writeProperties(this.filePath, next);
    this.savedValues = next;
    this.values = {
      ...next,
      ...Object.fromEntries(
        ConfigurationService.restartKeys.map((k) => [k, this.values[k]!]),
      ),
    };
    this.ensureDirs();
  }
  get databasePath() {
    return path.resolve(
      this.workspaceRoot,
      this.get("storage.data-dir") || "./data",
      "agenda-link.sqlite",
    );
  }
  get baseUrl() {
    return (
      this.get("app.base-url") ||
      "http://localhost:" + this.getNumber("web.port", 15173)
    );
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(this.get("auth.jwt-secret")).digest(),
      iv,
    );
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(".");
  }
  decrypt(value: string) {
    const parts = value.split(".");
    if (parts.length !== 3) return value;
    const cipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(this.get("auth.jwt-secret")).digest(),
      Buffer.from(parts[0]!, "base64"),
    );
    cipher.setAuthTag(Buffer.from(parts[1]!, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(parts[2]!, "base64")),
      cipher.final(),
    ]).toString("utf8");
  }
  private loadSync() {
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const defaults = parseProperties(DEFAULT_PROPERTIES);
    const saved = existsSync(this.filePath)
      ? parseProperties(readFileSync(this.filePath, "utf8"))
      : {};
    this.legacyValues = { ...saved };
    const migrated = { ...saved };
    // Migrate the old shared Feishu OAuth fields to the new login-only namespace.
    const legacyMap: Record<string, string> = {
      "feishu.app-id": "feishu.login.app-id",
      "feishu.app-secret": "feishu.login.app-secret",
      "feishu.redirect-uri": "feishu.login.redirect-uri",
      "feishu.tenant-key": "feishu.login.tenant-key",
    };
    for (const [oldKey, newKey] of Object.entries(legacyMap)) {
      if (!migrated[newKey] && migrated[oldKey])
        migrated[newKey] = migrated[oldKey]!;
      delete migrated[oldKey];
    }
    for (const key of [
      "feishu.calendar-id",
      "feishu.root-department-id",
      "feishu.verification-token",
      "feishu.encrypt-key",
      "tencent.meeting.app-id",
      "tencent.meeting.sdk-id",
      "tencent.meeting.secret-id",
      "tencent.meeting.secret-key",
      "tencent.meeting.enterprise-id",
      "tencent.meeting.operator-id",
      "tencent.meeting.advanced-type",
      "bootstrap.admin-password",
      "system.initialized",
    ])
      delete migrated[key];
    // Retired object-storage settings must no longer be exposed or persisted.
    for (const key of Object.keys(migrated)) {
      if (
        key.startsWith("oss.") ||
        key.startsWith("cos.") ||
        key === "recording.storage"
      )
        delete migrated[key];
    }
    this.values = { ...defaults, ...migrated };
    if (!this.get("auth.jwt-secret"))
      this.values["auth.jwt-secret"] = randomBytes(48).toString("base64url");
    if (
      Object.keys(saved).length !== Object.keys(this.values).length ||
      !saved["auth.jwt-secret"] ||
      Object.keys(migrated).some((key) => saved[key] !== migrated[key])
    ) {
      writePropertiesSync(this.filePath, this.values);
    }
    this.savedValues = { ...this.values };
    chmodSync(this.filePath, 0o600);
    this.ensureDirs();
  }
  private ensureDirs() {
    for (const k of ["storage.data-dir", "logging.dir"])
      mkdirSync(path.resolve(this.workspaceRoot, this.get(k)), {
        recursive: true,
        mode: 0o700,
      });
  }
}
