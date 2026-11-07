import { expect, test } from "@playwright/test";

const password = process.env.E2E_PASSWORD;

test.skip(!password, "需要设置 E2E_PASSWORD（由 tools/e2e.mjs 注入）");

function localDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("登录、创建本地预约并在日程与审计里看到结果", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(process.env.E2E_USERNAME || "hawkon");
  await page.getByLabel("密码", { exact: true }).fill(password!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

  await page.goto("/meetings");
  await page.getByLabel("会议主题").fill("E2E 冒烟预约");
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  await page.getByLabel("开始时间", { exact: true }).fill(localDateTime(start));
  await page.getByLabel("结束时间", { exact: true }).fill(localDateTime(end));
  await page.getByRole("button", { name: "提交预约" }).click();
  await expect(page.getByText("E2E 冒烟预约").first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto("/calendar?tab=list");
  await expect(page.getByText("E2E 冒烟预约").first()).toBeVisible({
    timeout: 15_000,
  });

  await page.goto("/audit-logs?tab=audit");
  await expect(
    page.getByRole("tab", { name: "统计" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("登录").first()).toBeVisible();
});
