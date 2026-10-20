import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E runs the built SPA against real servers, one per worker, each on its own port, database and
// temp dirs, so workers never share rows and never touch the dev database or whatever listens on
// 3000. Specs reset their tables, so two workers on one database would wipe each other mid-test.
//
// This file is loaded by the main process (which starts the servers below) and again by every
// worker. A worker's exports point at its own server: Playwright gives each worker a slot,
// TEST_PARALLEL_INDEX (0 to WORKERS - 1), which a replacement worker after a failure reuses.
const WORKERS = Number(process.env.HB_E2E_WORKERS ?? 4);
const BASE_PORT = Number(process.env.HB_E2E_PORT ?? 3100);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL_E2E ?? "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay_e2e";

/** The resources of worker slot `slot`: its server's port, database, and fixture dirs. */
function slotOf(slot: number) {
  const db = new URL(BASE_DATABASE_URL);
  db.pathname = `${db.pathname}_w${slot}`;
  const dir = join(tmpdir(), `hanapbuhay-e2e-w${slot}`);
  return {
    port: BASE_PORT + slot,
    databaseUrl: db.toString(),
    sourcesLog: join(dir, "sources.log"),
    githubDir: join(dir, "github"),
    projectsDir: join(dir, "projects"),
    fxDir: join(dir, "fx"),
    dataDir: join(dir, "data"),
  };
}

const own = slotOf(Number(process.env.TEST_PARALLEL_INDEX ?? 0));

/** This worker's database. */
export const E2E_DATABASE_URL = own.databaseUrl;

/** Every fixture source request, one `host/path` line each (HB_SOURCES_LOG). Tests clear and read it. */
export const E2E_SOURCES_LOG = own.sourcesLog;

/** Recorded GitHub repos the server reads (HB_GITHUB=fixture). Tests copy snapshots here. */
export const E2E_GITHUB_DIR = own.githubDir;

/** The local projects folder the server scans (HB_PROJECTS_DIR). Tests make git repos here. */
export const E2E_PROJECTS_DIR = own.projectsDir;

/** The commit email the e2e server counts as the user's (HB_GIT_EMAILS). */
export const E2E_GIT_EMAIL = "juan@example.ph";

/**
 * Recorded exchange-rate bodies the server reads (HB_FX=fixture). Empty, so every rate fetch fails
 * as if the sites were unreachable; only e2e/rates.spec.ts copies fixtures in. Emptied once, in the
 * main process: workers load this file too, and must not wipe it mid-run.
 */
export const E2E_FX_DIR = own.fxDir;

const slots = Array.from({ length: WORKERS }, (_, slot) => slotOf(slot));
if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const slot of slots) {
    rmSync(slot.fxDir, { recursive: true, force: true });
    mkdirSync(slot.fxDir, { recursive: true });
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: WORKERS,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${own.port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: slots.map((slot) => ({
    command: "bun src/server/main.ts",
    url: `http://localhost:${slot.port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(slot.port),
      DATABASE_URL: slot.databaseUrl,
      HB_STATIC_DIR: "./dist",
      HB_AI: "fake",
      HB_SOURCES: "fixture",
      HB_SOURCES_LOG: slot.sourcesLog,
      HB_GITHUB: "fixture",
      HB_GITHUB_DIR: slot.githubDir,
      HB_PROJECTS_DIR: slot.projectsDir,
      HB_GIT_EMAILS: E2E_GIT_EMAIL,
      HB_FX: "fixture",
      HB_FX_DIR: slot.fxDir,
      HB_DATA_DIR: slot.dataDir,
    },
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  })),
});
