// Adopt an identical, previously unversioned deployment. Never check out files,
// create commits, push, or overwrite a configured repository.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  cpSync,
  chmodSync,
  chownSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [https, branch, ...flags] = process.argv.slice(2);
let stage,
  locked = false;
const lock = path.join(root, ".runtime/upgrade.lock");
function git(cwd, args, options = {}) {
  return execFileSync(
    "git",
    ["-c", "safe.directory=" + cwd, "-C", cwd, ...args],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 180000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      ...options,
    },
  );
}
function fail(message) {
  throw new Error(message);
}
function runtimePath(name) {
  return (
    name
      .split("/")
      .some((p) =>
        /^(?:\.git|\.runtime|node_modules|dist|data|logs|backups|\.secrets|\.ssh|\.npmrc|\.netrc|\.pypirc|screenshots|test-results|playwright-report|uploads|recordings|\.env(?!\.example$)(?:\..*)?|(?:agenda-link|meet-link|wemeet-link)\.properties(?:\..*)?)$/.test(
          p,
        ),
      ) ||
    /\.(?:sqlite(?:3)?(?:-.*)?|db(?:-.*)?|log|pid|pem|key|p12|pfx|jks|keystore|crt|cer|p8|der|kdbx|bak|backup|tgz|zip|tar(?:\.gz)?)$/i.test(
      name,
    )
  );
}
function entries(checkout, target) {
  return git(checkout, ["ls-tree", "-rz", "--full-tree", target])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t"),
        [mode, type, oid] = line.slice(0, tab).split(" ");
      const name = line.slice(tab + 1);
      if (
        type !== "blob" ||
        !["100644", "100755"].includes(mode) ||
        path.isAbsolute(name) ||
        name.split("/").includes("..") ||
        runtimePath(name)
      )
        fail("远端包含不允许接管的路径：" + JSON.stringify(name));
      return { mode, oid, name };
    });
}
function verify(checkout, target) {
  const tree = entries(checkout, target);
  for (const required of [
    ".gitignore",
    "package.json",
    "run.sh",
    "stop.sh",
    "tools/manage_service.sh",
  ])
    if (!tree.some((e) => e.name === required))
      fail("远端缺少项目文件：" + required);
  const problems = [];
  for (const { mode, oid, name } of tree) {
    const parts = name.split("/");
    if (
      parts.some((_, i) => {
        const p = path.join(root, ...parts.slice(0, i + 1));
        return !existsSync(p) || lstatSync(p).isSymbolicLink();
      })
    ) {
      problems.push(name);
      continue;
    }
    const p = path.join(root, name),
      stat = lstatSync(p);
    if (
      !stat.isFile() ||
      ((stat.mode & 0o111) !== 0) !== (mode === "100755") ||
      git(checkout, ["hash-object", "--stdin"], {
        input: readFileSync(p),
      }).trim() !== oid
    )
      problems.push(name);
  }
  const extra = git(root, [
    "--git-dir=" + path.join(checkout, ".git"),
    "--work-tree=" + root,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  problems.push(...extra);
  if (problems.length)
    fail(
      "源码与远端不一致，未修改文件或 Git 关联。请核对以下路径后重试：\n" +
        [...new Set(problems)].map((p) => "  " + JSON.stringify(p)).join("\n"),
    );
  // Verify that future git add cannot include generated runtime state.
  const sensitive = [
    "agenda-link.properties",
    ".runtime/pids",
    "data/agenda-link.sqlite",
    "logs/server.log",
    ".env",
    "node_modules/test",
    "apps/web/dist/index.html",
  ];
  const ignored = git(
    root,
    [
      "--git-dir=" + path.join(checkout, ".git"),
      "--work-tree=" + root,
      "check-ignore",
      "--no-index",
      "--stdin",
      "-z",
    ],
    { input: sensitive.join("\0") + "\0" },
  ).split("\0");
  if (sensitive.some((p) => !ignored.includes(p)))
    fail("远端忽略规则未覆盖运行数据，拒绝关联。");
}
try {
  if (
    https !== "https://github.com/HawkonS/agenda-link.git" ||
    branch !== "main" ||
    flags.length > 1 ||
    (flags.length && flags[0] !== "--ssh")
  )
    fail("用法: ./tools/manage_service.sh link-git [--ssh]");
  const remote =
    flags[0] === "--ssh" ? "git@github.com:HawkonS/agenda-link.git" : https;
  const metadata = path.join(root, ".git");
  if (existsSync(metadata)) {
    if (
      !lstatSync(metadata).isDirectory() ||
      lstatSync(metadata).isSymbolicLink()
    )
      fail("不支持接管 worktree 或符号链接形式的 .git。");
    let head;
    try {
      head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    } catch {}
    if (head) {
      if (
        git(root, ["remote", "get-url", "origin"]).trim() !== remote ||
        git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]).trim() !==
          "origin/main"
      )
        fail("已有 Git 历史或其他上游，拒绝重新关联。请通过 SSH 核对。");
      console.log("仓库已关联 origin/main，可执行 upgrade。");
      process.exit(0);
    }
    if (
      git(root, ["ls-files", "--cached"]).trim() ||
      git(root, ["for-each-ref"]).trim() ||
      git(root, ["remote"]).trim()
    )
      fail("当前 .git 已有暂存、引用或 remote，拒绝覆盖。请通过 SSH 核对。");
    const markers = readdirSync(metadata).filter((p) =>
      /(?:\.lock$|^(?:rebase-|MERGE_|CHERRY_PICK_|REVERT_))/.test(p),
    );
    if (markers.length) fail("当前 Git 操作未结束，拒绝接管。");
  }
  mkdirSync(path.join(root, ".runtime"), { recursive: true, mode: 0o700 });
  mkdirSync(lock, { mode: 0o700 });
  locked = true;
  stage = mkdtempSync(path.join(root, ".runtime/link-git-"));
  git(stage, ["init", "-b", branch]);
  git(stage, ["remote", "add", "origin", remote]);
  try {
    git(stage, ["fetch", "--no-tags", "origin", branch]);
  } catch {
    fail(
      "无法读取仓库 main。请确认已推送，并为执行账号配置 GitHub HTTPS 凭据或使用 link-git --ssh 配置只读部署密钥。未修改现有 .git。",
    );
  }
  const target = git(stage, ["rev-parse", "refs/remotes/origin/main"]).trim();
  git(stage, ["reset", "--mixed", target]);
  git(stage, ["branch", "--set-upstream-to=origin/main", branch]);
  git(stage, ["config", "core.hooksPath", ".githooks"]);
  verify(stage, target);
  const backup = path.join(
    root,
    ".runtime/repository-backups",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  if (existsSync(metadata))
    cpSync(metadata, path.join(backup, "previous.git"), { recursive: true });
  verify(stage, target);
  const owner = lstatSync(root);
  function protect(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isSymbolicLink()) fail("Git 元数据不能包含符号链接。");
      chmodSync(p, item.isDirectory() ? 0o700 : 0o600);
      if (process.getuid?.() === 0) chownSync(p, owner.uid, owner.gid);
      if (item.isDirectory()) protect(p);
    }
    if (process.getuid?.() === 0) chownSync(dir, owner.uid, owner.gid);
    chmodSync(dir, 0o700);
  }
  protect(path.join(stage, ".git"));
  const old = path.join(backup, "original.git");
  if (existsSync(metadata)) renameSync(metadata, old);
  try {
    renameSync(path.join(stage, ".git"), metadata);
  } catch (error) {
    if (existsSync(old)) renameSync(old, metadata);
    throw error;
  }
  console.log(
    "已关联 " +
      remote +
      " → origin/main（" +
      target +
      "）。源码、配置、数据库及运行进程未改动。",
  );
  console.log("原 Git 元数据备份：" + backup);
  console.log(
    "首次部署执行 sudo ./tools/manage_service.sh upgrade --rebuild；后续执行 upgrade。",
  );
} catch (error) {
  console.error(
    error.code === "EEXIST" ? "已有升级或 Git 关联任务。" : error.message,
  );
  process.exitCode = 1;
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true });
  if (locked) rmSync(lock, { recursive: true, force: true });
}
