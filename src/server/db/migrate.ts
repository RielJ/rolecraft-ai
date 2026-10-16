import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS = new URL("../../../drizzle", import.meta.url).pathname;
const DEFAULT_URL = "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay";

function parseDbUrl(url: string): URL {
  const parsed = URL.parse(url);
  if (parsed === null) throw new Error("DATABASE_URL is not a valid URL.");
  return parsed;
}

export function databaseName(url: string): string {
  return decodeURIComponent(parseDbUrl(url).pathname.slice(1));
}

/** Create the database named in `url` if it does not exist (Compose only creates the main one). */
export async function ensureDatabase({ url }: { url: string }): Promise<void> {
  const name = databaseName(url);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsupported database name: ${name}`);
  const admin = parseDbUrl(url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function migrateDb({ url }: { url: string }): Promise<void> {
  await ensureDatabase({ url });
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  await migrateDb({ url });
  console.info(`Migrated ${databaseName(url)}`);
}
