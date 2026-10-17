import { sql } from "drizzle-orm";
import type { HealthDto } from "@/shared/api";
import type { Deps } from "./context";

/** How long the database gets to answer before health says it is unreachable. */
const DB_TIMEOUT_MS = 3000;

/** `GET /api/health`: up only when Postgres answers a trivial query in time. */
export async function checkHealth(deps: Pick<Deps, "db">): Promise<HealthDto> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DB_TIMEOUT_MS);
  });
  const query = deps.db.execute(sql`SELECT 1`).then(
    () => true,
    () => false,
  );
  try {
    const up = await Promise.race([query, timeout]);
    return up ? { ok: true, db: "ok" } : { ok: false, db: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
