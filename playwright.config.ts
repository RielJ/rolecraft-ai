import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E runs the built SPA and the real server on its own port and database, so it never
// touches the dev database or whatever already listens on 3000.
const PORT = Number(process.env.HB_E2E_PORT ?? 3100);
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL_E2E ?? "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay_e2e";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun src/server/main.ts",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: E2E_DATABASE_URL,
      HB_STATIC_DIR: "./dist",
      HB_AI: "fake",
      HB_SOURCES: "fixture",
      HB_DATA_DIR: join(tmpdir(), "hanapbuhay-e2e-data"),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
});
