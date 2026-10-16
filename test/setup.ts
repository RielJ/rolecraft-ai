import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createFakeAi, type FakeAi } from "@/server/adapters/ai/fake";
import { createFileKeyStore, type KeyStore } from "@/server/adapters/key-store";
import { createChromiumPdf, type PdfRenderer } from "@/server/adapters/pdf";
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
 * Deps against the test database, with a fixed clock unless one is given. The AI is a fresh
 * scriptable fake (both providers share it), returned as `fake` so a test can queue replies.
 */
export async function testDeps(
  over: Partial<Pick<Deps, "clock" | "pdf" | "keyStore">> = {},
): Promise<Deps & { fake: FakeAi }> {
  const { db, pdf } = connections();
  const fake = createFakeAi();
  return {
    db,
    userId: await ensureUser(db),
    pdf: over.pdf ?? pdf,
    ai: { anthropic: fake, openai: fake },
    keyStore: over.keyStore ?? testKeyStore(),
    clock: over.clock ?? { now: () => new Date("2026-10-16T08:00:00Z") },
    fake,
  };
}

/** Wait for every split task a profile response shows as running (CV and add-ons). */
export async function waitForSplits(profile: ProfileDto): Promise<void> {
  const items = [profile.cv, ...profile.addons];
  for (const item of items) if (item?.splitTask?.status === "running") await waitForTask(item.splitTask.id);
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
