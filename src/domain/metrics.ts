import type { OpportunityStatus } from "@/shared/enums";

/**
 * The Board's metrics line (decisions 51 and 52): over the last 30 days, applications sent, how
 * many of them reached Interviewing, the rate, and the median time from Saved to Ready. Read from
 * each opportunity's dated status history and `ready_at`; no new table.
 *
 * Definitions:
 * - The window is `(now - 30 days, now]`. Entries after `now` (clock skew) are ignored.
 * - An application is sent at the first entry that moves into Applied, Interviewing or Offer.
 *   Saved straight to Closed is not an application. An opportunity counts once, by that first
 *   entry, so moving back to Saved and applying again does not add a second application.
 * - Reached Interviewing: an application of the window with an entry into Interviewing or Offer.
 *   The rate is that count over applications, and null when there were none.
 * - Saved to Ready: for each job marked ready in the window, `ready_at` minus the latest move
 *   into Saved at or before it. It includes idle time, so it is an upper bound (decision 52).
 */

export const METRICS_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const APPLIED: readonly OpportunityStatus[] = ["applied", "interviewing", "offer"];
const INTERVIEWING: readonly OpportunityStatus[] = ["interviewing", "offer"];

export type StatusChange = { at: Date; to: OpportunityStatus };

/** What the metrics read from one opportunity. */
export type Timeline = { history: readonly StatusChange[]; readyAt: Date | null };

export type BoardMetrics = {
  windowDays: number;
  applied: number;
  interviewing: number;
  /** `interviewing / applied`, from 0 to 1. Null when nothing was applied to. */
  rate: number | null;
  /** Jobs marked ready in the window that have a save before their Ready time. */
  readyCount: number;
  /** Null when no job was marked ready in the window. */
  medianSavedToReadyMs: number | null;
};

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return (lower + upper) / 2;
}

/** The earliest time in `history` (up to `until`) that moved into one of `statuses`. */
function firstInto(history: readonly StatusChange[], statuses: readonly OpportunityStatus[], until: number) {
  let first: number | null = null;
  for (const { at, to } of history) {
    const t = at.getTime();
    if (t <= until && statuses.includes(to) && (first === null || t < first)) first = t;
  }
  return first;
}

/** The latest time in `history`, at or before `until`, that moved into Saved. */
function lastSave(history: readonly StatusChange[], until: number) {
  let last: number | null = null;
  for (const { at, to } of history) {
    const t = at.getTime();
    if (to === "saved" && t <= until && (last === null || t > last)) last = t;
  }
  return last;
}

export function boardMetrics({
  opportunities,
  now,
  windowDays = METRICS_WINDOW_DAYS,
}: {
  opportunities: readonly Timeline[];
  now: Date;
  windowDays?: number;
}): BoardMetrics {
  const end = now.getTime();
  const start = end - windowDays * DAY_MS;
  const inWindow = (t: number) => t > start && t <= end;

  let applied = 0;
  let interviewing = 0;
  const readyTimes: number[] = [];
  for (const { history, readyAt } of opportunities) {
    const appliedAt = firstInto(history, APPLIED, end);
    if (appliedAt !== null && inWindow(appliedAt)) {
      applied++;
      if (firstInto(history, INTERVIEWING, end) !== null) interviewing++;
    }
    const ready = readyAt?.getTime() ?? null;
    if (ready === null || !inWindow(ready)) continue;
    const saved = lastSave(history, ready);
    if (saved !== null) readyTimes.push(ready - saved);
  }

  return {
    windowDays,
    applied,
    interviewing,
    rate: applied === 0 ? null : interviewing / applied,
    readyCount: readyTimes.length,
    medianSavedToReadyMs: median(readyTimes),
  };
}
