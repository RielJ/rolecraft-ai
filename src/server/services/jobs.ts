import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { applyUrlKey, type DuplicateCandidate, duplicateDiff, isAutoMerge, likelyDuplicates } from "@/domain/dedup";
import { toManila } from "@/domain/hours";
import { type FxRates, monthlyInView, type Pay } from "@/domain/pay";
import { type Derived, derive, type JobFields } from "@/domain/posting";
import type {
  AddJobResult,
  AddLinkInput,
  AddLinkResult,
  JobFacts,
  JobId,
  MergeResult,
  OpportunityId,
  PasteJobInput,
  SavedJob,
  UndoInput,
} from "@/shared/api";
import { type DismissReason, FILE_KINDS } from "@/shared/enums";
import { blockedSite } from "@/shared/hosts";
import { eligibilityLabel, SOURCE_SITES } from "@/shared/labels";
import { HttpError } from "../adapters/http";
import { readPage } from "../adapters/page-reader";
import type { Db } from "../db/client";
import { MERGE_SYNC_LOCK } from "../db/locks";
import { jobListings, jobs, opportunities, outputs, sources, tasks, users } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type JobRow = typeof jobs.$inferSelect;

/** Section 3.2 step 5: less description than this is too little to work from. */
const MIN_DESCRIPTION_CHARS = 600;

/** The three file rows a job gets when it lands on the board. */
async function addFileRows(tx: Tx, deps: Deps, opportunityId: OpportunityId): Promise<void> {
  await tx
    .insert(outputs)
    .values(FILE_KINDS.map((kind, position) => ({ userId: deps.userId, opportunityId, kind, position })));
}

/**
 * The job's opportunity on the board. A job with none gets one, Saved, with its three file rows.
 * A dismissed job goes back on the board as Saved (decision 14: dismissing only hides it).
 */
async function ensureOpportunity(tx: Tx, deps: Deps, jobId: JobRow["id"]): Promise<OpportunityId> {
  const now = deps.clock.now();
  const [existing] = await tx
    .select({ id: opportunities.id, status: opportunities.status, history: opportunities.history })
    .from(opportunities)
    .where(and(eq(opportunities.userId, deps.userId), eq(opportunities.jobId, jobId)))
    .for("update");
  if (existing && existing.status !== null) return existing.id;
  if (existing) {
    await tx
      .update(opportunities)
      .set({
        status: "saved",
        statusChangedAt: now,
        dismissedAt: null,
        dismissReason: null,
        history: [...existing.history, { at: now.toISOString(), from: null, to: "saved" }],
      })
      .where(eq(opportunities.id, existing.id));
    const files = await tx
      .select({ id: outputs.id })
      .from(outputs)
      .where(and(eq(outputs.opportunityId, existing.id), ne(outputs.kind, "answer")));
    if (files.length === 0) await addFileRows(tx, deps, existing.id);
    return existing.id;
  }

  const [opportunity] = await tx
    .insert(opportunities)
    .values({
      userId: deps.userId,
      jobId,
      status: "saved",
      statusChangedAt: now,
      history: [{ at: now.toISOString(), from: null, to: "saved" }],
    })
    .returning({ id: opportunities.id });
  if (!opportunity) throw new Error("Could not save the job to the board.");
  await addFileRows(tx, deps, opportunity.id);
  return opportunity.id;
}

/**
 * An existing job that is the same posting (decision 46): the same apply URL and title, or the
 * same company, title and description within 28 days.
 */
async function findSamePosting(tx: Tx, deps: Deps, derived: Derived, seenAt: Date): Promise<JobRow | null> {
  const sameUrl =
    derived.applyUrlKey === null
      ? undefined
      : and(eq(jobs.applyUrlKey, derived.applyUrlKey), eq(jobs.titleKey, derived.titleKey));
  const sameContent = and(
    eq(jobs.companyKey, derived.companyKey),
    eq(jobs.titleKey, derived.titleKey),
    eq(jobs.descriptionKey, derived.descriptionKey),
  );
  const rows = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, deps.userId), sameUrl ? or(sameUrl, sameContent) : sameContent));
  const keys = { ...derived, seenAt };
  return rows.find((row) => isAutoMerge({ a: keys, b: { ...row, seenAt: row.postedAt ?? row.firstSeenAt } })) ?? null;
}

/** Create the job (or find the same posting), then its opportunity. */
async function addJob(deps: Deps, origin: "link" | "paste", fields: JobFields): Promise<AddJobResult> {
  const now = deps.clock.now();
  const derived = derive(fields);
  return deps.db.transaction(async (tx) => {
    const same = await findSamePosting(tx, deps, derived, fields.postedAt ?? now);
    if (same) return { kind: "existing", opportunityId: await ensureOpportunity(tx, deps, same.id) };

    const [job] = await tx
      .insert(jobs)
      .values({ userId: deps.userId, origin, ...derived, firstSeenAt: now, updatedAt: now })
      .returning({ id: jobs.id });
    if (!job) throw new Error("Could not save the job.");
    return { kind: "created", opportunityId: await ensureOpportunity(tx, deps, job.id) };
  });
}

/**
 * Add a pasted job (section 3.2 step 6). It runs the same normalization as a linked job and
 * returns the existing job for the same posting: the same apply URL and title, or the same
 * company, title and description within 28 days.
 */
export async function addPastedJob(deps: Deps, input: PasteJobInput): Promise<AddJobResult> {
  return addJob(deps, "paste", {
    title: input.title,
    company: input.company,
    description: input.description,
    locationText: "",
    applyUrl: input.url ?? null,
    postedAt: null,
    expiresAt: null,
    pay: null,
    restrictions: null,
  });
}

/**
 * Add by link (section 3.2). Blocked hosts get the paste form without any request. A link that
 * matches exactly one job returns it before fetching. Otherwise the page is read once; too little
 * text, or no title or company, opens the paste form with whatever was found.
 */
export async function addJobFromLink(deps: Deps, { url }: AddLinkInput): Promise<AddLinkResult> {
  if (blockedSite(url) !== null) return { kind: "needs_paste", url, prefill: {}, reason: "blocked_host" };

  const key = applyUrlKey(url);
  if (key !== null) {
    const known = await deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, deps.userId), eq(jobs.applyUrlKey, key)))
      .limit(2);
    // Several jobs on one URL is a generic careers page: read it and match on the title too.
    const [only] = known;
    if (only && known.length === 1) {
      const opportunityId = await deps.db.transaction((tx) => ensureOpportunity(tx, deps, only.id));
      return { kind: "existing", opportunityId };
    }
  }

  let html: string;
  try {
    html = (await deps.http.getText(url)).body;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    console.info(
      JSON.stringify({ level: "info", msg: "add by link: fetch failed", kind: error.kind, status: error.status }),
    );
    return { kind: "needs_paste", url, prefill: {}, reason: "fetch_failed" };
  }

  const page = readPage({ html });
  const title = page.title?.trim() ?? "";
  const company = page.company?.trim() ?? "";
  const prefill = { ...(title ? { title } : {}), ...(company ? { company } : {}) };
  if (!title || !company || page.description.trim().length < MIN_DESCRIPTION_CHARS) {
    return { kind: "needs_paste", url, prefill, reason: "too_little_text" };
  }
  return addJob(deps, "link", {
    title,
    company,
    description: page.description,
    locationText: page.locationText,
    applyUrl: url,
    postedAt: page.postedAt,
    expiresAt: page.expiresAt,
    pay: page.pay,
    restrictions: page.restrictions,
  });
}

// ---------- the job as the workspace header shows it ----------

function payOf(job: JobRow): Omit<Pay, "phrase"> | null {
  if (job.payMin === null || job.payCurrency === null) return null;
  return {
    min: Number(job.payMin),
    max: job.payMax === null ? null : Number(job.payMax),
    currency: job.payCurrency,
    period: job.payPeriod,
  };
}

function payFacts(
  job: JobRow,
  money: { viewCurrency: string; fxRates: Record<string, { rate: number }> },
): JobFacts["pay"] {
  const pay = payOf(job);
  if (pay === null) return null;
  const rates: FxRates = Object.fromEntries(Object.entries(money.fxRates).map(([code, e]) => [code, e.rate]));
  const converted = monthlyInView({ pay, viewCurrency: money.viewCurrency, rates });
  const posted = job.payPhrase ?? "";
  const noRate = pay.period !== null && pay.currency !== money.viewCurrency && rates[pay.currency] === undefined;
  return { posted, converted, missingRate: converted === null && noRate ? pay.currency : null };
}

function candidateOf(row: JobRow): DuplicateCandidate {
  return {
    id: row.id,
    titleKey: row.titleKey,
    companyKey: row.companyKey,
    description: row.description,
    locationText: row.locationText,
    payPhrase: row.payPhrase,
    skills: row.skills,
    minYears: row.minYears,
    closedAt: row.closedAt,
  };
}

const MAX_DUPLICATES_SHOWN = 3;

/** Section 3.8: the reason Merge is disabled, and the 409 message when it is called anyway. */
export const BOTH_ON_BOARD = "Both are on your board. Close one instead.";

function originName(origin: JobRow["origin"]): string {
  switch (origin) {
    case "link":
      return "added by link";
    case "paste":
      return "pasted";
    // Only when every listing is gone; a synced job normally names its board.
    case "source":
      return "job board";
    default: {
      const never: never = origin;
      return never;
    }
  }
}

/** Where each job came from, for the hint's "(Greenhouse)": the primary listing's board first. */
async function sourceNames(deps: Deps, rows: readonly JobRow[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const row of rows) names.set(row.id, originName(row.origin));
  if (rows.length === 0) return names;
  const listings = await deps.db
    .select({ jobId: jobListings.jobId, kind: sources.kind })
    .from(jobListings)
    .innerJoin(sources, eq(sources.id, jobListings.sourceId))
    .where(
      inArray(
        jobListings.jobId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(jobListings.isPrimary), asc(sources.label));
  const named = new Set<string>();
  for (const { jobId, kind } of listings) {
    if (named.has(jobId)) continue;
    named.add(jobId);
    names.set(jobId, SOURCE_SITES[kind].name);
  }
  return names;
}

/** Open jobs that may be the same as `job` (section 3.8), computed on read. */
async function possibleDuplicates(deps: Deps, job: JobRow): Promise<JobFacts["possibleDuplicates"]> {
  const [rows, [own]] = await Promise.all([
    deps.db
      .select({ job: jobs, opportunityId: opportunities.id, status: opportunities.status })
      .from(jobs)
      .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
      .where(
        and(
          eq(jobs.userId, deps.userId),
          ne(jobs.id, job.id),
          isNull(jobs.closedAt),
          or(eq(jobs.companyKey, job.companyKey), eq(jobs.titleKey, job.titleKey)),
        ),
      ),
    deps.db.select({ status: opportunities.status }).from(opportunities).where(eq(opportunities.jobId, job.id)),
  ]);
  const self = candidateOf(job);
  const byId = new Map<string, (typeof rows)[number]>(rows.map((r) => [r.job.id, r]));
  const shown = likelyDuplicates({ job: self, candidates: rows.map((r) => candidateOf(r.job)) })
    .slice(0, MAX_DUPLICATES_SHOWN)
    .flatMap((c) => {
      const row = byId.get(c.id);
      return row ? [{ row, candidate: c }] : [];
    });
  const names = await sourceNames(
    deps,
    shown.map((s) => s.row.job),
  );
  const ownOnBoard = (own?.status ?? null) !== null;
  return shown.map(({ row, candidate }) => ({
    jobId: row.job.id,
    title: row.job.title,
    company: row.job.company,
    opportunityId: row.opportunityId,
    source: names.get(row.job.id) ?? originName(row.job.origin),
    diff: duplicateDiff({ job: self, other: candidate }),
    merge: ownOnBoard && row.status !== null ? { kind: "blocked", reason: BOTH_ON_BOARD } : { kind: "ready" },
  }));
}

/** Verdict and phrase, PH-time hours, converted pay and duplicate hints for one job. */
export async function jobFacts(deps: Deps, job: JobRow): Promise<JobFacts> {
  const [[money], duplicates] = await Promise.all([
    deps.db
      .select({ viewCurrency: users.viewCurrency, fxRates: users.fxRates })
      .from(users)
      .where(eq(users.id, deps.userId)),
    possibleDuplicates(deps, job),
  ]);
  const on = job.postedAt ?? job.firstSeenAt;
  return {
    locationText: job.locationText,
    eligibility: {
      verdict: job.eligibility,
      label: eligibilityLabel(job.eligibility),
      phrase: job.eligibilityPhrase,
    },
    hours: job.hours === null ? null : { phrase: job.hours.phrase, manila: toManila({ hours: job.hours, on }) },
    pay: payFacts(job, money ?? { viewCurrency: "PHP", fxRates: {} }),
    expiresAt: job.expiresAt?.toISOString() ?? null,
    possibleDuplicates: duplicates,
  };
}

// ---------- save, dismiss and undo from Matches (section 4, keys s, d and z) ----------

async function ownJob(tx: Tx, deps: Deps, jobId: JobId): Promise<void> {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.userId, deps.userId), eq(jobs.id, jobId)));
  if (!job) throw notFound("That job");
}

/** Save a match to the board as Saved. Saving a job already on the board returns it as it is. */
export async function saveJob(deps: Deps, jobId: JobId): Promise<SavedJob> {
  return deps.db.transaction(async (tx) => {
    await ownJob(tx, deps, jobId);
    return { opportunityId: await ensureOpportunity(tx, deps, jobId) };
  });
}

/**
 * Hide a match, with an optional reason (decision 14). The reason is stored but not used for
 * ranking yet. A job on the board is closed there, not dismissed.
 */
export async function dismissJob(
  deps: Deps,
  { jobId, reason }: { jobId: JobId; reason: DismissReason | null },
): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await ownJob(tx, deps, jobId);
    const [existing] = await tx
      .select({ id: opportunities.id, status: opportunities.status })
      .from(opportunities)
      .where(eq(opportunities.jobId, jobId))
      .for("update");
    if (existing?.status) {
      throw new AppError({
        code: "on_board",
        message: "This job is on your board, so it cannot be dismissed. Close it on the Board instead.",
      });
    }
    if (existing) {
      await tx
        .update(opportunities)
        .set({ dismissedAt: now, dismissReason: reason })
        .where(eq(opportunities.id, existing.id));
      return;
    }
    await tx.insert(opportunities).values({ userId: deps.userId, jobId, dismissedAt: now, dismissReason: reason });
  });
}

/**
 * Undo a save or a dismiss from Matches (key z): the job goes back in the list. A save is undone
 * only while nothing was done on the board: still Saved, never moved, no drafts, questions or
 * notes. Undoing what did not happen is a no-op, so a double press is harmless.
 */
export async function undoJob(deps: Deps, { jobId, action }: { jobId: JobId } & UndoInput): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await ownJob(tx, deps, jobId);
    const [opportunity] = await tx.select().from(opportunities).where(eq(opportunities.jobId, jobId)).for("update");
    if (!opportunity) return;
    if (action === "dismiss") {
      if (opportunity.status === null) await tx.delete(opportunities).where(eq(opportunities.id, opportunity.id));
      return;
    }
    if (opportunity.status === null) return;
    const rows = await tx
      .select({ kind: outputs.kind, body: outputs.body })
      .from(outputs)
      .where(eq(outputs.opportunityId, opportunity.id));
    const untouched =
      opportunity.status === "saved" &&
      opportunity.history.length === 1 &&
      opportunity.type === "job" &&
      opportunity.notes === "" &&
      opportunity.readyAt === null &&
      rows.every((r) => r.kind !== "answer" && r.body === null);
    if (!untouched) {
      throw new AppError({
        code: "has_work",
        message: "This job has work on the board now, so it stays there. Move or close it on the Board.",
      });
    }
    // Outputs cascade with the opportunity.
    await tx.delete(opportunities).where(eq(opportunities.id, opportunity.id));
  });
}

// ---------- merge a likely duplicate (section 3.8) ----------

type MergeSide = {
  id: JobId;
  opportunity: { id: OpportunityId; status: (typeof opportunities.$inferSelect)["status"] } | null;
};

/**
 * `POST /api/jobs/:id/merge { into }` (section 3.8, decision 10). Keeps the job that has an
 * opportunity, moves the other's listings to it as non-primary, and deletes the other, in one
 * transaction as the app role (never `hb_sync`). With no opportunity on either, `into` is kept.
 *
 * A dismissed-only opportunity (no board status) counts as having one, so a job you dismissed
 * stays dismissed. When the loser holds only a dismissal, that row goes with it: a dismissal never
 * has files, history or notes, because a job on the board cannot be dismissed. Both on the board
 * is `409 both_on_board`, and any merge while a refresh runs is `409 refresh_running`. The
 * exclusive `MERGE_SYNC_LOCK` makes that check race-free against sync's shared hold on it.
 */
export async function mergeJob(deps: Deps, { jobId, into }: { jobId: JobId; into: JobId }): Promise<MergeResult> {
  if (jobId === into) {
    throw new AppError({ code: "invalid_input", message: "A job cannot be merged into itself." });
  }
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    // First statement: wait for any sync transaction in flight, and keep new ones out until this
    // commits (`locks.ts`). The refresh check below then sees every refresh that could apply.
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${MERGE_SYNC_LOCK})`));
    const [running] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, deps.userId), eq(tasks.kind, "refresh"), eq(tasks.status, "running")));
    if (running) {
      throw new AppError({
        code: "refresh_running",
        message: "A refresh is running. Merge when it finishes.",
        details: { taskId: running.id },
      });
    }

    // Lock both rows (in id order, so two opposite merges cannot deadlock) before reading their state.
    const locked = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, deps.userId), inArray(jobs.id, [jobId, into])))
      .orderBy(asc(jobs.id))
      .for("update");
    if (!locked.some((j) => j.id === jobId)) throw notFound("That job");
    if (!locked.some((j) => j.id === into)) throw notFound("The job to merge into");

    const opps = await tx
      .select({ id: opportunities.id, jobId: opportunities.jobId, status: opportunities.status })
      .from(opportunities)
      .where(inArray(opportunities.jobId, [jobId, into]))
      .for("update");
    const side = (id: JobId) => {
      const o = opps.find((x) => x.jobId === id);
      return { id, opportunity: o ? { id: o.id, status: o.status } : null };
    };
    const { keep, drop } = pickKept({ source: side(jobId), target: side(into) });

    await tx.update(jobListings).set({ jobId: keep.id, isPrimary: false }).where(eq(jobListings.jobId, drop.id));
    // `opportunities.job_id` is ON DELETE RESTRICT: the loser's dismissal goes first.
    if (drop.opportunity) await tx.delete(opportunities).where(eq(opportunities.id, drop.opportunity.id));
    await tx.delete(jobs).where(eq(jobs.id, drop.id));
    // A job is closed when all its listings are missing; the moved ones may reopen it.
    const kept = await tx
      .select({ missingSince: jobListings.missingSince })
      .from(jobListings)
      .where(eq(jobListings.jobId, keep.id));
    if (kept.length > 0) {
      const missing = kept.flatMap((l) => (l.missingSince ? [l.missingSince.getTime()] : []));
      const closedAt = missing.length === kept.length ? new Date(Math.max(...missing)) : null;
      await tx.update(jobs).set({ closedAt, updatedAt: now }).where(eq(jobs.id, keep.id));
    }
    return { jobId: keep.id, opportunityId: keep.opportunity?.id ?? null };
  });
}

/** Board first, then any opportunity (a dismissal), then the merge target. */
function pickKept({ source, target }: { source: MergeSide; target: MergeSide }): { keep: MergeSide; drop: MergeSide } {
  const rank = (s: MergeSide) => (s.opportunity === null ? 0 : s.opportunity.status === null ? 1 : 2);
  if (rank(source) === 2 && rank(target) === 2) {
    throw new AppError({ code: "both_on_board", message: BOTH_ON_BOARD });
  }
  return rank(source) > rank(target) ? { keep: source, drop: target } : { keep: target, drop: source };
}
