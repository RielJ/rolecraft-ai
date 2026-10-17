import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { type Derived, derive } from "@/domain/posting";
import { matchesKeywords, roleFit } from "@/domain/roles";
import { type FetchOutcome, type PlannedPosting, planSourceRun, type SourcePlan } from "@/domain/sync-plan";
import type { JobId, RefreshResult, RefreshSourceResult } from "@/shared/api";
import { BUILTIN_SOURCE_KINDS, type SourceStatus } from "@/shared/enums";
import { type Posting, SourceError } from "../adapters/sources";
import { jobListings, jobs, opportunities, sources, users } from "../db/schema";
import { asSync, type SyncTx } from "../db/sync-session";
import type { Deps } from "./context";
import type { TaskContext } from "./tasks";

/**
 * The refresh pipeline (PLAN.md section 3.1). Every statement runs as `hb_sync` through
 * `asSync`, which may write only jobs, listings and the `last_*` columns of sources (section 2).
 * This module may not import the app-role client (architecture test); task progress goes
 * through `ctx.step`, which the task module owns. Fetching happens outside any transaction, and
 * each source is applied in its own, so an interrupted refresh leaves every source either fully
 * applied or untouched.
 */

type SyncDeps = Pick<Deps, "db" | "userId" | "sources" | "clock">;
type SourceRow = typeof sources.$inferSelect;
type Targeting = {
  targetTitles: readonly string[];
  roleFamilies: (typeof users.$inferSelect)["roleFamilies"];
  excludeTitleWords: readonly string[];
};

/** Closed jobs nobody touched are deleted this long after closing (decision 15). */
export const PRUNE_DAYS = 60;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const isBuiltin = (kind: SourceRow["kind"]) => BUILTIN_SOURCE_KINDS.some((k) => k === kind);

export async function runRefresh(deps: SyncDeps, ctx: Pick<TaskContext, "step">): Promise<RefreshResult> {
  const { enabled, targeting } = await asSync(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.userId, deps.userId), eq(sources.enabled, true)))
      .orderBy(sources.createdAt, sources.id);
    const [user] = await tx
      .select({
        targetTitles: users.targetTitles,
        roleFamilies: users.roleFamilies,
        excludeTitleWords: users.excludeTitleWords,
      })
      .from(users)
      .where(eq(users.id, deps.userId));
    if (!user) throw new Error("The user row is missing.");
    return { enabled: rows, targeting: user };
  });

  const results: RefreshSourceResult[] = [];
  for (const [index, source] of enabled.entries()) {
    await ctx.step(`${source.label} ${index + 1} of ${enabled.length}`);
    results.push(await refreshSource({ deps, source, targeting }));
  }

  await ctx.step("Removing old closed jobs");
  const pruned = await prune(deps);
  return { sources: results, pruned, aiPass: { kind: "not_run" } };
}

// ---------- one source ----------

type Normalized = { posting: Posting; derived: Derived };

async function refreshSource({
  deps,
  source,
  targeting,
}: {
  deps: SyncDeps;
  source: SourceRow;
  targeting: Targeting;
}): Promise<RefreshSourceResult> {
  const base = { sourceId: source.id, label: source.label };
  const adapter = deps.sources[source.kind];
  const now = deps.clock.now();

  if (
    adapter &&
    source.lastRunAt &&
    now.getTime() - source.lastRunAt.getTime() < adapter.minIntervalMinutes * MINUTE_MS
  ) {
    // Too soon after the last run. A skipped source closes nothing and keeps its last run time.
    await asSync(deps.db, (tx) =>
      tx.update(sources).set({ lastStatus: "skipped", lastError: null }).where(eq(sources.id, source.id)),
    );
    return { ...base, ...EMPTY_COUNTS, status: "skipped", error: null };
  }

  // What this source already lists, so an adapter with a detail budget spends it on new postings.
  const known = adapter
    ? new Set(
        (
          await asSync(deps.db, (tx) =>
            tx
              .select({ externalId: jobListings.externalId })
              .from(jobListings)
              .where(eq(jobListings.sourceId, source.id)),
          )
        ).map((l) => l.externalId),
      )
    : new Set<string>();
  const fetched: FetchOutcome & { normalized?: Map<string, Normalized> } = adapter
    ? await fetchAndFilter({ adapter, source, targeting, known })
    : { kind: "failed", error: `${source.label} has no reader yet.` };

  return asSync(deps.db, async (tx) => {
    const existing = await tx
      .select({
        externalId: jobListings.externalId,
        jobId: jobListings.jobId,
        isPrimary: jobListings.isPrimary,
        jobContentHash: jobs.contentHash,
        jobExpiresAt: jobs.expiresAt,
        lastSeenAt: jobListings.lastSeenAt,
        missingSince: jobListings.missingSince,
      })
      .from(jobListings)
      .innerJoin(jobs, eq(jobs.id, jobListings.jobId))
      .where(eq(jobListings.sourceId, source.id));
    const postings = fetched.kind === "fetched" ? fetched.postings : [];
    const titleKeys = [...new Set(postings.map((p) => p.titleKey))];
    const candidates =
      titleKeys.length === 0
        ? []
        : (
            await tx
              .select({
                id: jobs.id,
                titleKey: jobs.titleKey,
                companyKey: jobs.companyKey,
                applyUrlKey: jobs.applyUrlKey,
                descriptionKey: jobs.descriptionKey,
                postedAt: jobs.postedAt,
                firstSeenAt: jobs.firstSeenAt,
              })
              .from(jobs)
              .where(and(eq(jobs.userId, deps.userId), inArray(jobs.titleKey, titleKeys)))
          ).map(({ postedAt, firstSeenAt, ...c }) => ({ ...c, seenAt: postedAt ?? firstSeenAt }));

    const plan = planSourceRun({
      source: { lastOkCount: source.lastOkCount },
      fetched,
      existing,
      candidates,
      now,
    });
    return applyPlan({ tx, deps, source, plan, normalized: fetched.normalized ?? new Map(), now, base });
  });
}

const EMPTY_COUNTS = { fetched: 0, dropped: 0, added: 0, updated: 0, closed: 0, reopened: 0 };

/** Fetch, then the keyword filter (built-ins only) and the role filter, then normalize. */
async function fetchAndFilter({
  adapter,
  source,
  targeting,
  known,
}: {
  adapter: NonNullable<SyncDeps["sources"][SourceRow["kind"]]>;
  source: SourceRow;
  targeting: Targeting;
  known: ReadonlySet<string>;
}): Promise<FetchOutcome & { normalized?: Map<string, Normalized> }> {
  const keywords = source.keywords ?? targeting.targetTitles;
  let result: Awaited<ReturnType<typeof adapter.fetch>>;
  try {
    result = await adapter.fetch({ board: source.board, keywords, known });
  } catch (error) {
    const sourceError =
      error instanceof SourceError ? error : new SourceError({ kind: "failed", message: `${adapter.name} failed.` });
    if (!(error instanceof SourceError)) {
      console.error(
        JSON.stringify({ level: "error", msg: "source fetch threw", source: source.id, error: String(error) }),
      );
    }
    return { kind: sourceError.kind === "rate_limited" ? "rate_limited" : "failed", error: sourceError.message };
  }

  const fetchedIds = result.postings.map((p) => p.externalId);
  const normalized = new Map<string, Normalized>();
  let dropped = 0;
  for (const posting of result.postings) {
    if (isBuiltin(source.kind) && !matchesKeywords({ title: posting.title, tags: posting.tags, keywords })) continue;
    const fit = roleFit({
      title: posting.title,
      tags: posting.tags,
      description: posting.description,
      families: targeting.roleFamilies,
      excludeWords: targeting.excludeTitleWords,
    });
    if (fit.fit === "drop") {
      dropped++;
      continue;
    }
    if (normalized.has(posting.externalId)) continue;
    normalized.set(posting.externalId, { posting, derived: derive(posting) });
  }
  const postings: PlannedPosting[] = [...normalized.values()].map(({ posting, derived }) => ({
    externalId: posting.externalId,
    titleKey: derived.titleKey,
    companyKey: derived.companyKey,
    applyUrlKey: derived.applyUrlKey,
    descriptionKey: derived.descriptionKey,
    contentHash: derived.contentHash,
    postedAt: derived.postedAt,
  }));
  return {
    kind: "fetched",
    complete: result.complete,
    fetchedIds,
    unread: result.unread,
    dropped,
    postings,
    normalized,
  };
}

// ---------- apply ----------

// Raw `execute` skips Drizzle's column mapping, so timestamps arrive as strings; only null-ness matters here.
const Stamp = z.union([z.date(), z.string()]).nullable();
const ClosedChange = z.object({ was: Stamp, now: Stamp });

async function applyPlan({
  tx,
  deps,
  source,
  plan,
  normalized,
  now,
  base,
}: {
  tx: SyncTx;
  deps: SyncDeps;
  source: SourceRow;
  plan: SourcePlan;
  normalized: Map<string, Normalized>;
  now: Date;
  base: Pick<RefreshSourceResult, "sourceId" | "label">;
}): Promise<RefreshSourceResult> {
  switch (plan.kind) {
    case "failed":
    case "rate_limited": {
      // A thrown fetch writes only the status. Nothing closes.
      await setStatus(tx, source.id, { lastRunAt: now, lastStatus: plan.kind, lastError: plan.error });
      return { ...base, ...EMPTY_COUNTS, status: plan.kind, error: plan.error };
    }
    case "suspicious_empty": {
      const error = `${source.label} returned no postings after returning ${source.lastOkCount ?? 0} last time. Nothing was closed; if the board really is empty, this clears once it lists a job again.`;
      await setStatus(tx, source.id, { lastRunAt: now, lastStatus: "suspicious_empty", lastError: error });
      return { ...base, ...EMPTY_COUNTS, status: "suspicious_empty", error };
    }
    case "ok":
      break;
    default: {
      const never: never = plan;
      throw new Error(`unknown plan ${JSON.stringify(never)}`);
    }
  }

  const insertedJobs = new Map<string, JobId>();
  const seen: string[] = [];
  let added = 0;
  let updated = 0;

  const posting = (externalId: string): Normalized => {
    const item = normalized.get(externalId);
    if (!item) throw new Error(`no posting for ${externalId}`);
    return item;
  };

  for (const upsert of plan.upserts) {
    switch (upsert.kind) {
      case "seen": {
        seen.push(upsert.externalId);
        // An unread listing (detail budget) is seen with no posting, and never rewrites.
        if (upsert.rewrite) {
          const item = posting(upsert.externalId);
          // The board changed the posting: refresh its content, derived columns and rule eligibility.
          await tx
            .update(jobs)
            .set({ ...item.derived, updatedAt: now })
            .where(eq(jobs.id, upsert.jobId));
          updated++;
        }
        break;
      }
      case "insert": {
        const item = posting(upsert.externalId);
        const [job] = await tx
          .insert(jobs)
          .values({ userId: deps.userId, origin: "source", ...item.derived, firstSeenAt: now, updatedAt: now })
          .returning({ id: jobs.id });
        if (!job) throw new Error("insert returned no row");
        insertedJobs.set(upsert.externalId, job.id);
        await insertListing(tx, { source, item, jobId: job.id, isPrimary: true, now, userId: deps.userId });
        added++;
        break;
      }
      case "attach": {
        const jobId = upsert.to.kind === "job" ? upsert.to.jobId : insertedJobs.get(upsert.to.externalId);
        if (!jobId) throw new Error(`no job for ${upsert.externalId}`);
        // Only a listing: the job's text and its opportunity stay as they are.
        const item = posting(upsert.externalId);
        await insertListing(tx, { source, item, jobId, isPrimary: false, now, userId: deps.userId });
        break;
      }
      default: {
        const never: never = upsert;
        throw new Error(`unknown upsert ${JSON.stringify(never)}`);
      }
    }
  }

  if (seen.length > 0) {
    await tx
      .update(jobListings)
      .set({ lastSeenAt: now, missingSince: null })
      .where(and(eq(jobListings.sourceId, source.id), inArray(jobListings.externalId, seen)));
  }
  if (plan.missing.length > 0) {
    await tx
      .update(jobListings)
      .set({ missingSince: now })
      .where(and(eq(jobListings.sourceId, source.id), inArray(jobListings.externalId, plan.missing)));
  }

  const { closed, reopened } = await recomputeClosed(tx, source.id);
  await setStatus(tx, source.id, {
    lastRunAt: now,
    lastOkAt: now,
    lastStatus: "ok",
    lastCount: plan.count,
    lastOkCount: plan.rawCount,
    lastDropped: plan.dropped,
    lastError: null,
  });
  return {
    ...base,
    status: "ok",
    fetched: plan.rawCount,
    dropped: plan.dropped,
    added,
    updated,
    closed,
    reopened,
    error: null,
  };
}

async function insertListing(
  tx: SyncTx,
  {
    source,
    item,
    jobId,
    isPrimary,
    now,
    userId,
  }: { source: SourceRow; item: Normalized; jobId: JobId; isPrimary: boolean; now: Date; userId: Deps["userId"] },
): Promise<void> {
  await tx.insert(jobListings).values({
    sourceId: source.id,
    externalId: item.posting.externalId,
    userId,
    jobId,
    listingUrl: item.posting.listingUrl,
    isPrimary,
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

/**
 * A job is closed when every one of its listings is missing, at the latest `missing_since`;
 * otherwise it is open. Recomputed for every job this source lists. PG18's `RETURNING old/new`
 * tells closed from reopened without a second query.
 */
async function recomputeClosed(tx: SyncTx, sourceId: SourceRow["id"]): Promise<{ closed: number; reopened: number }> {
  const rows = await tx.execute(sql`
    UPDATE jobs j SET closed_at = s.closed
    FROM (
      SELECT l.job_id,
        CASE WHEN bool_and(l.missing_since IS NOT NULL) THEN max(l.missing_since) END AS closed
      FROM job_listings l
      WHERE l.job_id IN (SELECT job_id FROM job_listings WHERE source_id = ${sourceId})
      GROUP BY l.job_id
    ) s
    WHERE j.id = s.job_id AND j.closed_at IS DISTINCT FROM s.closed
    RETURNING old.closed_at AS was, new.closed_at AS now`);
  const changes = z.array(ClosedChange).parse([...rows]);
  return {
    closed: changes.filter((c) => c.was === null && c.now !== null).length,
    reopened: changes.filter((c) => c.was !== null && c.now === null).length,
  };
}

async function setStatus(
  tx: SyncTx,
  sourceId: SourceRow["id"],
  patch: Partial<
    Pick<SourceRow, "lastRunAt" | "lastOkAt" | "lastCount" | "lastOkCount" | "lastDropped" | "lastError"> & {
      lastStatus: SourceStatus;
    }
  >,
): Promise<void> {
  await tx.update(sources).set(patch).where(eq(sources.id, sourceId));
}

// ---------- prune ----------

/** Closed more than 60 days ago and never touched (no opportunity row): delete. Listings cascade. */
async function prune(deps: SyncDeps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - PRUNE_DAYS * DAY_MS);
  return asSync(deps.db, async (tx) => {
    const touched = tx.select({ one: sql`1` }).from(opportunities).where(eq(opportunities.jobId, jobs.id));
    const deleted = await tx
      .delete(jobs)
      .where(and(eq(jobs.userId, deps.userId), lt(jobs.closedAt, cutoff), notExists(touched)))
      .returning({ id: jobs.id });
    return deleted.length;
  });
}
