import { afterAll } from "bun:test";
import postgres from "postgres";
import { createChromiumPdf, type PdfRenderer } from "@/server/adapters/pdf";
import { createDb, type Db } from "@/server/db/client";
import { migrateDb } from "@/server/db/migrate";
import type { Deps } from "@/server/services/context";
import { ensureUser } from "@/server/services/profile";
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

/** Deps against the test database, with a fixed clock unless one is given. */
export async function testDeps(over: Partial<Pick<Deps, "clock" | "pdf">> = {}): Promise<Deps> {
  const { db, pdf } = connections();
  return {
    db,
    userId: await ensureUser(db),
    pdf: over.pdf ?? pdf,
    clock: over.clock ?? { now: () => new Date("2026-10-16T08:00:00Z") },
  };
}

/** Raw SQL against the test database, for CHECK and row-level assertions. */
export function testSql(): postgres.Sql {
  return connections().sql;
}

afterAll(async () => {
  if (!shared) return;
  await shared.pdf.close();
  await shared.sql.end({ timeout: 5 });
  await shared.closeDb();
});
