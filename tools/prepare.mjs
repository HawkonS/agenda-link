import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
if (existsSync(path.join(root, ".git")))
  execFileSync("git", [
    "-c",
    "safe.directory=" + root,
    "-C",
    root,
    "config",
    "core.hooksPath",
    ".githooks",
  ]);
