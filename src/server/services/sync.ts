import { and, asc, eq, gt, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { acceptAiVerdict } from "@/domain/eligibility";
import { BUILTIN_SKILLS, type SkillDictionary } from "@/domain/features";
import { type Derived, derive, jobSkills } from "@/domain/posting";
import { buildEligibilityPrompt, ELIGIBILITY_MAX_TOKENS } from "@/domain/prompts";
import { matchesKeywords, roleDropReason, roleFit } from "@/domain/roles";
import { type FetchOutcome, type PlannedPosting, planSourceRun, type SourcePlan } from "@/domain/sync-plan";
import type { AiPassResult, JobId, RefreshResult, RefreshSourceResult } from "@/shared/api";
import { BUILTIN_SOURCE_KINDS, type SourceStatus } from "@/shared/enums";
import { type Posting, SourceError } from "../adapters/sources";
import { jobListings, jobs, opportunities, roleDrops, sources, users } from "../db/schema";
import { asSync, type SyncTx } from "../db/sync-session";
import { estimateUsd, loadAiTierConfig, monthSpend, runAi } from "./ai";
import { parseEligibilityReply } from "./ai-replies";
import { AppError, type Deps } from "./context";
import type { TaskContext } from "./tasks";

/**
 * The refresh pipeline (PLAN.md section 3.1). Every statement runs as `hb_sync` through
 * `asSync`, which may write only jobs, listings, role drops and the `last_*` columns of sources
 * (section 2, drizzle/0006_filtered_sync_grants.sql).
 * This module may not import the app-role client (architecture test); task progress goes
 * through `ctx.step`, which the task module owns. Fetching happens outside any transaction, and
 * each source is applied in its own, so an interrupted refresh leaves every source either fully
 * applied or untouched.
 */

type SyncDeps = Pick<Deps, "db" | "userId" | "sources" | "clock" | "ai" | "aiSource" | "keyStore">;
type SourceRow = typeof sources.$inferSelect;
type Targeting = {
  targetTitles: readonly string[];
  roleFamilies: (typeof users.$inferSelect)["roleFamilies"];
  excludeTitleWords: readonly string[];
};

/** Closed jobs nobody touched are deleted this long after closing (decision 15). */
export const PRUNE_DAYS = 60;
/** The AI eligibility pass reads at most this many new unclear jobs per refresh (section 3.1 step 8). */
export const AI_PASS_LIMIT = 25;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const isBuiltin = (kind: SourceRow["kind"]) => BUILTIN_SOURCE_KINDS.some((k) => k === kind);

/**
 * `skills` is the user's dictionary (decision 66). The caller reads it as the app role before the
 * refresh starts, because `hb_sync` has no grant on `user_skills`.
 */
export async function runRefresh(
  deps: SyncDeps,
  ctx: Pick<TaskContext, "step" | "taskId">,
  { skills = BUILTIN_SKILLS }: { skills?: SkillDictionary } = {},
): Promise<RefreshResult> {
  const { enabled, targeting, aiEligibility } = await asSync(deps.db, async (tx) => {
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
        aiEligibility: users.aiEligibilityOnRefresh,
      })
      .from(users)
      .where(eq(users.id, deps.userId));
    if (!user) throw new Error("The user row is missing.");
    const { aiEligibility, ...targeting } = user;
    return { enabled: rows, targeting, aiEligibility };
  });

  const results: RefreshSourceResult[] = [];
  const newJobIds: JobId[] = [];
  for (const [index, source] of enabled.entries()) {
    await ctx.step(`${source.label} ${index + 1} of ${enabled.length}`);
    const run = await refreshSource({ deps, source, targeting, skills });
    results.push(run.result);
    newJobIds.push(...run.newJobIds);
  }

  await ctx.step("Reading skills in stored jobs");
  const skillsReread = await rereadSkills({ deps, skills });

  const aiPass = aiEligibility ? await aiEligibilityPass({ deps, ctx, newJobIds }) : NOT_RUN_OFF;

  await ctx.step("Removing old closed jobs");
  const pruned = await prune(deps);
  return { sources: results, pruned, aiPass, skillsReread };
}

// ---------- one source ----------

type Normalized = { posting: Posting; derived: Derived };
/** A posting the role filter dropped, as the slim row the Board shows (decision 53). */
type Drop = { title: string; company: string; url: string; reason: string; postedAt: Date | null };
type Fetched = FetchOutcome & { normalized?: Map<string, Normalized>; drops?: Map<string, Drop> };
/** Role drops go in batches, well under Postgres' 65535 parameters per statement. */
const DROP_BATCH = 1000;
/** One source's summary, and the jobs it inserted (for the AI eligibility pass). */
type SourceRun = { result: RefreshSourceResult; newJobIds: JobId[] };

async function refreshSource({
  deps,
  source,
  targeting,
  skills,
}: {
  deps: SyncDeps;
  source: SourceRow;
  targeting: Targeting;
  skills: SkillDictionary;
}): Promise<SourceRun> {
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
    return { result: { ...base, ...EMPTY_COUNTS, status: "skipped", error: null }, newJobIds: [] };
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
  const fetched: Fetched = adapter
    ? await fetchAndFilter({ adapter, source, targeting, known, skills })
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
    return applyPlan({
      tx,
      deps,
      source,
      plan,
      normalized: fetched.normalized ?? new Map(),
      drops: fetched.drops ?? new Map(),
      now,
      base,
    });
  });
}

const EMPTY_COUNTS = { fetched: 0, dropped: 0, added: 0, updated: 0, closed: 0, reopened: 0 };

/** Fetch, then the keyword filter (built-ins only) and the role filter, then normalize. */
async function fetchAndFilter({
  adapter,
  source,
  targeting,
  known,
  skills,
}: {
  adapter: NonNullable<SyncDeps["sources"][SourceRow["kind"]]>;
  source: SourceRow;
  targeting: Targeting;
  known: ReadonlySet<string>;
  skills: SkillDictionary;
}): Promise<Fetched> {
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
  const drops = new Map<string, Drop>();
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
      drops.set(posting.externalId, {
        title: posting.title,
        company: posting.company,
        url: posting.listingUrl,
        reason: roleDropReason({ title: posting.title, fit, excludeWords: targeting.excludeTitleWords }),
        postedAt: posting.postedAt,
      });
      continue;
    }
    if (normalized.has(posting.externalId)) continue;
    normalized.set(posting.externalId, { posting, derived: derive(posting, skills) });
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
    drops,
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
  drops,
  now,
  base,
}: {
  tx: SyncTx;
  deps: SyncDeps;
  source: SourceRow;
  plan: SourcePlan;
  normalized: Map<string, Normalized>;
  drops: Map<string, Drop>;
  now: Date;
  base: Pick<RefreshSourceResult, "sourceId" | "label">;
}): Promise<SourceRun> {
  switch (plan.kind) {
    case "failed":
    case "rate_limited": {
      // A thrown fetch writes only the status. Nothing closes.
      await setStatus(tx, source.id, { lastRunAt: now, lastStatus: plan.kind, lastError: plan.error });
      return { result: { ...base, ...EMPTY_COUNTS, status: plan.kind, error: plan.error }, newJobIds: [] };
    }
    case "suspicious_empty": {
      const error = `${source.label} returned no postings after returning ${source.lastOkCount ?? 0} last time. Nothing was closed; if the board really is empty, this clears once it lists a job again.`;
      await setStatus(tx, source.id, { lastRunAt: now, lastStatus: "suspicious_empty", lastError: error });
      return { result: { ...base, ...EMPTY_COUNTS, status: "suspicious_empty", error }, newJobIds: [] };
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

  await replaceDrops(tx, { source, drops, now, userId: deps.userId });
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
    result: {
      ...base,
      status: "ok",
      fetched: plan.rawCount,
      dropped: plan.dropped,
      added,
      updated,
      closed,
      reopened,
      error: null,
    },
    newJobIds: [...insertedJobs.values()],
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
 * An ok run replaces this source's role drops; other sources' rows stay (decision 53). A failed,
 * rate-limited, suspicious or skipped run never reaches here, so its drops stay as they were.
 * No RETURNING or ON CONFLICT: hb_sync may only insert and delete these rows.
 */
async function replaceDrops(
  tx: SyncTx,
  { source, drops, now, userId }: { source: SourceRow; drops: Map<string, Drop>; now: Date; userId: Deps["userId"] },
): Promise<void> {
  await tx.delete(roleDrops).where(eq(roleDrops.sourceId, source.id));
  // Rows are replaced on every run, so "newest" goes by the posting's date where the board gives one.
  const rows = [...drops].map(([externalId, { postedAt, ...drop }]) => ({
    sourceId: source.id,
    externalId,
    userId,
    ...drop,
    seenAt: postedAt ?? now,
  }));
  for (let i = 0; i < rows.length; i += DROP_BATCH) {
    await tx.insert(roleDrops).values(rows.slice(i, i + DROP_BATCH));
  }
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

// ---------- skills in stored jobs (decision 66) ----------

/** Open jobs are read again in batches this size, each its own transaction. */
export const REREAD_BATCH = 500;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Read the skills of every open job again with the current dictionary, so a skill the user added,
 * or one added to the built-ins, shows on jobs stored before it. Only rows whose skills changed
 * are written, with one `UPDATE ... FROM (VALUES ...)` per batch. Returns how many changed.
 */
export async function rereadSkills({
  deps,
  skills,
}: {
  deps: Pick<SyncDeps, "db" | "userId">;
  skills: SkillDictionary;
}): Promise<number> {
  let changed = 0;
  let after: JobId | null = null;
  for (;;) {
    const batch: { last: JobId | null; changed: number } = await asSync(deps.db, async (tx) => {
      const rows = await tx
        .select({ id: jobs.id, title: jobs.title, description: jobs.description, skills: jobs.skills })
        .from(jobs)
        .where(
          and(eq(jobs.userId, deps.userId), isNull(jobs.closedAt), after === null ? undefined : gt(jobs.id, after)),
        )
        .orderBy(asc(jobs.id))
        .limit(REREAD_BATCH);
      const updates = rows.flatMap((row) => {
        const next = jobSkills(row, skills);
        return sameList(next, row.skills) ? [] : [{ id: row.id, skills: next }];
      });
      if (updates.length > 0) {
        // Each list goes as one JSON parameter: a bare array would be spread into separate parameters.
        const values = sql.join(
          updates.map((u) => sql`(${u.id}::uuid, ${JSON.stringify(u.skills)}::jsonb)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE jobs j
          SET skills = ARRAY(SELECT e.value FROM jsonb_array_elements_text(v.skills) WITH ORDINALITY e(value, n) ORDER BY e.n)
          FROM (VALUES ${values}) AS v(id, skills)
          WHERE j.id = v.id`);
      }
      return { last: rows.length < REREAD_BATCH ? null : (rows.at(-1)?.id ?? null), changed: updates.length };
    });
    changed += batch.changed;
    if (batch.last === null) return changed;
    after = batch.last;
  }
}

// ---------- AI eligibility pass (section 3.1 step 8) ----------

const NOT_RUN_OFF: AiPassResult = { kind: "not_run", reason: "off" };
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Jobs first seen in this refresh whose rules said `unclear` go to the light model, at most 25.
 * Everything runs as `hb_sync`: `runAi` reads the config and month total and records `ai_calls`
 * through the sync transaction. A verdict is kept only with a phrase copied verbatim from the
 * posting. When the estimate would cross the monthly cap the pass does not run at all, since
 * nobody is there to confirm; if real costs cross it midway, `runAi` refuses and the pass stops.
 * Each job is its own transaction, so a stop keeps the verdicts already written.
 */
async function aiEligibilityPass({
  deps,
  ctx,
  newJobIds,
}: {
  deps: SyncDeps;
  ctx: Pick<TaskContext, "step" | "taskId">;
  newJobIds: readonly JobId[];
}): Promise<AiPassResult> {
  const plan = await asSync(deps.db, async (tx) => {
    const config = await loadAiTierConfig({ ...deps, db: tx }, { tier: "light" });
    if (!config) return null;
    const unclear =
      newJobIds.length === 0
        ? []
        : await tx
            .select({
              id: jobs.id,
              title: jobs.title,
              company: jobs.company,
              description: jobs.description,
              locationText: jobs.locationText,
              contentHash: jobs.contentHash,
            })
            .from(jobs)
            .where(and(eq(jobs.userId, deps.userId), inArray(jobs.id, [...newJobIds]), eq(jobs.eligibility, "unclear")))
            .orderBy(jobs.firstSeenAt, jobs.id);
    const batch = unclear
      .slice(0, AI_PASS_LIMIT)
      .map((job) => ({ job, prompt: buildEligibilityPrompt({ posting: job }) }));
    const estimate = batch.reduce(
      (sum, { prompt }) => sum + estimateUsd({ model: config.model, prompt, maxOutputTokens: ELIGIBILITY_MAX_TOKENS }),
      0,
    );
    const { usd } = await monthSpend({ ...deps, db: tx });
    return { capUsd: config.capUsd, batch, left: unclear.length - batch.length, estimate, monthUsd: usd };
  });
  if (!plan) return { kind: "not_run", reason: "no_ai" };
  const { batch, left, capUsd, estimate, monthUsd } = plan;
  if (batch.length > 0 && capUsd !== null && monthUsd + estimate > capUsd) {
    return {
      kind: "skipped",
      reason: "over_cap",
      jobs: batch.length,
      estimateUsd: round4(estimate),
      monthUsd: round4(monthUsd),
      capUsd,
    };
  }

  let decided = 0;
  let unbacked = 0;
  let checked = 0;
  let stopped: Extract<AiPassResult, { kind: "ran" }>["stopped"] = null;
  for (const [index, { job, prompt }] of batch.entries()) {
    await ctx.step(`Checking eligibility with AI · ${index + 1} of ${batch.length}`);
    try {
      const outcome = await asSync(deps.db, async (tx) => {
        const { text } = await runAi(
          { ...deps, db: tx },
          {
            tier: "light",
            purpose: "eligibility",
            taskId: ctx.taskId,
            prompt,
            maxOutputTokens: ELIGIBILITY_MAX_TOKENS,
          },
        );
        const answer = parseEligibilityReply(text);
        const accepted = answer && acceptAiVerdict({ answer, description: job.description });
        if (!accepted) return "unbacked" as const;
        // Only while the job is still the posting the model read and nobody else decided it.
        await tx
          .update(jobs)
          .set({ eligibility: accepted.verdict, eligibilityPhrase: accepted.phrase, eligibilityBy: "ai" })
          .where(and(eq(jobs.id, job.id), eq(jobs.eligibility, "unclear"), eq(jobs.contentHash, job.contentHash)));
        return "decided" as const;
      });
      checked++;
      if (outcome === "decided") decided++;
      else unbacked++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      stopped = { reason: error.code === "over_cap" ? "over_cap" : "ai_failed", message: error.message };
      break;
    }
  }
  return { kind: "ran", checked, decided, unbacked, left: left + (batch.length - checked), stopped };
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
