import type { JobId } from "@/shared/api";
import { isAutoMerge, type MergeKeys } from "./dedup";

/**
 * What one source run does (PLAN.md section 3.1, steps 5 to 7), decided without the database.
 * The service loads the source's listings and the jobs that could be the same posting, calls
 * `planSourceRun`, and applies the plan in one `asSync` transaction.
 */

/** An incomplete source closes a listing this long after its last sighting, counted from its last good run. */
export const STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/** A posting after normalization and the role filter. */
export type PlannedPosting = Omit<MergeKeys, "seenAt"> & {
  externalId: string;
  contentHash: string;
  postedAt: Date | null;
};

/** One of this source's listings as stored, with what the plan needs of its job. */
export type ExistingListing = {
  externalId: string;
  jobId: JobId;
  isPrimary: boolean;
  jobContentHash: string;
  jobExpiresAt: Date | null;
  lastSeenAt: Date;
  missingSince: Date | null;
};

/** A stored job that might be the same posting: same title key (both auto-merge rules need it). */
export type CandidateJob = MergeKeys & { id: JobId };

export type FetchOutcome =
  | { kind: "failed" | "rate_limited"; error: string }
  | {
      kind: "fetched";
      complete: boolean;
      /** Every external id the source returned, before the keyword and role filters. */
      fetchedIds: readonly string[];
      /**
       * External ids the board lists whose content was not read this run (SmartRecruiters' detail
       * budget). They are on the board, so a stored listing among them is seen, with its job unchanged.
       */
      unread: readonly string[];
      /** The role filter's sure drops. */
      dropped: number;
      /** What is left after both filters. */
      postings: readonly PlannedPosting[];
    };

/** Where a new listing goes: a stored job, or the job inserted from an earlier posting in this run. */
export type ListingTarget = { kind: "job"; jobId: JobId } | { kind: "inserted"; externalId: string };

export type Upsert =
  /** Listing exists: mark it seen. `rewrite` when it is the primary listing and the content changed. */
  | { kind: "seen"; externalId: string; jobId: JobId; rewrite: boolean }
  /** No listing, but a job is the same posting: add a non-primary listing. */
  | { kind: "attach"; externalId: string; to: ListingTarget }
  /** A new job and its primary listing. */
  | { kind: "insert"; externalId: string };

export type SourcePlan =
  | { kind: "failed" | "rate_limited"; error: string }
  | { kind: "suspicious_empty" }
  | {
      kind: "ok";
      upserts: Upsert[];
      /** External ids of listings to mark `missing_since = now`. */
      missing: string[];
      /** Jobs whose listing was missing and came back. */
      reopened: JobId[];
      /** Postings kept after the role filter. */
      count: number;
      rawCount: number;
      dropped: number;
    };

export function planSourceRun({
  source,
  fetched,
  existing,
  candidates,
  now,
}: {
  source: { lastOkCount: number | null };
  fetched: FetchOutcome;
  existing: readonly ExistingListing[];
  candidates: readonly CandidateJob[];
  now: Date;
}): SourcePlan {
  if (fetched.kind !== "fetched") return { kind: fetched.kind, error: fetched.error };
  // Zero postings after a healthy run looks like a broken source, not an empty board. The check
  // uses the count before filtering, so a strict role filter never looks broken.
  const onBoard = new Set([...fetched.fetchedIds, ...fetched.unread]);
  const rawCount = onBoard.size;
  if (rawCount === 0 && (source.lastOkCount ?? 0) > 0) return { kind: "suspicious_empty" };

  const byExternalId = new Map(existing.map((l) => [l.externalId, l]));
  const seenIds = new Set<string>();
  const inserted: (MergeKeys & { externalId: string })[] = [];
  const upserts: Upsert[] = [];
  const reopened: JobId[] = [];

  for (const posting of fetched.postings) {
    if (seenIds.has(posting.externalId)) continue;
    seenIds.add(posting.externalId);

    const listing = byExternalId.get(posting.externalId);
    if (listing) {
      upserts.push({
        kind: "seen",
        externalId: posting.externalId,
        jobId: listing.jobId,
        rewrite: listing.isPrimary && listing.jobContentHash !== posting.contentHash,
      });
      if (listing.missingSince !== null) reopened.push(listing.jobId);
      continue;
    }

    const keys: MergeKeys = { ...posting, seenAt: posting.postedAt ?? now };
    const job = candidates.find((c) => isAutoMerge({ a: keys, b: c }));
    if (job) {
      upserts.push({ kind: "attach", externalId: posting.externalId, to: { kind: "job", jobId: job.id } });
      continue;
    }
    const earlier = inserted.find((c) => isAutoMerge({ a: keys, b: c }));
    if (earlier) {
      upserts.push({
        kind: "attach",
        externalId: posting.externalId,
        to: { kind: "inserted", externalId: earlier.externalId },
      });
      continue;
    }
    inserted.push({ ...keys, externalId: posting.externalId });
    upserts.push({ kind: "insert", externalId: posting.externalId });
  }

  // Listed but not read: a stored listing is seen (and reopens), and its job keeps its content.
  // An unread posting with no listing waits for a later run's budget.
  for (const externalId of fetched.unread) {
    const listing = byExternalId.get(externalId);
    if (!listing || seenIds.has(externalId)) continue;
    seenIds.add(externalId);
    upserts.push({ kind: "seen", externalId, jobId: listing.jobId, rewrite: false });
    if (listing.missingSince !== null) reopened.push(listing.jobId);
  }

  const notSeen = existing.filter((l) => !seenIds.has(l.externalId) && l.missingSince === null);
  const missing = fetched.complete
    ? // A complete board lists every open posting, so absence means closed. A posting the filters
      // dropped is still on the board, so it is not missing.
      notSeen.filter((l) => !onBoard.has(l.externalId)).map((l) => l.externalId)
    : // A window of recent results: only expiry or a month without a sighting closes. This run is
      // the source's last good run, so a source that keeps failing never gets here and closes nothing.
      notSeen
        .filter(
          (l) =>
            (l.jobExpiresAt !== null && l.jobExpiresAt.getTime() < now.getTime()) ||
            now.getTime() > l.lastSeenAt.getTime() + STALE_DAYS * DAY_MS,
        )
        .map((l) => l.externalId);

  return {
    kind: "ok",
    upserts,
    missing,
    reopened,
    count: fetched.postings.length,
    rawCount,
    dropped: fetched.dropped,
  };
}
