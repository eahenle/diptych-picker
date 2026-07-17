import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      GENERATION_PROVIDER: "mock",
      GENERATE_INITIAL_CANDIDATES: "false",
      MOCK_GENERATION_DELAY_MS: "2000",
      CHALLENGER_INITIAL_TURNAROUND_MS: "2000",
      CHALLENGER_FALLBACK_MIN_MS: "1000",
      CHALLENGER_FALLBACK_MAX_MS: "1000",
      LOCAL_DATA_DIR: ".local-data/test",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
