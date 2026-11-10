import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3117);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  // Fail fast on hangs (matrix + Find/Radar). CI job also has timeout-minutes.
  globalTimeout: process.env.CI ? 20 * 60_000 : undefined,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL,
    actionTimeout: 12_000,
    navigationTimeout: 30_000,
    // Retain a trace when a hang/timeout fails so CI artifacts show the overlay.
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "off",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npx next dev -p ${PORT} -H 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      AUTODEV_API_KEY: "",
      SERV_API_KEY: "",
      STRIPE_SECRET_KEY: "",
    },
  },
});
