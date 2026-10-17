import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createFakeAi, type FakeAi } from "@/server/adapters/ai/fake";
import { createPublicReader } from "@/server/adapters/github";
import { createHttpClient, type HttpClient } from "@/server/adapters/http";
import { createFileKeyStore, type KeyStore } from "@/server/adapters/key-store";
import { createChromiumPdf, type PdfRenderer } from "@/server/adapters/pdf";
import { createSourceAdapters } from "@/server/adapters/sources";
import { createDb, type Db } from "@/server/db/client";
import { migrateDb } from "@/server/db/migrate";
import type { Deps } from "@/server/services/context";
import { ensureUser } from "@/server/services/profile";
import { waitForTask } from "@/server/services/tasks";
import type { ProfileDto } from "@/shared/api";
import { resetTables } from "./reset";

// bunfig preload: migrate the test database once per `bun test` run.
const url = process.env.DATABASE_URL_TEST || "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay_test";
await migrateDb({ url });

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

/** Truncate every table except `users`, and reset the user row's profile fields. */
export async function resetDb(): Promise<void> {
  const { db, sql } = connections();
  await ensureUser(db);
  await resetTables(sql);
}

// One key directory per test run, removed at the end.
const keyDir = mkdtempSync(join(tmpdir(), "hb-test-keys-"));

/** A key store in a fresh directory under this run's temp dir, so tests never touch ./data or each other. */
export function testKeyStore(): KeyStore {
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
  over: Partial<Pick<Deps, "clock" | "pdf" | "keyStore" | "http" | "sources" | "aiSource" | "github">> = {},
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
    clock: over.clock ?? { now: () => new Date("2026-10-16T08:00:00Z") },
    fake,
  };
}

/** Wait for every split task a profile response shows as running (CV and add-ons). */
export async function waitForSplits(profile: ProfileDto): Promise<void> {
  const items = [profile.cv, ...profile.addons];
  for (const item of items) if (item?.splitTask?.status === "running") await waitForTask(item.splitTask.id);
}

/** Wait for every GitHub read a profile response shows as running. */
export async function waitForGithubReads(profile: ProfileDto): Promise<void> {
  for (const item of profile.addons) {
    const task = item.github?.readTask;
    if (task?.status === "running") await waitForTask(task.id);
  }
}

/** Raw SQL against the test database, for CHECK and row-level assertions. */
export function testSql(): postgres.Sql {
  return connections().sql;
}

afterAll(async () => {
  rmSync(keyDir, { recursive: true, force: true });
  if (!shared) return;
  await shared.pdf.close();
  await shared.sql.end({ timeout: 5 });
  await shared.closeDb();
});
