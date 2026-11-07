import Database from "better-sqlite3";
import {
  existsSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { root, configuration } from "./config.mjs";
const config = configuration(),
  database = path.resolve(
    root,
    config["storage.data-dir"],
    "agenda-link.sqlite",
  );
const command = process.argv[2],
  argument = process.argv[3];
const stamp = () => new Date().toISOString().replace(/[:.Z]/g, "-");
function stopped() {
  for (const name of [".runtime/server.lock", ".runtime/pids"]) {
    const p = path.join(root, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const pids = name.endsWith(".lock")
      ? [content]
      : content.split("\n").map((l) => l.split("=")[1]);
    for (const p of pids) {
      if (!/^\d+$/.test(p || "")) continue;
      try {
        process.kill(Number(p), 0);
      } catch {
        continue;
      }
      throw new Error("服务仍在运行，请先停止");
    }
  }
}
async function backup(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    await db.backup(path.join(directory, "agenda-link.sqlite"));
    chmodSync(path.join(directory, "agenda-link.sqlite"), 0o600);
  } finally {
    db.close();
  }
  copyFileSync(
    path.join(root, "agenda-link.properties"),
    path.join(directory, "agenda-link.properties"),
  );
  chmodSync(path.join(directory, "agenda-link.properties"), 0o600);
  return directory;
}
try {
  if (command === "backup") {
    console.log(
      await backup(
        path.resolve(argument || path.join(root, ".runtime/backups", stamp())),
      ),
    );
  } else if (command === "restore") {
    stopped();
    if (!argument)
      throw new Error(
        "用法: node tools/database.mjs restore <SQLite 文件或备份目录>",
      );
    const supplied = path.resolve(argument),
      source = supplied.endsWith(".sqlite")
        ? supplied
        : path.join(supplied, "agenda-link.sqlite");
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("SQLite 校验失败");
      for (const table of ["users", "meetings", "jobs"])
        if (
          !db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table)
        )
          throw new Error("不是 agenda-link 数据库");
    } finally {
      db.close();
    }
    if (existsSync(database))
      await backup(
        path.join(root, ".runtime/backups", "before-restore-" + stamp()),
      );
    const configSource = supplied.endsWith(".sqlite")
      ? null
      : path.join(supplied, "agenda-link.properties");
    let destination = database;
    if (configSource && existsSync(configSource)) {
      const match = readFileSync(configSource, "utf8").match(
        /^storage.data-dir=(.+)$/m,
      );
      if (!match) throw new Error("备份配置缺少数据目录");
      destination = path.resolve(root, match[1].trim(), "agenda-link.sqlite");
    }
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(destination + suffix)) unlinkSync(destination + suffix);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    if (configSource && existsSync(configSource)) {
      copyFileSync(configSource, path.join(root, "agenda-link.properties"));
      chmodSync(path.join(root, "agenda-link.properties"), 0o600);
    }
    console.log(
      "恢复完成。请启动服务验证；恢复前快照保存在 .runtime/backups。",
    );
  } else
    throw new Error(
      "用法: node tools/database.mjs backup [目录] | restore <文件或目录>",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
