import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
const exec = promisify(execFile),
  code = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startupDiagnostics(root, output, directory = "logs") {
  const logs = await Promise.all(
    ["server.log", "web.log"].map(async (name) => {
      const content = await readFile(
        path.join(root, directory, name),
        "utf8",
      ).catch(() => "日志文件未生成");
      return `\n${name}:\n${content.slice(-8000)}`;
    }),
  );
  return output + logs.join("");
}
test(
  "production launch, proxy, custom paths, backup, stopped restore and shutdown",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-production-")),
      apiPort = await freePort(),
      webPort = await freePort();
    const env = {
      ...process.env,
      AGENDA_LINK_WORKSPACE: root,
      AGENDA_LINK_DISABLE_WORKER: "true",
    };
    let child;
    let output = "";
    try {
      await exec(
        process.execPath,
        [
          path.join(code, "node_modules/tsx/dist/cli.mjs"),
          path.join(code, "tools/configure.ts"),
        ],
        { cwd: code, env },
      );
      const props = path.join(root, "agenda-link.properties");
      let content = await readFile(props, "utf8");
      content = content
        .replace(/^app.port=.*$/m, "app.port=" + apiPort)
        .replace(/^web.port=.*$/m, "web.port=" + webPort)
        .replace(/^logging.dir=.*$/m, "logging.dir=./custom-logs")
        .replace(
          /^app.base-url=.*$/m,
          "app.base-url=http://127.0.0.1:" + webPort,
        );
      await writeFile(props, content, { mode: 0o600 });
      child = spawn("bash", [path.join(code, "run.sh"), "--no-build"], {
        cwd: code,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const base = "http://127.0.0.1:" + webPort;
      let healthy = false;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(base + "/api/health");
          if (r.ok) {
            healthy = true;
            break;
          }
        } catch {}
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(healthy, await startupDiagnostics(root, output, "custom-logs"));
      assert.equal(
        (await fetch(base + "/api/health").then((r) => r.json())).initialized,
        true,
      );
      assert.match(
        await fetch(base + "/meetings").then((r) => r.text()),
        /<div id="root"><\/div>/,
      );
      assert.equal((await fetch(base + "/missing.js")).status, 404);
      const branding = await fetch(base + "/api/system/branding").then((r) =>
        r.json(),
      );
      for (const asset of [branding.logo, branding.favicon]) {
        const image = await fetch(base + asset);
        assert.equal(image.status, 200);
        assert.match(image.headers.get("content-type"), /image\/svg\+xml/);
        assert.match(await image.text(), /<svg/);
      }
      assert.equal((await stat(props)).mode & 0o777, 0o600);
      assert.ok(
        (await stat(path.join(root, "custom-logs/server.log"))).isFile(),
      );
      const initialPassword = (
        await readFile(
          path.join(root, ".runtime/initial-admin-password"),
          "utf8",
        )
      ).trim();
      const login = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ username: "hawkon", password: initialPassword }),
      });
      assert.equal(login.status, 201);
      const cookie = login.headers.get("set-cookie").split(";")[0];
      assert.equal(
        (await fetch(base + "/api/users", { headers: { cookie } })).status,
        200,
      );
      assert.equal(
        (await fetch(base + "/api/auth/feishu/status").then((r) => r.json()))
          .enabled,
        false,
      );
      assert.equal(
        (await fetch(base + "/api/dashboard/summary", { headers: { cookie } }))
          .status,
        200,
      );
      await assert.rejects(
        () =>
          exec("bash", [path.join(code, "run.sh"), "--no-build"], {
            cwd: code,
            env,
          }),
        /已经运行/,
      );
      assert.equal(
        (await fetch(base + "/api/health").then((r) => r.json())).status,
        "ok",
      );
      const savedProperties = await readFile(props, "utf8");
      const backup = path.join(root, "snapshot");
      await exec(
        process.execPath,
        [path.join(code, "tools/database.mjs"), "backup", backup],
        { cwd: code, env },
      );
      await assert.rejects(() =>
        exec(
          process.execPath,
          [path.join(code, "tools/database.mjs"), "restore", backup],
          { cwd: code, env },
        ),
      );
      await exec("bash", [path.join(code, "stop.sh")], { cwd: code, env });
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
      const dbfile = path.join(root, "data/agenda-link.sqlite"),
        db = new Database(dbfile);
      db.prepare("UPDATE users SET display_name=? WHERE username=?").run(
        "changed",
        "hawkon",
      );
      db.close();
      await exec(
        process.execPath,
        [path.join(code, "tools/database.mjs"), "restore", backup],
        { cwd: code, env },
      );
      const restored = new Database(dbfile);
      assert.equal(
        restored
          .prepare("SELECT display_name FROM users WHERE username=?")
          .get("hawkon").display_name,
        "系统管理员",
      );
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
      restored.close();
      await assert.rejects(() => fetch(base + "/api/health"));
      await exec("bash", [path.join(code, "stop.sh")], { cwd: code, env });
      child = spawn("bash", [path.join(code, "run.sh"), "--no-build"], {
        cwd: code,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      let restarted = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) {
            restarted = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(restarted, output);
      assert.equal(await readFile(props, "utf8"), savedProperties);
      assert.equal(
        (
          await readFile(
            path.join(root, ".runtime/initial-admin-password"),
            "utf8",
          )
        ).trim(),
        initialPassword,
      );
      await exec("bash", [path.join(code, "stop.sh")], { cwd: code, env });
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
      await assert.rejects(() => fetch(base + "/api/health"));
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "development mode serves Vite and API then stops the watcher and both ports",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-development-"));
    const apiPort = await freePort(),
      webPort = await freePort();
    const env = {
      ...process.env,
      AGENDA_LINK_WORKSPACE: root,
      AGENDA_LINK_DISABLE_WORKER: "true",
    };
    let child,
      output = "";
    try {
      await exec(
        process.execPath,
        [
          path.join(code, "node_modules/tsx/dist/cli.mjs"),
          path.join(code, "tools/configure.ts"),
        ],
        { cwd: code, env },
      );
      const properties = path.join(root, "agenda-link.properties");
      await writeFile(
        properties,
        (await readFile(properties, "utf8"))
          .replace(/^app.port=.*$/m, "app.port=" + apiPort)
          .replace(/^web.port=.*$/m, "web.port=" + webPort)
          .replace(
            /^app.base-url=.*$/m,
            "app.base-url=http://127.0.0.1:" + webPort,
          ),
      );
      child = spawn("bash", [path.join(code, "run.sh"), "--dev"], {
        cwd: code,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const base = "http://127.0.0.1:" + webPort;
      let healthy = false;
      for (let i = 0; i < 150; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) {
            healthy = true;
            break;
          }
        } catch {}
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(healthy, await startupDiagnostics(root, output));
      assert.match(await fetch(base).then((r) => r.text()), /@vite\/client/);
      await exec("bash", [path.join(code, "stop.sh")], { cwd: code, env });
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
      for (const port of [apiPort, webPort])
        await assert.rejects(() =>
          fetch("http://127.0.0.1:" + port + "/api/health"),
        );
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
