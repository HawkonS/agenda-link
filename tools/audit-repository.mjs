// Read-only review of tracked files and unignored candidates; never print values.
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const git = (...args) =>
  execFileSync("git", ["-c", "safe.directory=" + root, "-C", root, ...args], {
    encoding: "utf8",
  });
const forbidden = (name) =>
  name
    .split("/")
    .some((p) =>
      /^(?:node_modules|dist|coverage|\.runtime|\.secrets|\.ssh|\.npmrc|\.netrc|\.pypirc|data|logs|backups|screenshots|playwright-report|test-results|uploads|recordings|\.env(?!\.example$)(?:\..*)?|(?:agenda-link|meet-link|wemeet-link)\.properties(?:\..*)?)$/.test(
        p,
      ),
    ) ||
  /\.(?:sqlite(?:3)?(?:-.*)?|db(?:-.*)?|log|pid|pem|key|p12|pfx|jks|keystore|crt|cer|p8|der|kdbx|bak|backup|tgz|zip|tar(?:\.gz)?)$/i.test(
    name,
  );
const signatures = [
  [
    "private key",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  [
    "cloud access key",
    /\b(?:AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,}|AKID[A-Za-z0-9]{28,})\b/,
  ],
  ["credential in URL", /https?:\/\/[^\s/@"'<>]+:[^\s/@"'<>]+@/],
  [
    "personal workspace path",
    /\/(?:Users|home)\/[A-Za-z0-9._-]+\/(?:Desktop|Documents|Project|projects)\//,
  ],
];
try {
  if (path.resolve(git("rev-parse", "--show-toplevel").trim()) !== root)
    throw new Error("请在本项目的 Git 工作目录中执行审查。");
  const files = [
    ...new Set(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const findings = [],
    approvedFixtures = [];
  function scan(name, bytes, source) {
    if (bytes.includes(0)) {
      findings.push({
        file: name,
        source,
        reason: "binary file requires manual review",
      });
      return;
    }
    bytes
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [reason, regex] of signatures)
          if (regex.test(line)) {
            if (
              reason === "credential in URL" &&
              [
                "apps/server/test/integration.test.ts",
                "apps/server/test/security.test.ts",
              ].includes(name) &&
              /^"https:\/\/user:(?:pass|secret)@(?:meeting|download)\.tencent\.com\/(?:video)?",$/.test(
                line.trim(),
              )
            ) {
              approvedFixtures.push({
                file: name,
                source,
                line: i + 1,
                reason: "synthetic URL-userinfo rejection fixture",
              });
            } else findings.push({ file: name, source, line: i + 1, reason });
          }
      });
  }
  const indexed = new Set(
    git("ls-files", "--cached", "-z").split("\0").filter(Boolean),
  );
  for (const name of files) {
    if (forbidden(name))
      findings.push({
        file: name,
        reason: "runtime data, credentials or build output",
      });
    let staged;
    if (indexed.has(name)) {
      const size = Number(git("cat-file", "-s", ":" + name).trim());
      if (size > 2 * 1024 * 1024)
        findings.push({
          file: name,
          source: "index",
          reason: "file over 2 MiB requires manual review",
        });
      else {
        staged = execFileSync(
          "git",
          [
            "-c",
            "safe.directory=" + root,
            "-C",
            root,
            "cat-file",
            "blob",
            ":" + name,
          ],
          { maxBuffer: 3 * 1024 * 1024 },
        );
        scan(name, staged, "index");
      }
    }
    const file = path.join(root, name);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      findings.push({
        file: name,
        reason: "non-regular file requires manual review",
      });
      continue;
    }
    if (stat.size > 2 * 1024 * 1024) {
      findings.push({
        file: name,
        source: "worktree",
        reason: "file over 2 MiB requires manual review",
      });
      continue;
    }
    const bytes = readFileSync(file);
    if (!staged?.equals(bytes)) scan(name, bytes, "worktree");
  }
  console.log(
    JSON.stringify(
      { candidateFiles: files.length, findings, approvedFixtures },
      null,
      2,
    ),
  );
  console.log(
    "此检查只读取当前候选文件，不修改索引、提交或远端；未知格式凭据和 Git 历史仍需人工复核。",
  );
  if (findings.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
