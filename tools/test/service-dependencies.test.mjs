import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

async function fixture(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-service-deps-"));
  const bin = path.join(root, "bin");
  const tools = path.join(root, "tools");
  const calls = path.join(root, "calls");
  const unit = path.join(root, "test.service");
  const system = path.join(root, "system");
  const binaries = {
    python3: path.join(system, "python3"),
    setpriv: path.join(system, "setpriv"),
    runuser: path.join(system, "runuser"),
  };
  const executable = (filename, content = "#!/bin/sh\nexit 0\n") =>
    writeFile(filename, content, { mode: 0o755 });
  try {
    await mkdir(bin);
    await mkdir(tools);
    await mkdir(system);
    const dirname = (
      await exec("/bin/bash", ["-c", "command -v dirname"])
    ).stdout.trim();
    await symlink(dirname, path.join(bin, "dirname"));
    await symlink("/bin/bash", path.join(bin, "bash"));
    if (options.node !== "missing") {
      if (options.node === "old")
        await executable(path.join(bin, "node"), "#!/bin/sh\nexit 1\n");
      else await symlink(process.execPath, path.join(bin, "node"));
    }
    await executable(
      path.join(bin, "id"),
      '#!/bin/sh\nprintf "%s\\n" "${SERVICE_TEST_UID:-0}"\n',
    );
    await executable(path.join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
    await executable(
      path.join(bin, "systemctl"),
      `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$SERVICE_TEST_CALLS"
[ "\${SERVICE_TEST_SYSTEMD_FAILURE:-}" != 1 ] || exit 1
[ "$1" != is-active ] || exit 3
if [ "$2" = --property=Version ]; then printf '999\\n'; fi
if [ "$2" = agenda-link.service ]; then printf 'service-user\\n'; fi
`,
    );
    await executable(
      path.join(bin, "npm"),
      '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$SERVICE_TEST_CALLS"\n',
    );
    for (const filename of ["run.sh", "stop.sh"])
      await executable(path.join(root, filename));
    for (const name of options.available ?? ["python3", "setpriv", "runuser"])
      await executable(binaries[name]);
    let installer = await readFile(
      new URL("../install-maintenance.sh", import.meta.url),
      "utf8",
    );
    installer = installer
      .replaceAll("/usr/bin/python3", binaries.python3)
      .replaceAll("/usr/bin/setpriv", binaries.setpriv)
      .replaceAll("/usr/sbin/runuser", binaries.runuser);
    await executable(path.join(tools, "install-maintenance.sh"), installer);
    const manager = (
      await readFile(new URL("../manage_service.sh", import.meta.url), "utf8")
    ).replace(
      'SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"',
      'SERVICE_FILE="$PROJECT_ROOT/test.service"',
    );
    await executable(path.join(tools, "manage_service.sh"), manager);
    if (options.existingUnit)
      await writeFile(unit, "previous service configuration\n");
    if (options.packageManager) {
      await executable(
        path.join(bin, options.packageManager),
        `#!/bin/sh
printf '${options.packageManager} %s\\n' "$*" >> "$SERVICE_TEST_CALLS"
[ "\${SERVICE_TEST_PACKAGE_FAILURE:-}" != "$1" ] || exit 1
if [ "$1" = install ] && [ "\${SERVICE_TEST_INCOMPLETE:-}" != 1 ]; then
  for package in "$@"; do
    case "$package" in
      python3)
        printf '#!/bin/sh\\nexit 0\\n' > "$SERVICE_TEST_PYTHON"
        /bin/chmod 755 "$SERVICE_TEST_PYTHON"
        ;;
      util-linux)
        printf '#!/bin/sh\\nexit 0\\n' > "$SERVICE_TEST_SETPRIV"
        printf '#!/bin/sh\\nexit 0\\n' > "$SERVICE_TEST_RUNUSER"
        /bin/chmod 755 "$SERVICE_TEST_SETPRIV" "$SERVICE_TEST_RUNUSER"
        ;;
    esac
  done
fi
`,
      );
    }
    const env = {
      ...process.env,
      PATH: bin,
      SERVICE_TEST_CALLS: calls,
      SERVICE_TEST_PYTHON: binaries.python3,
      SERVICE_TEST_SETPRIV: binaries.setpriv,
      SERVICE_TEST_RUNUSER: binaries.runuser,
    };
    const invoke = (name, args, extra = {}) =>
      exec("/bin/bash", [path.join(tools, name), ...args], {
        cwd: root,
        env: { ...env, ...extra },
      });
    await run({
      root,
      unit,
      binaries,
      executable,
      log: () => readFile(calls, "utf8").catch(() => ""),
      preflight: (extra) =>
        invoke("install-maintenance.sh", ["--prepare-dependencies"], extra),
      install: (extra) => invoke("manage_service.sh", ["install"], extra),
      installMaintenance: (extra) =>
        invoke("install-maintenance.sh", [], extra),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function failsWith(pattern) {
  return (error) => {
    assert.match(error.stdout + error.stderr, pattern);
    return true;
  };
}

function assertNoRegistration(log) {
  assert.doesNotMatch(
    log,
    /npm |systemctl (?:enable|start|restart|daemon-reload)/,
  );
}

test("service dependency setup stays ahead of service registration", async (t) => {
  await t.test(
    "installed dependencies need no package manager or service changes",
    () =>
      fixture({}, async ({ preflight, log }) => {
        await preflight();
        assert.equal(
          await log(),
          "systemctl show --property=Version --value\n",
        );
      }),
  );

  await t.test(
    "apt installs only missing Python after refreshing package metadata",
    () =>
      fixture(
        { available: ["setpriv", "runuser"], packageManager: "apt-get" },
        async ({ preflight, log, binaries }) => {
          await preflight();
          assert.match(
            await log(),
            /apt-get update\napt-get install -y -- python3\n$/,
          );
          await exec(binaries.python3, []);
          assertNoRegistration(await log());
        },
      ),
  );

  await t.test("dnf installs util-linux when runuser is missing", () =>
    fixture(
      { available: ["python3", "setpriv"], packageManager: "dnf" },
      async ({ preflight, log, binaries }) => {
        await preflight();
        assert.match(await log(), /dnf install -y -- util-linux\n$/);
        await exec(binaries.runuser, []);
        assertNoRegistration(await log());
      },
    ),
  );

  await t.test(
    "yum installs both packages when required tools are absent",
    () =>
      fixture(
        { available: [], packageManager: "yum" },
        async ({ preflight, log }) => {
          await preflight();
          assert.match(await log(), /yum install -y -- python3 util-linux\n$/);
          assertNoRegistration(await log());
        },
      ),
  );

  await t.test(
    "unusable Python is repaired and dependencies are checked again",
    () =>
      fixture(
        { packageManager: "apt-get" },
        async ({ executable, binaries, preflight, log }) => {
          await executable(binaries.python3, "#!/bin/sh\nexit 1\n");
          await preflight();
          assert.match(await log(), /apt-get install -y -- python3\n$/);
          await exec(binaries.python3, []);
        },
      ),
  );

  await t.test(
    "failed metadata refresh never attempts package installation",
    () =>
      fixture(
        { available: [], packageManager: "apt-get" },
        async ({ preflight, log }) => {
          await assert.rejects(
            () => preflight({ SERVICE_TEST_PACKAGE_FAILURE: "update" }),
            failsWith(/系统依赖安装失败/),
          );
          assert.doesNotMatch(await log(), /apt-get install/);
          assertNoRegistration(await log());
        },
      ),
  );

  for (const existingUnit of [false, true]) {
    await t.test(
      `package failure preserves ${existingUnit ? "existing" : "absent"} main service registration`,
      () =>
        fixture(
          { available: [], packageManager: "dnf", existingUnit },
          async ({ install, unit, log }) => {
            await assert.rejects(
              () => install({ SERVICE_TEST_PACKAGE_FAILURE: "install" }),
              failsWith(/系统依赖安装失败/),
            );
            assertNoRegistration(await log());
            if (existingUnit)
              assert.equal(
                await readFile(unit, "utf8"),
                "previous service configuration\n",
              );
            else await assert.rejects(() => readFile(unit), { code: "ENOENT" });
          },
        ),
    );
  }

  await t.test(
    "a package manager success without usable binaries is rejected",
    () =>
      fixture(
        { available: [], packageManager: "yum" },
        async ({ preflight, log }) => {
          await assert.rejects(
            () => preflight({ SERVICE_TEST_INCOMPLETE: "1" }),
            failsWith(/安装后依赖仍不可用/),
          );
          assertNoRegistration(await log());
        },
      ),
  );

  await t.test(
    "unsupported package managers produce manual installation guidance",
    () =>
      fixture({ available: [] }, async ({ preflight, log }) => {
        await assert.rejects(
          () => preflight(),
          failsWith(/手动安装 Python 3 和 util-linux/),
        );
        assertNoRegistration(await log());
      }),
  );

  await t.test(
    "unavailable systemd is rejected before installing packages",
    () =>
      fixture(
        { available: [], packageManager: "apt-get" },
        async ({ preflight, log }) => {
          await assert.rejects(
            () => preflight({ SERVICE_TEST_SYSTEMD_FAILURE: "1" }),
            failsWith(/无法连接 systemd/),
          );
          assert.doesNotMatch(await log(), /apt-get/);
        },
      ),
  );

  await t.test("an unprivileged caller cannot install system packages", () =>
    fixture(
      { available: [], packageManager: "apt-get" },
      async ({ preflight, log }) => {
        await assert.rejects(
          () => preflight({ SERVICE_TEST_UID: "1000" }),
          failsWith(/请使用 sudo/),
        );
        assert.equal(await log(), "");
      },
    ),
  );

  for (const node of ["missing", "old"]) {
    await t.test(
      `${node} Node.js is rejected before any registration or package installation`,
      () =>
        fixture(
          { available: [], packageManager: "apt-get", node },
          async ({ install, log }) => {
            await assert.rejects(() => install(), failsWith(/Node.js/));
            assert.equal(await log(), "");
          },
        ),
    );
  }

  await t.test(
    "standalone maintenance installation has the same dependency failure protection",
    () =>
      fixture(
        { available: [], packageManager: "yum" },
        async ({ installMaintenance, log }) => {
          await assert.rejects(
            () =>
              installMaintenance({ SERVICE_TEST_PACKAGE_FAILURE: "install" }),
            failsWith(/系统依赖安装失败/),
          );
          assertNoRegistration(await log());
        },
      ),
  );
});
