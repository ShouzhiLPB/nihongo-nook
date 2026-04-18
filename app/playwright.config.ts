import { defineConfig, devices } from "@playwright/test";

/** 与本地 `next dev` 默认 3000 错开，避免 CI 或未复用进程时端口冲突 */
const E2E_PORT = Number(process.env.E2E_PORT || "3310");
const e2eOrigin = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: e2eOrigin,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- -p ${E2E_PORT}`,
    url: e2eOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
