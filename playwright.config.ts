import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240000,
  use: {
    baseURL: process.env.RR_BASE || "http://127.0.0.1:8811",
    headless: true,
    channel: process.env.RR_BROWSER_CHANNEL || "chrome",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  reporter: "list",
});
