import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { OpportunityId } from "@/shared/api";
import {
  type PreferenceDto,
  type PreferenceId,
  type PreferenceInput,
  type PreferenceList,
  type PreferenceScope,
  typedValueFits,
} from "@/shared/extension";
import { applicationPreferences, opportunities } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";

// Saved prefill answers (docs/EXTENSION.md): one global default and one
// per-job override per category. Written only on an explicit save from the panel. There is no
// salary category: PrefillCategory has none and a CHECK on the table mirrors it.

type PreferenceRow = typeof applicationPreferences.$inferSelect;

function scopeOf(opportunityId: OpportunityId | null): PreferenceScope {
  return opportunityId === null ? { kind: "global" } : { kind: "opportunity", opportunityId };
}

function toDto(row: PreferenceRow): PreferenceDto {
  return {
    id: row.id,
    category: row.category,
    typedValue: row.typedValue,
    displayText: row.displayText,
    scope: scopeOf(row.opportunityId),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every saved preference of this user, global ones first, then by category. */
export async function listPreferences(deps: Pick<Deps, "db" | "userId">): Promise<PreferenceList> {
  const rows = await deps.db
    .select()
    .from(applicationPreferences)
    .where(eq(applicationPreferences.userId, deps.userId))
    .orderBy(
      sql`${applicationPreferences.opportunityId} IS NOT NULL`,
      asc(applicationPreferences.category),
      asc(applicationPreferences.opportunityId),
    );
  return { preferences: rows.map(toDto) };
}

/** The preferences prefill reads for one opportunity: its overrides and the global defaults. */
export async function preferencesFor(
  deps: Pick<Deps, "db" | "userId">,
  { opportunityId }: { opportunityId: OpportunityId },
): Promise<{ job: PreferenceDto[]; global: PreferenceDto[] }> {
  const rows = await deps.db
    .select()
    .from(applicationPreferences)
    .where(
      and(
        eq(applicationPreferences.userId, deps.userId),
        or(isNull(applicationPreferences.opportunityId), eq(applicationPreferences.opportunityId, opportunityId)),
      ),
    );
  const dtos = rows.map(toDto);
  return {
    job: dtos.filter((p) => p.scope.kind === "opportunity"),
    global: dtos.filter((p) => p.scope.kind === "global"),
  };
}

async function assertOwnOpportunity(deps: Pick<Deps, "db" | "userId">, opportunityId: OpportunityId): Promise<void> {
  const [row] = await deps.db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  if (!row) throw notFound("That job");
}

/**
 * Save a preference: insert, or replace the one with the same category and scope. The partial
 * unique indexes (global: opportunity_id IS NULL; per job: IS NOT NULL) are the conflict targets.
 */
export async function savePreference(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  input: PreferenceInput,
): Promise<PreferenceDto> {
  // PreferenceInput refines this already; checked again so a non-HTTP caller cannot skip it.
  if (!typedValueFits(input)) {
    throw new AppError({ code: "invalid_input", message: "That value does not fit this question." });
  }
  const now = deps.clock.now();
  const values = {
    userId: deps.userId,
    category: input.category,
    typedValue: input.typedValue,
    displayText: input.displayText,
    updatedAt: now,
  };
  const set = { typedValue: input.typedValue, displayText: input.displayText, updatedAt: now };

  const { scope } = input;
  let row: PreferenceRow | undefined;
  switch (scope.kind) {
    case "global":
      [row] = await deps.db
        .insert(applicationPreferences)
        .values({ ...values, opportunityId: null })
        .onConflictDoUpdate({
          target: [applicationPreferences.userId, applicationPreferences.category],
          targetWhere: sql`opportunity_id IS NULL`,
          set,
        })
        .returning();
      break;
    case "opportunity":
      await assertOwnOpportunity(deps, scope.opportunityId);
      [row] = await deps.db
        .insert(applicationPreferences)
        .values({ ...values, opportunityId: scope.opportunityId })
        .onConflictDoUpdate({
          target: [
            applicationPreferences.userId,
            applicationPreferences.opportunityId,
            applicationPreferences.category,
          ],
          targetWhere: sql`opportunity_id IS NOT NULL`,
          set,
        })
        .returning();
      break;
    default: {
      const _exhaustive: never = scope;
      throw new Error(`unknown preference scope ${String(_exhaustive)}`);
    }
  }
  if (!row) throw new Error("preference upsert returned no row");
  return toDto(row);
}

/** Delete one saved preference and return what is left. */
export async function deletePreference(
  deps: Pick<Deps, "db" | "userId">,
  { id }: { id: PreferenceId },
): Promise<PreferenceList> {
  const deleted = await deps.db
    .delete(applicationPreferences)
    .where(and(eq(applicationPreferences.id, id), eq(applicationPreferences.userId, deps.userId)))
    .returning({ id: applicationPreferences.id });
  if (deleted.length === 0) throw notFound("That saved answer");
  return listPreferences(deps);
}
