import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const hook = fileURLToPath(
  new URL("../../.githooks/commit-msg", import.meta.url),
);

async function accepts(message) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agenda-link-commit-"),
  );
  try {
    const file = path.join(directory, "COMMIT_EDITMSG");
    await writeFile(file, message);
    try {
      await exec("sh", [hook, file]);
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("commit hook accepts all shared types and preserves technical names", async () => {
  for (const type of [
    "feat",
    "fix",
    "refactor",
    "ui",
    "perf",
    "docs",
    "test",
    "build",
    "ci",
    "chore",
    "revert",
  ]) {
    const message = `${type}(repo): update GitHub settings\n`;
    assert.equal(await accepts(message), true, message);
  }
  assert.equal(await accepts("feat(api-v2)!: change the SDK response\n"), true);
  assert.equal(await accepts("docs(repo): document JAVA_HOME\n"), true);
});

test("commit hook accepts exactly 72 characters and rejects 73", async () => {
  const prefix = "docs(repo): add ";
  const title = prefix + "x".repeat(72 - prefix.length);
  assert.equal(await accepts(title + "\n"), true);
  assert.equal(await accepts(title + "x\n"), false);
});

test("commit hook rejects invalid types, missing scopes, and invalid scopes", async () => {
  for (const message of [
    "style(web): adjust layout",
    "unknown(repo): update settings",
    "docs: update the README",
    "docs(): update the README",
    "docs(Repo): update the README",
    "docs(repo/tools): update the README",
    "docs(repo_tools): update the README",
    "docs(repo.tools): update the README",
    "docs(2repo): update the README",
    "docs(repo):Update the README",
    "docs(repo): Update the README",
    "docs(repo): ",
    "",
  ]) {
    assert.equal(await accepts(message + "\n"), false, message);
  }
});

test("commit hook rejects bodies, footers, and trailers", async () => {
  for (const extra of [
    "Explain the change.",
    "BREAKING CHANGE: change the response format",
    "Closes: #123",
    "Signed-off-by: Contributor <contributor@example.invalid>",
    "Co-authored-by: Contributor <contributor@example.invalid>",
  ]) {
    assert.equal(
      await accepts(`docs(repo): update the README\n\n${extra}\n`),
      false,
      extra,
    );
  }
});

test("commit hook rejects non-English text, emoji, and invalid endings", async () => {
  for (const message of [
    "docs(repo): update 中文说明",
    "docs(repo): update the README 🚀",
    "docs(repo): update the README.",
    "docs(repo): update the README ",
    "docs(repo): update the README\t",
    "docs(repo): update\tthe README",
  ]) {
    assert.equal(await accepts(message + "\n"), false, message);
  }
});

test("commit hook tolerates blank lines and Git editor comments", async () => {
  assert.equal(
    await accepts("docs(repo): update the README\n\n# Git editor comment\n"),
    true,
  );
});
