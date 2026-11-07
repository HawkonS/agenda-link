import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = process.cwd();
const workspace = await mkdtemp(path.join(os.tmpdir(), "agenda-link-e2e-"));
const apiPort = Number(process.env.E2E_API_PORT || 18510);
const webPort = Number(process.env.E2E_WEB_PORT || 15176);
const children = [];
let apiLog = "";

function start(args) {
  const child = spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, AGENDA_LINK_WORKSPACE: workspace },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    apiLog += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    apiLog += text;
    if (process.env.E2E_VERBOSE) process.stderr.write(text);
  });
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 ${url} 超时\n${apiLog}`);
}

try {
  await writeFile(
    path.join(workspace, "agenda-link.properties"),
    [
      `app.port=${apiPort}`,
      "app.bind-address=127.0.0.1",
      `web.port=${webPort}`,
      "web.bind-address=127.0.0.1",
      `app.base-url=http://127.0.0.1:${webPort}`,
      "app.timezone=Asia/Shanghai",
      "",
    ].join("\n"),
  );
  start(["apps/server/dist/main.js"]);
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
  const password = (
    await readFile(path.join(workspace, ".runtime", "initial-admin-password"), "utf8")
  ).trim();
  start(["tools/web-server.mjs"]);
  await waitFor(`http://127.0.0.1:${webPort}/`);

  const runner = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "e2e/playwright.config.ts",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        E2E_BASE_URL: `http://127.0.0.1:${webPort}`,
        E2E_USERNAME: "hawkon",
        E2E_PASSWORD: password,
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve) => runner.on("exit", resolve));
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(workspace, { recursive: true, force: true });
}
