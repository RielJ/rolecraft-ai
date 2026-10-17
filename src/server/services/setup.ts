import { and, count, eq, type SQL, sql } from "drizzle-orm";
import type { SetupDto, SetupStepId } from "@/shared/api";
import { SETUP_STEPS } from "@/shared/api";
import { facts, profileItems, sources, tasks, users } from "../db/schema";
import { loadAiConfig } from "./ai";
import type { Deps } from "./context";
import { ensureBuiltinSources } from "./sources";

/**
 * `GET /api/setup`: the first-run checklist (section 4). Every step is read from rows that exist
 * for other reasons (the key file, the CV item, facts, targeting, `sources.enabled`, refresh
 * tasks), so there is no checklist state to store or keep in sync.
 */
/** `count(*) FILTER (WHERE …)` as a number. */
const countWhere = (condition: SQL) => sql<number>`count(*) FILTER (WHERE ${condition})`.mapWith(Number);

export async function getSetup(deps: Deps): Promise<SetupDto> {
  // The built-ins are seeded at boot; seeding here too keeps a freshly truncated database honest.
  await ensureBuiltinSources(deps);
  const [aiConfig, [user], [cv], [factCounts], [enabled], [refreshes]] = await Promise.all([
    loadAiConfig(deps),
    deps.db
      .select({ targetTitles: users.targetTitles, roleFamilies: users.roleFamilies })
      .from(users)
      .where(eq(users.id, deps.userId)),
    deps.db
      .select({ id: profileItems.id })
      .from(profileItems)
      .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv"))),
    deps.db
      .select({
        confirmed: countWhere(sql`${facts.status} = 'confirmed'`),
        pending: countWhere(sql`${facts.status} = 'pending'`),
      })
      .from(facts)
      .where(eq(facts.userId, deps.userId)),
    deps.db
      .select({ n: count() })
      .from(sources)
      .where(and(eq(sources.userId, deps.userId), eq(sources.enabled, true))),
    deps.db
      .select({ any: count(), done: countWhere(sql`${tasks.status} = 'done'`) })
      .from(tasks)
      .where(and(eq(tasks.userId, deps.userId), eq(tasks.kind, "refresh"))),
  ]);
  if (!user) throw new Error("user row missing");

  const done: Record<SetupStepId, boolean> = {
    ai: aiConfig !== null,
    cv: cv !== undefined,
    // Confirmed facts are the only thing drafting and matching read; a pending queue is unfinished.
    facts: (factCounts?.confirmed ?? 0) > 0 && factCounts?.pending === 0,
    preferences: user.targetTitles.length > 0 && user.roleFamilies.length > 0,
    sources: (enabled?.n ?? 0) > 0,
    // Any finished refresh; a failed or interrupted first try leaves the step open.
    first_refresh: (refreshes?.done ?? 0) > 0,
  };
  const steps = SETUP_STEPS.map((id) => ({ id, done: done[id] }));
  return {
    steps,
    done: steps.every((s) => s.done),
    aiVia: deps.aiSource.kind,
    refreshStarted: (refreshes?.any ?? 0) > 0,
  };
}
