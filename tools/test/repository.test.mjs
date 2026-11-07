import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
test("first Git adoption preserves deployment files and fails safely on mismatches", async (t) => {
  for (const mode of [
    "plain",
    "unborn",
    "modified",
    "extra",
    "sensitive",
    "staged",
    "locked",
    "missing-remote",
  ])
    await t.test(mode, async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "agenda-link-git-"));
      const source = path.join(temp, "source"),
        root = path.join(temp, "deployment");
      const git = (cwd, ...args) =>
        exec("git", ["-c", "safe.directory=" + cwd, ...args], { cwd });
      try {
        await mkdir(path.join(source, "tools"), { recursive: true });
        const remote =
          mode === "missing-remote" ? path.join(temp, "missing") : source;
        let helper = await readFile(
          new URL("../link-repository.mjs", import.meta.url),
          "utf8",
        );
        helper = helper.replaceAll(
          "https://github.com/HawkonS/agenda-link.git",
          remote,
        );
        await writeFile(path.join(source, "tools/link-repository.mjs"), helper);
        for (const name of ["run.sh", "stop.sh", "tools/manage_service.sh"])
          await writeFile(path.join(source, name), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          });
        await writeFile(
          path.join(source, "package.json"),
          '{"private":true}\n',
        );
        await writeFile(
          path.join(source, ".gitignore"),
          ".runtime/\ndata/\nlogs/\nagenda-link.properties\n.env\nnode_modules/\ndist/\n",
        );
        await writeFile(path.join(source, "README.md"), "deployment fixture\n");
        await git(source, "init", "-b", "main");
        await git(source, "config", "user.name", "Repository Fixture");
        await git(source, "config", "user.email", "fixture@example.invalid");
        if (mode === "sensitive") {
          await writeFile(
            path.join(source, "agenda-link.properties"),
            "fixture credential\n",
          );
          await git(source, "add", "-f", "agenda-link.properties");
        }
        await git(source, "add", ".");
        await git(source, "commit", "-m", "test: fixture");
        await cp(source, root, {
          recursive: true,
          filter: (p) =>
            p !== path.join(source, ".git") &&
            !p.startsWith(path.join(source, ".git") + path.sep),
        });
        await writeFile(
          path.join(root, "agenda-link.properties"),
          "do not change\n",
        );
        await mkdir(path.join(root, "data"));
        await writeFile(
          path.join(root, "data/agenda-link.sqlite"),
          "fixture data",
        );
        if (["unborn", "staged"].includes(mode)) {
          await git(root, "init", "-b", "main");
          if (mode === "staged") await git(root, "add", "README.md");
        }
        if (mode === "modified")
          await writeFile(path.join(root, "README.md"), "local change\n");
        if (mode === "extra")
          await writeFile(path.join(root, "unreviewed.txt"), "retain this");
        if (mode === "locked")
          await mkdir(path.join(root, ".runtime/upgrade.lock"), {
            recursive: true,
          });
        const run = () =>
          exec(
            process.execPath,
            [path.join(root, "tools/link-repository.mjs"), remote, "main"],
            { cwd: os.tmpdir() },
          );
        if (["plain", "unborn"].includes(mode)) {
          const output = await run();
          assert.match(output.stdout, /已关联/);
          assert.equal(
            (await git(root, "rev-parse", "HEAD")).stdout,
            (await git(source, "rev-parse", "HEAD")).stdout,
          );
          assert.equal((await git(root, "status", "--porcelain")).stdout, "");
          assert.equal(
            (
              await git(root, "rev-parse", "--abbrev-ref", "@{upstream}")
            ).stdout.trim(),
            "origin/main",
          );
          assert.match((await run()).stdout, /已关联/);
          assert.equal(
            (await git(root, "rev-list", "--count", "HEAD")).stdout.trim(),
            "1",
          );
        } else {
          await assert.rejects(run);
          await assert.rejects(() =>
            git(root, "rev-parse", "--verify", "HEAD"),
          );
          if (mode === "staged")
            assert.equal(
              (await git(root, "ls-files", "--cached")).stdout.trim(),
              "README.md",
            );
          if (mode === "modified")
            assert.equal(
              await readFile(path.join(root, "README.md"), "utf8"),
              "local change\n",
            );
        }
        assert.equal(
          await readFile(path.join(root, "agenda-link.properties"), "utf8"),
          "do not change\n",
        );
        assert.equal(
          await readFile(path.join(root, "data/agenda-link.sqlite"), "utf8"),
          "fixture data",
        );
        if (mode !== "locked")
          await assert.rejects(() =>
            stat(path.join(root, ".runtime/upgrade.lock")),
          );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    });
});
