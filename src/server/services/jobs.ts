import { and, eq, isNull, ne, or } from "drizzle-orm";
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
  OpportunityId,
  PasteJobInput,
  SavedJob,
  UndoInput,
} from "@/shared/api";
import { type DismissReason, FILE_KINDS } from "@/shared/enums";
import { blockedSite } from "@/shared/hosts";
import { eligibilityLabel } from "@/shared/labels";
import { HttpError } from "../adapters/http";
import { readPage } from "../adapters/page-reader";
import type { Db } from "../db/client";
import { jobs, opportunities, outputs, users } from "../db/schema";
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

/** Open jobs that may be the same as `job` (section 3.8), computed on read. */
async function possibleDuplicates(deps: Deps, job: JobRow): Promise<JobFacts["possibleDuplicates"]> {
  const rows = await deps.db
    .select({ job: jobs, opportunityId: opportunities.id })
    .from(jobs)
    .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
    .where(
      and(
        eq(jobs.userId, deps.userId),
        ne(jobs.id, job.id),
        isNull(jobs.closedAt),
        or(eq(jobs.companyKey, job.companyKey), eq(jobs.titleKey, job.titleKey)),
      ),
    );
  const self = candidateOf(job);
  const byId = new Map<string, (typeof rows)[number]>(rows.map((r) => [r.job.id, r]));
  return likelyDuplicates({ job: self, candidates: rows.map((r) => candidateOf(r.job)) })
    .slice(0, MAX_DUPLICATES_SHOWN)
    .flatMap((c) => {
      const row = byId.get(c.id);
      if (!row) return [];
      return [
        {
          jobId: row.job.id,
          title: row.job.title,
          company: row.job.company,
          opportunityId: row.opportunityId,
          diff: duplicateDiff({ job: self, other: c }),
        },
      ];
    });
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
