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
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const exec = promisify(execFile);
test("upgrade stages before shutdown, switches atomically and restores on failed health check", async (t) => {
  for (const mode of [
    "success",
    "rebuild",
    "prepare-failure",
    "health-failure",
  ])
    await t.test(mode, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "agenda-link-upgrade-")),
        source = path.join(dir, "source"),
        root = path.join(dir, "checkout"),
        bin = path.join(dir, "bin");
      const env = {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        UPGRADE_MODE: mode,
        UPGRADE_STATE: dir,
      };
      const git = (cwd, ...args) => exec("git", args, { cwd, env });
      try {
        await mkdir(source);
        await mkdir(bin);
        await mkdir(path.join(source, "tools"));
        await copyFile(
          new URL("../upgrade.sh", import.meta.url),
          path.join(source, "tools/upgrade.sh"),
        );
        await writeFile(
          path.join(source, ".gitignore"),
          ".runtime/\nnode_modules/\napps/*/dist/\nagenda-link.properties\n",
        );
        await writeFile(path.join(source, "version.txt"), "v1");
        await writeFile(path.join(source, "stop.sh"), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        });
        await writeFile(
          path.join(source, "tools/config.mjs"),
          "export function configuration(){return {'web.port':'18780'}}",
        );
        await writeFile(
          path.join(source, "tools/database.mjs"),
          "import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import path from 'node:path';const [command,dir]=process.argv.slice(2);if(command==='backup'){mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'fixture'),readFileSync('version.txt'));}else writeFileSync(path.join(process.env.UPGRADE_STATE,'restored'),'yes');",
        );
        await git(source, "init", "-b", "main");
        await git(source, "config", "user.name", "Upgrade Test");
        await git(source, "config", "user.email", "test@example.invalid");
        await git(source, "add", ".");
        await git(source, "commit", "-m", "test: initial fixture");
        await git(dir, "clone", source, root);
        const old = (await git(root, "rev-parse", "HEAD")).stdout.trim();
        if (mode !== "rebuild") {
          await writeFile(path.join(source, "version.txt"), "v2");
          await git(source, "add", "version.txt");
          await git(source, "commit", "-m", "test: upgrade fixture");
        }
        const target = (await git(source, "rev-parse", "HEAD")).stdout.trim();
        await writeFile(
          path.join(root, "agenda-link.properties"),
          "web.port=18780",
        );
        await mkdir(path.join(root, "node_modules"));
        await writeFile(path.join(root, "node_modules/version"), "v1");
        await writeFile(path.join(dir, "active"), "yes");
        await writeFile(path.join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', {
          mode: 0o755,
        });
        await writeFile(
          path.join(bin, "systemctl"),
          '#!/bin/sh\necho "$*" >> "$UPGRADE_STATE/service-calls"\ncase "$1" in is-active) [ -f "$UPGRADE_STATE/active" ];; stop) rm -f "$UPGRADE_STATE/active";; start) touch "$UPGRADE_STATE/active";; esac\n',
          { mode: 0o755 },
        );
        await writeFile(
          path.join(bin, "npm"),
          '#!/bin/sh\nset -eu\nif [ "$UPGRADE_MODE" = prepare-failure ] && [ "$2" = check ]; then exit 1; fi\nmkdir -p node_modules apps/server/dist apps/web/dist\ncp version.txt node_modules/version\ncp version.txt apps/server/dist/main.js\ncp version.txt apps/web/dist/index.html\n',
          { mode: 0o755 },
        );
        await writeFile(
          path.join(bin, "curl"),
          '#!/bin/sh\n[ "$UPGRADE_MODE" != health-failure ]\n',
          { mode: 0o755 },
        );
        await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        });
        const run = () =>
          exec(
            "bash",
            [
              "-c",
              'umask 027; exec bash "$@"',
              "upgrade-test",
              path.join(root, "tools/upgrade.sh"),
              ...(mode === "rebuild" ? ["--rebuild"] : []),
            ],
            {
              cwd: root,
              env,
            },
          );
        if (["success", "rebuild"].includes(mode)) await run();
        else await assert.rejects(run);
        assert.equal(
          (await git(root, "rev-parse", "HEAD")).stdout.trim(),
          mode === "success" ? target : old,
        );
        assert.equal(
          await readFile(path.join(root, "node_modules/version"), "utf8"),
          mode === "success" ? "v2" : "v1",
        );
        assert.ok((await stat(path.join(dir, "active"))).isFile());
        if (mode !== "prepare-failure") {
          assert.equal(
            (await stat(path.join(root, "apps/web/dist"))).mode & 0o777,
            0o755,
          );
          assert.equal(
            (await stat(path.join(root, "apps/web/dist/index.html"))).mode &
              0o777,
            0o644,
          );
        }
        if (mode === "prepare-failure")
          await assert.rejects(() => readFile(path.join(dir, "service-calls")));
        if (mode === "rebuild")
          assert.match(
            await readFile(path.join(dir, "service-calls"), "utf8"),
            /stop[\s\S]*start/,
          );
        if (mode === "health-failure")
          assert.equal(
            await readFile(path.join(dir, "restored"), "utf8"),
            "yes",
          );
        await assert.rejects(() =>
          stat(path.join(root, ".runtime/upgrade.lock")),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
});

test("upgrade preflight explains absent Git setup without leaving a lock", async (t) => {
  for (const mode of ["no-commit", "no-remote", "no-upstream"])
    await t.test(mode, async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "agenda-link-upgrade-guard-"),
      );
      const git = (...args) => exec("git", args, { cwd: root });
      try {
        await mkdir(path.join(root, "tools"));
        await copyFile(
          new URL("../upgrade.sh", import.meta.url),
          path.join(root, "tools/upgrade.sh"),
        );
        await git("init", "-b", "main");
        await git("config", "user.name", "Upgrade Test");
        await git("config", "user.email", "test@example.invalid");
        if (mode !== "no-commit") {
          await git("add", ".");
          await git("commit", "-m", "test: initial fixture");
        }
        if (mode === "no-upstream") await git("remote", "add", "origin", root);
        await assert.rejects(
          () =>
            exec("bash", [path.join(root, "tools/upgrade.sh")], { cwd: root }),
          (error) => {
            assert.match(
              error.stderr,
              mode === "no-commit"
                ? /尚无提交/
                : mode === "no-remote"
                  ? /没有 Git remote/
                  : /没有 Git upstream/,
            );
            return true;
          },
        );
        await assert.rejects(() =>
          stat(path.join(root, ".runtime/upgrade.lock")),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
});
