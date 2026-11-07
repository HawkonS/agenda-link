import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
test("repository audit excludes untracked runtime data but rejects forced tracking and leaked tokens without printing values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-audit-"));
  try {
    await mkdir(path.join(root, "tools"));
    const script = path.join(root, "tools/audit-repository.mjs");
    await copyFile(new URL("../audit-repository.mjs", import.meta.url), script);
    await exec("git", ["init", root]);
    await writeFile(path.join(root, ".gitignore"), ".env\n");
    const value = "fixture-value-" + Date.now();
    await writeFile(path.join(root, ".env"), "PASSWORD=" + value);
    const audit = () => exec(process.execPath, [script], { cwd: root });
    assert.equal(
      JSON.parse((await audit()).stdout.split("\n此检查")[0]).findings.length,
      0,
    );
    await exec("git", ["add", "-f", ".env"], { cwd: root });
    await assert.rejects(audit, (error) => {
      assert.match(error.stdout, /runtime data/);
      assert.ok(!error.stdout.includes(value));
      return true;
    });
    await exec("git", ["rm", "--cached", ".env"], { cwd: root });
    const token = "ghp_" + "a".repeat(36);
    await writeFile(path.join(root, "accidental.txt"), token);
    await assert.rejects(audit, (error) => {
      assert.match(error.stdout, /GitHub token/);
      assert.ok(!error.stdout.includes(token));
      return true;
    });
    await exec("git", ["add", "accidental.txt"], { cwd: root });
    await writeFile(path.join(root, "accidental.txt"), "sanitized working copy");
    await assert.rejects(audit, (error) => {
      assert.match(error.stdout, /GitHub token/);
      assert.match(error.stdout, /"source": "index"/);
      assert.ok(!error.stdout.includes(token));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
