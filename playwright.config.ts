import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E runs the built SPA and the real server on its own port and database, so it never
// touches the dev database or whatever already listens on 3000.
const PORT = Number(process.env.HB_E2E_PORT ?? 3100);
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL_E2E ?? "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay_e2e";

/** Every fixture source request, one `host/path` line each (HB_SOURCES_LOG). Tests clear and read it. */
export const E2E_SOURCES_LOG = join(tmpdir(), "hanapbuhay-e2e-sources.log");

/** Recorded GitHub repos the server reads (HB_GITHUB=fixture). Tests copy snapshots here. */
export const E2E_GITHUB_DIR = join(tmpdir(), "hanapbuhay-e2e-github");

/**
 * Recorded exchange-rate bodies the server reads (HB_FX=fixture). Empty, so every rate fetch fails
 * as if the sites were unreachable; only e2e/rates.spec.ts copies fixtures in. Emptied once, in the
 * main process: workers load this file too, and must not wipe it mid-run.
 */
export const E2E_FX_DIR = join(tmpdir(), "hanapbuhay-e2e-fx");
if (process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(E2E_FX_DIR, { recursive: true, force: true });
  mkdirSync(E2E_FX_DIR, { recursive: true });
}

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
      HB_SOURCES_LOG: E2E_SOURCES_LOG,
      HB_GITHUB: "fixture",
      HB_GITHUB_DIR: E2E_GITHUB_DIR,
      HB_FX: "fixture",
      HB_FX_DIR: E2E_FX_DIR,
      HB_DATA_DIR: join(tmpdir(), "hanapbuhay-e2e-data"),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
});
