import { test, expect } from "@playwright/test";

test("首页壳加载", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("日语学习").first()).toBeVisible({ timeout: 120_000 });
});

test("/qa 自检页", async ({ page }) => {
  await page.goto("/qa");
  await expect(page.getByRole("heading", { name: "自检测试页面" })).toBeVisible({ timeout: 120_000 });
});

test("/qa 含云端与弱网清单（§17.6 轮次 4）", async ({ page }) => {
  await page.goto("/qa");
  await expect(page.getByRole("heading", { name: "二、云端与弱网" })).toBeVisible({ timeout: 120_000 });
});

test("/qa 含 i2-6 主流宽度矩阵与换机清单", async ({ page }) => {
  await page.goto("/qa");
  await expect(page.getByRole("heading", { name: "一附、换设备前快验" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "一附二、主流手机逻辑宽度矩阵（手勾）" })).toBeVisible();
});
