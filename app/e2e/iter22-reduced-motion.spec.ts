import { test, expect } from "@playwright/test";

test.use({ reducedMotion: "reduce" });

test.describe("Iteration 22 · 减少动态效果", () => {
  test("主导航与统计 / 练习页可访问", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav).toBeVisible({ timeout: 120_000 });
    await nav.getByRole("button", { name: "统计" }).click();
    await expect(page.getByRole("heading", { name: "统计" })).toBeVisible({ timeout: 60_000 });
    await nav.getByRole("button", { name: "练习" }).click();
    await expect(page.getByRole("heading", { name: "练习" })).toBeVisible();
  });
});
