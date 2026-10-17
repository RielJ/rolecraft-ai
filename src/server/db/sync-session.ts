import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { MERGE_SYNC_LOCK } from "./locks";

/**
 * The only way sync touches the database (PLAN.md section 2, "What sync may write"). `fn` runs
 * in a transaction whose first statement is `SET LOCAL ROLE hb_sync`, so every statement in it
 * is checked against the grants in drizzle/0004_sync_role.sql and any write to a user table
 * fails with SQLSTATE 42501. `SET LOCAL` ends with the transaction, commit or rollback, so the
 * pooled connection goes back to the app role and never leaks the sync role.
 *
 * The second statement takes `MERGE_SYNC_LOCK` shared (see `locks.ts`), so a user merge never
 * runs in the middle of a sync transaction. hb_sync may call it through the PUBLIC EXECUTE
 * default on the advisory lock functions; no grant is added.
 */
export type SyncTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const SYNC_ROLE = "hb_sync";

export function asSync<T>(db: Db, fn: (tx: SyncTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${SYNC_ROLE}`));
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock_shared(${MERGE_SYNC_LOCK})`));
    return fn(tx);
  });
}
