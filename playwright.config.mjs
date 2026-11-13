import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "artifacts/browser",
  use: { baseURL: "http://127.0.0.1:8788", trace: "retain-on-failure" },
  webServer: {
    command: "node tests/browser-server.mjs",
    url: "http://127.0.0.1:8788/health",
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
