import { and, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ExcludedItem,
  FILTERED_GROUP_LIMIT,
  type FilteredGroup,
  type FilteredList,
  type FilteredQuery,
  JobId,
  type OverrideInput,
  type OverrideResult,
  type RoleDropItem,
  SourceId,
} from "@/shared/api";
import { eligibilityOverrides, jobs } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";

/**
 * The Board's "Filtered out" section (decision 53). Two kinds of item: excluded jobs (open, not
 * saved or dismissed, not moved to Matches) and the role drops sync stores per source. Each kind
 * is one query that groups by reason with a window, so a group returns at most its newest 50 rows
 * however many thousands it holds. `jobs_excluded` and `role_drops_reason` cover the scans.
 */

type FilteredDeps = Pick<Deps, "db" | "userId">;

/**
 * The reason an excluded job shows under, read from the phrase its verdict was copied from. In
 * order; the first that fits wins. Postgres regex: `\m`/`\M` are word starts and ends, `~*` ignores
 * case, and the short codes (US, UK, EU) match in capitals only, as the eligibility rules do.
 */
const EXCLUDED_REASON = sql.raw(`CASE
  WHEN j.eligibility_phrase ~* '\\mphilippines\\M' THEN 'Philippines excluded'
  WHEN j.eligibility_phrase ~* 'security clearance' THEN 'Security clearance'
  WHEN j.eligibility_phrase ~ '\\m(US|USA)\\M|U\\.S\\.' OR j.eligibility_phrase ~* 'united states' THEN 'US only'
  WHEN j.eligibility_phrase ~ '\\mUK\\M' OR j.eligibility_phrase ~* 'united kingdom' THEN 'UK only'
  WHEN j.eligibility_phrase ~* '\\mcanada\\M' THEN 'Canada only'
  WHEN j.eligibility_phrase ~ '\\mEU\\M' OR j.eligibility_phrase ~* 'europe' THEN 'Europe only'
  WHEN j.eligibility_phrase ~* '\\mlatam\\M|latin america' THEN 'Latin America only'
  WHEN j.eligibility_phrase ~* '\\maustralia\\M' THEN 'Australia only'
  WHEN j.eligibility_phrase ~* '\\mgermany\\M' THEN 'Germany only'
  ELSE 'Other location limit'
END`);

/** `%q%` for ILIKE, with the wildcards in `q` matched literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const searchOn = (alias: "j" | "d", q: string): SQL =>
  q === ""
    ? sql``
    : sql`AND (${sql.raw(alias)}.title ILIKE ${likePattern(q)} ESCAPE '\\' OR ${sql.raw(alias)}.company ILIKE ${likePattern(q)} ESCAPE '\\')`;

// Raw `execute` skips Drizzle's column mapping, so timestamps can arrive as strings.
const Stamp = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());

const ExcludedRow = z.object({
  id: JobId,
  title: z.string(),
  company: z.string(),
  phrase: z.string().nullable(),
  seen_at: Stamp,
  reason: z.string(),
  count: z.number().int(),
});

const DropRow = z.object({
  source_id: SourceId,
  external_id: z.string(),
  title: z.string(),
  company: z.string(),
  url: z.string(),
  source: z.string(),
  seen_at: Stamp,
  reason: z.string(),
  count: z.number().int(),
});

const Count = z.array(z.object({ n: z.number().int() }));

/** The rows of the excluded pile: what Matches hides behind its Excluded toggle. */
const excludedWhere = (deps: FilteredDeps) => sql`
  j.user_id = ${deps.userId} AND j.eligibility = 'excluded' AND j.closed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM eligibility_overrides v WHERE v.job_id = j.id)`;

async function excludedGroups(deps: FilteredDeps, q: string): Promise<FilteredGroup[]> {
  const rows = await deps.db.execute(sql`
    WITH ranked AS (
      SELECT j.id, j.title, j.company, j.eligibility_phrase AS phrase, j.first_seen_at AS seen_at,
        ${EXCLUDED_REASON} AS reason
      FROM jobs j
      WHERE ${excludedWhere(deps)} ${searchOn("j", q)}
    ), numbered AS (
      SELECT ranked.*, row_number() OVER (PARTITION BY reason ORDER BY seen_at DESC, id) AS rn,
        count(*) OVER (PARTITION BY reason) AS n
      FROM ranked
    )
    SELECT id, title, company, phrase, seen_at, reason, n::int AS count FROM numbered
    WHERE rn <= ${FILTERED_GROUP_LIMIT}
    ORDER BY n DESC, reason, seen_at DESC, id`);
  const groups = new Map<string, Extract<FilteredGroup, { kind: "excluded" }>>();
  for (const row of z.array(ExcludedRow).parse([...rows])) {
    const group = groups.get(row.reason) ?? { kind: "excluded", reason: row.reason, count: row.count, items: [] };
    const item: ExcludedItem = {
      kind: "excluded",
      jobId: row.id,
      title: row.title,
      company: row.company,
      phrase: row.phrase,
      seenAt: row.seen_at,
    };
    group.items.push(item);
    groups.set(row.reason, group);
  }
  return [...groups.values()];
}

async function dropGroups(deps: FilteredDeps, q: string): Promise<FilteredGroup[]> {
  const rows = await deps.db.execute(sql`
    WITH numbered AS (
      SELECT d.source_id, d.external_id, d.title, d.company, d.url, s.label AS source, d.seen_at, d.reason,
        row_number() OVER (PARTITION BY d.reason ORDER BY d.seen_at DESC, d.source_id, d.external_id) AS rn,
        count(*) OVER (PARTITION BY d.reason) AS n
      FROM role_drops d JOIN sources s ON s.id = d.source_id
      WHERE d.user_id = ${deps.userId} ${searchOn("d", q)}
    )
    SELECT source_id, external_id, title, company, url, source, seen_at, reason, n::int AS count FROM numbered
    WHERE rn <= ${FILTERED_GROUP_LIMIT}
    ORDER BY n DESC, reason, seen_at DESC, source_id, external_id`);
  const groups = new Map<string, Extract<FilteredGroup, { kind: "role_drop" }>>();
  for (const row of z.array(DropRow).parse([...rows])) {
    const group = groups.get(row.reason) ?? { kind: "role_drop", reason: row.reason, count: row.count, items: [] };
    const item: RoleDropItem = {
      kind: "role_drop",
      sourceId: row.source_id,
      externalId: row.external_id,
      title: row.title,
      company: row.company,
      url: row.url,
      source: row.source,
      seenAt: row.seen_at,
    };
    group.items.push(item);
    groups.set(row.reason, group);
  }
  return [...groups.values()];
}

/** Every filtered-out item, whatever the search: two counts on indexed scans. */
async function totalCount(deps: FilteredDeps): Promise<number> {
  const [excluded, dropped] = await Promise.all([
    deps.db.execute(sql`SELECT count(*)::int AS n FROM jobs j WHERE ${excludedWhere(deps)}`),
    deps.db.execute(sql`SELECT count(*)::int AS n FROM role_drops d WHERE d.user_id = ${deps.userId}`),
  ]);
  return (Count.parse([...excluded])[0]?.n ?? 0) + (Count.parse([...dropped])[0]?.n ?? 0);
}

/** Excluded groups first, then role drops; largest first within each, newest 50 items per group. */
export async function listFiltered(deps: FilteredDeps, query: FilteredQuery = {}): Promise<FilteredList> {
  const q = query.q?.trim() ?? "";
  const [excluded, dropped] = await Promise.all([excludedGroups(deps, q), dropGroups(deps, q)]);
  const groups = [...excluded, ...dropped];
  const total = q === "" ? groups.reduce((sum, g) => sum + g.count, 0) : await totalCount(deps);
  return { total, groups };
}

/**
 * Show an excluded job in Matches from now on. The row lives in `eligibility_overrides`, which
 * the sync role cannot write, so no Refresh undoes it. Saying it twice is fine.
 */
export async function overrideEligibility(deps: FilteredDeps, { jobId }: OverrideInput): Promise<OverrideResult> {
  const [job] = await deps.db
    .select({ eligibility: jobs.eligibility })
    .from(jobs)
    .where(and(eq(jobs.userId, deps.userId), eq(jobs.id, jobId)));
  if (!job) throw notFound("That job");
  if (job.eligibility !== "excluded") {
    throw new AppError({
      code: "invalid_input",
      message: "Only an excluded job can be moved to Matches. This one already shows there.",
    });
  }
  await deps.db.insert(eligibilityOverrides).values({ jobId, userId: deps.userId }).onConflictDoNothing();
  return { jobId };
}
