import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);

test("hook setup targets its own checkout even when invoked from another directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-hooks-"));
  try {
    await mkdir(path.join(root, "tools"));
    const script = path.join(root, "tools/prepare.mjs");
    await copyFile(new URL("../prepare.mjs", import.meta.url), script);
    await exec("git", ["init", root]);
    await exec(process.execPath, [script], { cwd: os.tmpdir() });
    const result = await exec("git", [
      "-C",
      root,
      "config",
      "--local",
      "core.hooksPath",
    ]);
    assert.equal(result.stdout.trim(), ".githooks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service registration uses the invoking user without creating an account", async () => {
  const script = await readFile(
    new URL("../manage_service.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /SERVICE_USER="\$\{AGENDA_LINK_SERVICE_USER:-\$\{SUDO_USER:-\$\{USER:-\$\(id -un\)\}\}\}"/,
  );
  assert.doesNotMatch(script, /useradd/);
  assert.doesNotMatch(script, /SERVICE_USER=agenda-link/);
});

test("service management rejects unsafe operations before touching a running service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-management-"));
  const tools = path.join(root, "tools"),
    bin = path.join(root, "bin"),
    calls = path.join(root, "calls");
  try {
    await mkdir(tools);
    await mkdir(bin);
    const service = path.join(root, "test.service");
    await writeFile(service, "[Service]\n");
    let script = await readFile(
      new URL("../manage_service.sh", import.meta.url),
      "utf8",
    );
    script = script.replace(
      'SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"',
      "SERVICE_FILE=" + JSON.stringify(service),
    );
    await writeFile(path.join(tools, "manage_service.sh"), script);
    for (const name of ["run.sh", "stop.sh"])
      await writeFile(
        path.join(root, name),
        "#!/bin/sh\necho " + name + ' >> "$MANAGEMENT_CALLS"\n',
        { mode: 0o755 },
      );
    await writeFile(
      path.join(bin, "systemctl"),
      '#!/bin/sh\necho "systemctl $*" >> "$MANAGEMENT_CALLS"\nif [ "$1" = stop ] && [ "$MANAGEMENT_FAIL_STOP" = 1 ]; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    await writeFile(path.join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', {
      mode: 0o755,
    });
    await writeFile(
      path.join(bin, "npm"),
      '#!/bin/sh\necho npm >> "$MANAGEMENT_CALLS"\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MANAGEMENT_CALLS: calls,
    };
    const run = (args, extra = {}) =>
      exec("bash", [path.join(tools, "manage_service.sh"), ...args], {
        cwd: root,
        env: { ...env, ...extra },
      });
    const log = () => readFile(calls, "utf8").catch(() => "");
    await t.test("help has no service side effects", async () => {
      assert.match((await run(["--help"])).stdout, /restore/);
      assert.equal(await log(), "");
    });
    await t.test(
      "missing or nonexistent restore path does not stop the service",
      async () => {
        await assert.rejects(() => run(["restore"]), /restore/);
        await assert.rejects(
          () => run(["restore", path.join(root, "missing")]),
          /找不到备份/,
        );
        assert.equal(await log(), "");
      },
    );
    await t.test(
      "reinstall refuses to mutate a running deployment",
      async () => {
        await assert.rejects(() => run(["install"]), /服务正在运行/);
        assert.equal(
          await log(),
          "systemctl is-active --quiet agenda-link.service\n",
        );
      },
    );
    await t.test(
      "a failed stop is a failure, not a successful stop",
      async () => {
        await assert.rejects(
          () => run(["stop"], { MANAGEMENT_FAIL_STOP: "1" }),
          (error) => {
            assert.ok(!error.stdout.includes("服务已停止"));
            return true;
          },
        );
        assert.ok(
          (await log()).endsWith("systemctl stop agenda-link.service\n"),
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop script accepts help and rejects malformed or process-group PIDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-stop-"));
  try {
    await mkdir(path.join(root, ".runtime"));
    const stop = new URL("../../stop.sh", import.meta.url).pathname;
    const env = { ...process.env, AGENDA_LINK_WORKSPACE: root };
    assert.match(
      (await exec("bash", [stop, "--help"], { env })).stdout,
      /用法/,
    );
    await assert.rejects(
      () => exec("bash", [stop, "--unknown"], { env }),
      /未知参数/,
    );
    for (const pid of ["-1", "0", "1", "not-a-pid"]) {
      await writeFile(
        path.join(root, ".runtime/pids"),
        "supervisor=" + pid + "\n",
      );
      await assert.rejects(() => exec("bash", [stop], { env }), /无效 PID/);
      assert.match(
        await readFile(path.join(root, ".runtime/pids"), "utf8"),
        /supervisor=/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
