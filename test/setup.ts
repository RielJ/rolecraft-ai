import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createFakeAi, type FakeAi } from "@/server/adapters/ai/fake";
import { offlineFx } from "@/server/adapters/fx";
import { createPublicReader } from "@/server/adapters/github";
import { createGitlabReader } from "@/server/adapters/gitlab";
import { createHttpClient, type HttpClient } from "@/server/adapters/http";
import { createFileKeyStore, type KeyStore } from "@/server/adapters/key-store";
import { createFolderReader } from "@/server/adapters/local-projects";
import { createChromiumPdf, type PdfRenderer } from "@/server/adapters/pdf";
import { createSourceAdapters } from "@/server/adapters/sources";
import { createDb, type Db } from "@/server/db/client";
import { migrateDb } from "@/server/db/migrate";
import type { Deps } from "@/server/services/context";
import { ensureUser } from "@/server/services/profile";
import { waitForTask } from "@/server/services/tasks";
import type { ProfileDto } from "@/shared/api";
import { resetTables } from "./reset";

/**
 * The test database for this process. Under `bun test --parallel`, each worker gets its own
 * database (`hanapbuhay_test_w2` for worker 2), because every test file empties the tables it uses:
 * two files sharing one database would wipe each other's rows mid-test.
 */
function workerUrl(base: string, worker: string | undefined): string {
  if (worker === undefined || worker === "") return base;
  const parsed = new URL(base);
  parsed.pathname = `${parsed.pathname}_w${worker}`;
  return parsed.toString();
}

// bunfig preload: create and migrate this process's test database once per run.
const url = workerUrl(
  process.env.DATABASE_URL_TEST || "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay_test",
  process.env.BUN_TEST_WORKER_ID,
);
await migrateDb({ url });

/** The test database's URL, for a test that needs its own connection. */
export const testUrl = url;

let shared: { db: Db; closeDb: () => Promise<void>; sql: postgres.Sql; pdf: PdfRenderer } | null = null;

function connections() {
  if (!shared) {
    const { db, close } = createDb({ url, max: 4 });
    shared = {
      db,
      closeDb: close,
      sql: postgres(url, { max: 1, onnotice: () => {} }),
      pdf: createChromiumPdf({ executablePath: process.env.HB_CHROMIUM_PATH || undefined }),
    };
  }
  return shared;
}

/** Empty every table except `users`, restart their sequences, and reset the user row's profile fields. */
export async function resetDb(): Promise<void> {
  const { db, sql } = connections();
  await ensureUser(db);
  await resetTables(sql);
}

// One key directory per test file, made on first use and removed after the file.
let keyDir: string | null = null;

/** A key store in a fresh directory under this file's temp dir, so tests never touch ./data or each other. */
export function testKeyStore(): KeyStore {
  keyDir ??= mkdtempSync(join(tmpdir(), "hb-test-keys-"));
  return createFileKeyStore({ dir: mkdtempSync(join(keyDir, "store-")) });
}

/**
 * An HTTP client that never reaches the network: every request fails as a network error. Tests
 * that read pages pass their own fetch to `createHttpClient`.
 */
export function offlineHttp(): HttpClient {
  return createHttpClient({
    fetch: async () => {
      throw new TypeError("Network access is disabled in tests.");
    },
    sleep: async () => {},
  });
}

/**
 * Deps against the test database, with a fixed clock unless one is given. The AI is a fresh
 * scriptable fake (both providers share it), returned as `fake` so a test can queue replies.
 */
export async function testDeps(
  over: Partial<
    Pick<
      Deps,
      | "clock"
      | "pdf"
      | "keyStore"
      | "http"
      | "sources"
      | "aiSource"
      | "github"
      | "projects"
      | "folders"
      | "cloner"
      | "gitlab"
      | "fx"
    >
  > = {},
): Promise<Deps & { fake: FakeAi }> {
  const { db, pdf } = connections();
  const fake = createFakeAi();
  const http = over.http ?? offlineHttp();
  return {
    db,
    userId: await ensureUser(db),
    pdf: over.pdf ?? pdf,
    ai: { anthropic: fake, openai: fake },
    aiSource: over.aiSource ?? { kind: "key" },
    keyStore: over.keyStore ?? testKeyStore(),
    http,
    // Sources read through the same injected client, so a test's fake fetch serves both.
    sources: over.sources ?? createSourceAdapters(http),
    github: over.github ?? createPublicReader({ http, user: null }),
    projects: over.projects ?? null,
    folders: over.folders ?? createFolderReader({ readConfigEmail: false }),
    cloner: over.cloner ?? null,
    gitlab: over.gitlab ?? createGitlabReader({ http }),
    // Rate sources refuse every call unless a test passes its own (decision 67).
    fx: over.fx ?? offlineFx(),
    clock: over.clock ?? { now: () => new Date("2026-10-16T08:00:00Z") },
    fake,
  };
}

/** Wait for every split task a profile response shows as running (CV and add-ons). */
export async function waitForSplits(profile: ProfileDto): Promise<void> {
  const items = [profile.cv, ...profile.addons];
  for (const item of items) if (item?.splitTask?.status === "running") await waitForTask(item.splitTask.id);
}

/** Wait for every GitHub or folder read a profile response shows as running. */
export async function waitForGithubReads(profile: ProfileDto): Promise<void> {
  for (const item of profile.addons) {
    const task = item.github?.readTask ?? item.folder?.readTask;
    if (task?.status === "running") await waitForTask(task.id);
  }
}

/** Raw SQL against the test database, for CHECK and row-level assertions. */
export function testSql(): postgres.Sql {
  return connections().sql;
}

// A preload's afterAll runs after each file. Under `--parallel --no-isolate` the next file in the
// same worker shares this module, so everything closed here is reset to be made again on use.
afterAll(async () => {
  if (keyDir !== null) rmSync(keyDir, { recursive: true, force: true });
  keyDir = null;
  if (!shared) return;
  const closing = shared;
  shared = null;
  await closing.pdf.close();
  await closing.sql.end({ timeout: 5 });
  await closing.closeDb();
});
