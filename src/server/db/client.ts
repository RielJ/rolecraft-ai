import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** The app-role connection. Sync code never imports this (architecture test). */
export function createDb({ url, max = 10 }: { url: string; max?: number }): {
  db: Db;
  close: () => Promise<void>;
} {
  const client = postgres(url, { max, onnotice: () => {} });
  const db = drizzle({ client, schema, casing: "snake_case" });
  return { db, close: () => client.end({ timeout: 5 }) };
}
