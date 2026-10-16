import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * The only way sync touches the database (PLAN.md section 2, "What sync may write"). `fn` runs
 * in a transaction whose first statement is `SET LOCAL ROLE hb_sync`, so every statement in it
 * is checked against the grants in drizzle/0004_sync_role.sql and any write to a user table
 * fails with SQLSTATE 42501. `SET LOCAL` ends with the transaction, commit or rollback, so the
 * pooled connection goes back to the app role and never leaks the sync role.
 */
export type SyncTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const SYNC_ROLE = "hb_sync";

export function asSync<T>(db: Db, fn: (tx: SyncTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${SYNC_ROLE}`));
    return fn(tx);
  });
}
