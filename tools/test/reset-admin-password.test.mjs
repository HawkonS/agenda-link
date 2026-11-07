import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

const exec = promisify(execFile);
const code = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const script = path.join(code, "tools/reset-admin-password.mjs");
// Must mirror apps/server/src/security.ts.
const passwordOptions = { N: 65_536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };

function encode(password) {
  const salt = "a".repeat(32);
  return `scrypt-v2$${salt}$${scryptSync(password, salt, 64, passwordOptions).toString("hex")}`;
}

function verifies(password, encoded) {
  const [version, salt, hex] = String(encoded || "").split("$");
  if (version !== "scrypt-v2" || !salt || !hex) return false;
  return scryptSync(password, salt, 64, passwordOptions).toString("hex") === hex;
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-reset-"));
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(
    path.join(root, ".runtime/initial-admin-password"),
    "old-initial-password\n",
  );
  await writeFile(
    path.join(root, "agenda-link.properties"),
    "storage.data-dir=./data\n",
  );
  const db = new Database(path.join(root, "data/agenda-link.sqlite"));
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      system_access TEXT NOT NULL DEFAULT 'allowed',
      password_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO users (username, role, password_hash) VALUES (?, ?, ?)",
  ).run("hawkon", "system_admin", encode("old-password-123"));
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    "session-1",
    1,
    new Date(Date.now() + 60_000).toISOString(),
  );
  db.close();
  return root;
}

const run = (root, args = []) =>
  exec(process.execPath, [script, ...args], {
    cwd: code,
    env: { ...process.env, AGENDA_LINK_WORKSPACE: root },
  });

test("resets the built-in hawkon password and revokes its sessions", async () => {
  const root = await workspace();
  try {
    const { stdout } = await run(root);
    const password = stdout.match(/新密码：(.+)/)?.[1]?.trim();
    assert.ok(password, stdout);
    assert.ok(password.length >= 12);
    assert.match(stdout, /hawkon（系统管理员）/);
    assert.match(stdout, /吊销 1 个登录会话/);
    assert.match(stdout, /已删除旧的 \.runtime\/initial-admin-password/);
    await access(path.join(root, ".runtime/initial-admin-password")).then(
      () => assert.fail("初始密码文件应已删除"),
      () => {},
    );

    const db = new Database(
      path.join(root, "data/agenda-link.sqlite"),
      { readonly: true },
    );
    const row = db
      .prepare("SELECT password_hash FROM users WHERE username = 'hawkon'")
      .get();
    assert.ok(verifies(password, row.password_hash));
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c, 0);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts an explicit password and can re-enable a locked account", async () => {
  const root = await workspace();
  try {
    const db = new Database(path.join(root, "data/agenda-link.sqlite"));
    db.prepare(
      "UPDATE users SET status = 'disabled', system_access = 'blocked'",
    ).run();
    db.close();

    await run(root, [
      "--user",
      "hawkon",
      "--password",
      "recovered-password-1",
      "--enable",
    ]);

    const check = new Database(
      path.join(root, "data/agenda-link.sqlite"),
      { readonly: true },
    );
    const row = check
      .prepare("SELECT password_hash, status, system_access FROM users WHERE username = 'hawkon'")
      .get();
    assert.ok(verifies("recovered-password-1", row.password_hash));
    assert.equal(row.status, "active");
    assert.equal(row.system_access, "allowed");
    check.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shell entry point works from any directory", async () => {
  const root = await workspace();
  try {
    const { stdout } = await exec(
      "bash",
      [path.join(code, "tools/reset-admin-password.sh"), "--password", "from-shell-12345"],
      { cwd: os.tmpdir(), env: { ...process.env, AGENDA_LINK_WORKSPACE: root } },
    );
    assert.match(stdout, /hawkon（系统管理员）/);
    const db = new Database(path.join(root, "data/agenda-link.sqlite"), {
      readonly: true,
    });
    const row = db
      .prepare("SELECT password_hash FROM users WHERE username = 'hawkon'")
      .get();
    assert.ok(verifies("from-shell-12345", row.password_hash));
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown users, short passwords and unknown flags", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      () => run(root, ["--user", "nobody"]),
      (error) => /未找到用户 nobody。现有系统管理员：hawkon/.test(error.stderr),
    );
    await assert.rejects(
      () => run(root, ["--password", "short"]),
      (error) => /密码长度必须为 12–256 个字符/.test(error.stderr),
    );
    await assert.rejects(
      () => run(root, ["--nope"]),
      (error) => /未知参数: --nope/.test(error.stderr),
    );
    await assert.rejects(
      () =>
        exec(process.execPath, [script], {
          cwd: code,
          env: {
            ...process.env,
            AGENDA_LINK_WORKSPACE: path.join(root, "missing"),
          },
        }),
      (error) => /未找到.*agenda-link\.properties/.test(error.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
