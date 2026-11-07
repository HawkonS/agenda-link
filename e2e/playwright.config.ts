import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:15176",
    // 默认用本机 Chrome，避免下载浏览器；CI 可设 E2E_BROWSER_CHANNEL=none 并用 playwright install chromium。
    channel:
      process.env.E2E_BROWSER_CHANNEL === "none"
        ? undefined
        : process.env.E2E_BROWSER_CHANNEL || "chrome",
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
});
