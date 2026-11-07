import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { TLSSocket } from "node:tls";

const DEFAULT_API_PORT = 18480;
const DEFAULT_WEB_PORT = 15173;

function readConfiguredPort(key: string, fallback: number): number {
  const propertiesPath = process.env.AGENDA_LINK_WORKSPACE
    ? path.join(process.env.AGENDA_LINK_WORKSPACE, "agenda-link.properties")
    : new URL("../../agenda-link.properties", import.meta.url);
  if (!existsSync(propertiesPath)) return fallback;

  const line = readFileSync(propertiesPath, "utf8")
    .split(/\r?\n/)
    .find((candidate) =>
      new RegExp(`^\\s*${key.replace(".", "\\.")}\\s*=`).test(candidate),
    );
  const value = line?.split("=").slice(1).join("=").trim();
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

const apiPort = readConfiguredPort("app.port", DEFAULT_API_PORT);
const webPort = readConfiguredPort("web.port", DEFAULT_WEB_PORT);
const apiProxy = `http://127.0.0.1:${apiPort}`;

function createApiProxy(): ProxyOptions {
  return {
    target: apiProxy,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        proxyRequest.setHeader("x-forwarded-host", request.headers.host || "");
        proxyRequest.setHeader(
          "x-forwarded-proto",
          (request.socket as TLSSocket).encrypted ? "https" : "http",
        );
      });
    },
  };
}

function readBuildNumber(): string {
  const configured = process.env.AGENDA_LINK_BUILD_NUMBER?.trim();
  if (configured) return configured;

  const ciRevision = process.env.GITHUB_SHA?.trim();
  if (ciRevision) return ciRevision.slice(0, 7);

  try {
    return (
      execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "local"
    );
  } catch {
    try {
      const packageJson = JSON.parse(
        readFileSync(
          path.resolve(import.meta.dirname, "../../package.json"),
          "utf8",
        ),
      );
      return `v${packageJson.version || "0.1.0"}`;
    } catch {
      return "local";
    }
  }
}

function readBuildTime(): string {
  const configured = process.env.AGENDA_LINK_BUILD_TIME?.trim();
  if (configured) return configured;

  const sourceDateEpochText = process.env.SOURCE_DATE_EPOCH?.trim();
  const sourceDateEpoch = Number(sourceDateEpochText);
  if (
    sourceDateEpochText &&
    Number.isFinite(sourceDateEpoch) &&
    sourceDateEpoch >= 0
  ) {
    return new Date(sourceDateEpoch * 1000).toISOString();
  }

  return new Date().toISOString();
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_BUILD_NUMBER": JSON.stringify(readBuildNumber()),
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(readBuildTime()),
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    host: "0.0.0.0",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": createApiProxy(),
    },
  },
  preview: {
    host: "0.0.0.0",
    port: webPort,
    proxy: {
      "/api": createApiProxy(),
    },
  },
  build: {
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("/axios/")) return "http";
          if (/react-day-picker|date-fns|@date-fns/.test(id))
            return "calendar-ui";
          if (/react-hook-form|@hookform|\/zod\//.test(id)) return "forms";
          if (/@radix-ui|react-remove-scroll|use-sidecar|aria-hidden/.test(id))
            return "ui-primitives";
          return "vendor";
        },
      },
    },
  },
});
