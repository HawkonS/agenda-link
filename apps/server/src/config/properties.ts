import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
export type Properties = Record<string, string>;
export const DEFAULT_PROPERTIES = `# agenda-link 配置，密钥留在服务器，不提交 Git。
app.port=18480
app.bind-address=127.0.0.1
web.port=15173
web.bind-address=0.0.0.0
# 仅当 Web 前面是本机反向代理时开启，代理必须覆盖 X-Forwarded-For / Host / Proto。
web.trust-proxy=false
app.base-url=
# 日志统计和日期筛选按此时区解释日期。
app.timezone=Asia/Shanghai
platform.name=AgendaLink
platform.title=议链会议日程协同平台
platform.logo=/logo.svg
platform.favicon=/favicon.svg
platform.primary-color=#1677ff
storage.data-dir=./data
logging.dir=./logs
# 同时用于登录会话签名和平台凭据加密；更换后已保存的连接凭据将无法解密。
auth.jwt-secret=
auth.cookie-secure=false
# 仅用于飞书网页登录的企业自建应用。预约、组织同步和腾讯会议凭据在系统设置中维护。
feishu.login.app-id=
feishu.login.app-secret=
feishu.login.redirect-uri=
feishu.login.tenant-key=
# 后台巡检和漏任务兜底间隔；新任务提交后立即执行。
worker.interval-seconds=60
# 每分钟请求上限（按 IP），可按部署规模调整。
security.api-rate-limit=240
security.auth-rate-limit=60
security.expensive-rate-limit=10
`;
export function parseProperties(input: string): Properties {
  const values: Properties = {};
  for (const line of input.split(/\r?\n/).map((x) => x.trim())) {
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const index = line.indexOf("=");
    if (
      index > 0 &&
      !["__proto__", "constructor", "prototype"].includes(
        line.slice(0, index).trim(),
      )
    )
      values[line.slice(0, index).trim()] = line
        .slice(index + 1)
        .replace(/\\n/g, "\n");
  }
  return values;
}
export function serializeProperties(values: Properties): string {
  return (
    Object.entries(values)
      .map(
        ([key, value]) =>
          `${key}=${value.replace(/\r/g, "").replace(/\n/g, "\\n")}`,
      )
      .join("\n") + "\n"
  );
}
export async function writeProperties(
  filePath: string,
  values: Properties,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, serializeProperties(values), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, filePath);
}

export function writePropertiesSync(filePath: string, values: Properties) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, serializeProperties(values), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporaryPath, filePath);
}
