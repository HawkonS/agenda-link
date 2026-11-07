#!/usr/bin/env node
// 重置内置管理员密码。直接改写 SQLite 中的密码哈希，服务运行中也可执行。
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { configuration, root } from "./config.mjs";

const DEFAULT_ADMIN_USERNAME = "hawkon";
// 必须与 apps/server/src/security.ts 中的 passwordOptions 一致，否则新密码无法通过登录校验。
const passwordOptions = { N: 65_536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

const usage = `用法: ./tools/reset-admin-password.sh [选项]
      node tools/reset-admin-password.mjs [选项]

重置管理员登录密码并吊销其现有登录会话。

选项:
  -u, --user <用户名>    要重置的账号，默认 ${DEFAULT_ADMIN_USERNAME}
  -p, --password <密码>  指定新密码（会留在 shell 历史中，建议省略以随机生成）
      --password-stdin   从标准输入读取新密码
      --enable           同时启用账号并恢复系统访问权限
  -h, --help             显示本帮助
`;

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

function parse(argv) {
  const options = {
    username: DEFAULT_ADMIN_USERNAME,
    password: "",
    fromStdin: false,
    enable: false,
    help: false,
  };
  const takeValue = (name, index) => {
    const value = argv[index];
    if (!value || value.startsWith("-")) fail(`参数 ${name} 缺少取值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-u" || arg === "--user") {
      options.username = takeValue(arg, i + 1);
      i += 1;
    } else if (arg.startsWith("--user="))
      options.username = arg.slice("--user=".length);
    else if (arg === "-p" || arg === "--password") {
      options.password = takeValue(arg, i + 1);
      i += 1;
    } else if (arg.startsWith("--password="))
      options.password = arg.slice("--password=".length);
    else if (arg === "--password-stdin") options.fromStdin = true;
    else if (arg === "--enable") options.enable = true;
    else fail(`未知参数: ${arg}\n\n${usage}`);
  }
  if (options.password && options.fromStdin)
    fail("--password 与 --password-stdin 不能同时使用");
  if (!options.username?.trim()) fail("--user 不能为空");
  return options;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64, passwordOptions).toString(
    "hex",
  );
  return `scrypt-v2$${salt}$${derived}`;
}

const roleLabel = (role) =>
  ({ system_admin: "系统管理员", operation_admin: "运营管理员" })[role] ||
  "普通用户";

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  let config;
  try {
    config = configuration();
  } catch {
    fail(`未找到 ${path.join(root, "agenda-link.properties")}，请在项目目录或 AGENDA_LINK_WORKSPACE 下执行`);
  }
  const databaseFile = path.resolve(
    root,
    config["storage.data-dir"] || "./data",
    "agenda-link.sqlite",
  );
  if (!existsSync(databaseFile))
    fail(`未找到数据库：${databaseFile}\n请先启动一次服务完成初始化`);

  let password = options.fromStdin
    ? readFileSync(0, "utf8").trim()
    : options.password;
  const generated = !password;
  if (generated) password = randomBytes(18).toString("base64url");
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  )
    fail(
      `密码长度必须为 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符（当前 ${password.length}）`,
    );

  const db = new Database(databaseFile);
  try {
    // 服务可能正在运行，稍等它的写锁而不是立即失败。
    db.pragma("busy_timeout = 5000");
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
        .get()
    )
      fail(`不是 agenda-link 数据库：${databaseFile}`);

    const user = db
      .prepare(
        "SELECT id, username, role, status, system_access FROM users WHERE username = ?",
      )
      .get(options.username);
    if (!user) {
      const admins = db
        .prepare(
          "SELECT username FROM users WHERE role = 'system_admin' ORDER BY id",
        )
        .all()
        .map((row) => row.username);
      fail(
        `未找到用户 ${options.username}。` +
          (admins.length
            ? `现有系统管理员：${admins.join("、")}（可用 --user 指定）`
            : "当前没有任何系统管理员。"),
      );
    }

    const now = new Date().toISOString();
    const updated = db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(password), now, user.id);
    if (updated.changes !== 1) fail("更新密码失败，未写入任何记录");
    const revoked = db
      .prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(user.id).changes;
    if (options.enable)
      db.prepare(
        "UPDATE users SET status = 'active', system_access = 'allowed', updated_at = ? WHERE id = ?",
      ).run(now, user.id);
    // 初始密码文件在首次登录后就不该再保留明文。
    const initialPasswordFile = path.join(
      root,
      ".runtime",
      "initial-admin-password",
    );
    let cleanedInitial = false;
    if (user.username === DEFAULT_ADMIN_USERNAME && existsSync(initialPasswordFile)) {
      unlinkSync(initialPasswordFile);
      cleanedInitial = true;
    }

    console.log(
      `已重置 ${user.username}（${roleLabel(user.role)}）的密码。`,
    );
    console.log(
      generated ? `新密码：${password}` : "新密码：已按参数设置（不回显）",
    );
    if (revoked) console.log(`已吊销 ${revoked} 个登录会话。`);
    if (cleanedInitial) console.log("已删除旧的 .runtime/initial-admin-password。");
    if (user.role !== "system_admin")
      console.log("提示：该账号不是系统管理员。");
    if (
      !options.enable &&
      (user.status !== "active" || user.system_access !== "allowed")
    )
      console.log("注意：该账号当前被停用或禁止访问，可加 --enable 一并恢复。");
    console.log("请登录后立即修改密码。");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
