import type { BoardMetricsDto, GateBlocker, OutdatedChange, StyleHit } from "./api";
import type {
  BuiltinSourceKind,
  DismissReason,
  Eligibility,
  ItemUsage,
  MatchLevel,
  MustAnswer,
  OpportunityStatus,
  OpportunityType,
  Outcome,
  OutputKind,
  PayPeriod,
  ProfileItemKind,
  RateType,
  RoleFamily,
  SourceKind,
  SourceStatus,
  UserSeniority,
} from "./enums";

/** Shown on every contract (decision 19). The app tracks nothing about it. */
export const CONTRACTOR_CAUTION = "US clients usually need a W-8BEN; payment and tax setup come up at interview.";

/** An Applied opportunity with no change for this many days shows the follow-up hint (decision 18). */
export const FOLLOW_UP_DAYS = 14;

export function outputKindLabel(kind: OutputKind): string {
  switch (kind) {
    case "resume":
      return "Resume";
    case "letter":
      return "Cover letter";
    case "message":
      return "Short message";
    case "answer":
      return "Answer";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function itemKindLabel(kind: ProfileItemKind): string {
  switch (kind) {
    case "cv":
      return "CV";
    case "experience":
      return "Experience";
    case "open_source":
      return "Open source";
    case "challenge":
      return "Challenge";
    case "other":
      return "Other";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function itemUsageLabel(usage: ItemUsage): string {
  switch (usage) {
    case "everywhere":
      return "Everywhere";
    case "letters_only":
      return "Letters and answers only";
    default: {
      const _exhaustive: never = usage;
      return _exhaustive;
    }
  }
}

export function mustAnswerLabel(category: MustAnswer): string {
  switch (category) {
    case "salary":
      return "Salary expectations";
    case "work_auth":
      return "Work authorization";
    case "notice":
      return "Notice period";
    case "start_date":
      return "Start date";
    case "references":
      return "References";
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

export function statusLabel({ type, status }: { type: OpportunityType; status: OpportunityStatus }): string {
  switch (status) {
    case "saved":
      return "Saved";
    case "applied":
      return type === "contract" ? "Proposal sent" : "Applied";
    case "interviewing":
      return "Interviewing";
    case "offer":
      return "Offer";
    case "closed":
      return "Closed";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    case "no_response":
      return "No response";
    case "withdrawn":
      return "Withdrawn";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function rateTypeLabel(rateType: RateType): string {
  switch (rateType) {
    case "hourly":
      return "Hourly";
    case "fixed":
      return "Fixed price";
    default: {
      const _exhaustive: never = rateType;
      return _exhaustive;
    }
  }
}

/** One sentence that names what blocks export and where to fix it. */
export function blockerLabel(blocker: GateBlocker): string {
  switch (blocker.kind) {
    case "must_answer":
      return `${mustAnswerLabel(blocker.category)}: "${blocker.question}" has no answer. Add one here or in your profile.`;
    case "placeholder":
      return `Fill in the placeholder: [[${blocker.text}]]`;
    case "not_drafted":
      return `${outputKindLabel(blocker.outputKind)} is empty. Write it, or untick it.`;
    case "deleted_fact":
      return `This cites ${blocker.factKey}, which you deleted. Remove the claim or cite another fact.`;
    default: {
      const _exhaustive: never = blocker;
      return _exhaustive;
    }
  }
}

/** Sentences longer than this are flagged by the style check. */
export const MAX_SENTENCE_WORDS = 35;

/** A short explanation of a hit for the editor. */
export function styleHitLabel(hit: Pick<StyleHit, "rule" | "phrase">): string {
  switch (hit.rule) {
    case "dash":
      return `Dash used as punctuation ("${hit.phrase}"). Use a full stop or a comma.`;
    case "banned_phrase":
      return `"${hit.phrase}" reads as machine-written. Say it plainly.`;
    case "adjective_triplet":
      return `Three adjectives in a row ("${hit.phrase}"). Keep the one that matters.`;
    case "long_sentence":
      return `Sentence over ${MAX_SENTENCE_WORDS} words. Split it.`;
    default: {
      const _exhaustive: never = hit.rule;
      return _exhaustive;
    }
  }
}

/** One line per changed fact in the outdated notice. */
export function outdatedLabel(change: Pick<OutdatedChange, "factKey" | "reason">): string {
  switch (change.reason) {
    case "edited":
      return `${change.factKey} changed`;
    case "deleted":
      return `${change.factKey} was deleted`;
    case "unconfirmed":
      return `${change.factKey} is no longer confirmed`;
    case "letters_only":
      return `${change.factKey} is now for letters only, so it cannot stay on a resume`;
    default: {
      const _exhaustive: never = change.reason;
      return _exhaustive;
    }
  }
}

/** The eligibility verdict as the UI names it (decision 7). */
export function eligibilityLabel(verdict: Eligibility): string {
  switch (verdict) {
    case "ph":
      return "Open to the Philippines";
    case "worldwide":
      return "Worldwide";
    case "apac":
      return "APAC";
    case "americas":
      return "Americas";
    case "excluded":
      return "Excluded";
    case "unclear":
      return "Unclear";
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

export function roleFamilyLabel(family: RoleFamily): string {
  switch (family) {
    case "engineering":
      return "Engineering";
    case "design":
      return "Design";
    case "product":
      return "Product";
    case "data":
      return "Data";
    case "qa":
      return "QA and testing";
    case "devops":
      return "DevOps and infrastructure";
    case "security":
      return "Security";
    case "sales":
      return "Sales";
    case "marketing":
      return "Marketing";
    case "support":
      return "Support and success";
    case "ops":
      return "Operations";
    case "people":
      return "People and recruiting";
    case "finance":
      return "Finance";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

/** A source's last run, in a few words. The error text, if any, is shown under it. */
export function sourceStatusLabel(status: SourceStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "failed":
      return "Failed";
    case "rate_limited":
      return "Rate limited";
    case "suspicious_empty":
      return "Returned nothing";
    case "skipped":
      return "Skipped, ran recently";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** A match level as Matches names it (section 3.7). */
export function matchLevelLabel(level: MatchLevel): string {
  switch (level) {
    case "strong":
      return "Strong";
    case "possible":
      return "Possible";
    case "weak":
      return "Weak";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/** Dismiss reasons as the popover lists them (decision 14). */
export function dismissReasonLabel(reason: DismissReason): string {
  switch (reason) {
    case "wrong_stack":
      return "Wrong stack";
    case "too_senior":
      return "Too senior";
    case "pay":
      return "Pay";
    case "location":
      return "Location";
    case "other":
      return "Other";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Your seniority on Profile (section 3.7). */
export function userSeniorityLabel(seniority: UserSeniority): string {
  switch (seniority) {
    case "junior":
      return "Junior";
    case "mid":
      return "Mid-level";
    case "senior":
      return "Senior";
    case "lead":
      return "Lead";
    case "staff":
      return "Staff";
    case "principal":
      return "Principal";
    default: {
      const _exhaustive: never = seniority;
      return _exhaustive;
    }
  }
}

/** A pay period after an amount: "150,000 a month". */
export function payPeriodLabel(period: PayPeriod): string {
  switch (period) {
    case "hour":
      return "an hour";
    case "day":
      return "a day";
    case "week":
      return "a week";
    case "month":
      return "a month";
    case "year":
      return "a year";
    default: {
      const _exhaustive: never = period;
      return _exhaustive;
    }
  }
}

/**
 * Each source's name and home page. `attribution` marks the boards whose terms ask for credit and
 * a link back (RemoteOK, We Work Remotely, Remotive): their jobs show "via <name>" with the
 * listing link, and the Sources screen links to the board.
 */
export const SOURCE_SITES: Readonly<Record<SourceKind, { name: string; url: string; attribution: boolean }>> = {
  jobicy: { name: "Jobicy", url: "https://jobicy.com", attribution: false },
  himalayas: { name: "Himalayas", url: "https://himalayas.app", attribution: false },
  remoteok: { name: "RemoteOK", url: "https://remoteok.com", attribution: true },
  weworkremotely: { name: "We Work Remotely", url: "https://weworkremotely.com", attribution: true },
  remotive: { name: "Remotive", url: "https://remotive.com", attribution: true },
  greenhouse: { name: "Greenhouse", url: "https://www.greenhouse.com", attribution: false },
  lever: { name: "Lever", url: "https://www.lever.co", attribution: false },
  ashby: { name: "Ashby", url: "https://www.ashbyhq.com", attribution: false },
  smartrecruiters: { name: "SmartRecruiters", url: "https://www.smartrecruiters.com", attribution: false },
  recruitee: { name: "Recruitee", url: "https://recruitee.com", attribution: false },
  workable: { name: "Workable", url: "https://www.workable.com", attribution: false },
};

/** One line per built-in board for the first-refresh panel (section 4, Setup checklist). */
export const BUILTIN_SOURCE_NOTES: Readonly<Record<BuiltinSourceKind, string>> = {
  jobicy: "The newest 100 remote jobs, with each job's allowed regions.",
  himalayas: "The newest 100 remote jobs; an empty location list means open worldwide.",
  remoteok: "The newest remote tech jobs, credited with a link back to RemoteOK.",
  weworkremotely: "Remote jobs from its RSS feed. You apply on We Work Remotely.",
  remotive: "Remote jobs shown 24 hours after posting. Read at most every six hours.",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Refreshed 3 days ago" for the top bar (decision 11), or "Not refreshed yet". */
export function refreshedLabel({ at, now }: { at: Date | null; now: Date }): string {
  if (at === null) return "Not refreshed yet";
  const ms = now.getTime() - at.getTime();
  if (ms < MINUTE_MS) return "Refreshed just now";
  if (ms < HOUR_MS) return `Refreshed ${count(Math.floor(ms / MINUTE_MS), "minute")} ago`;
  if (ms < DAY_MS) return `Refreshed ${count(Math.floor(ms / HOUR_MS), "hour")} ago`;
  return `Refreshed ${count(Math.floor(ms / DAY_MS), "day")} ago`;
}

/** "40 min", "5 hours", "2 days": rounded, for a median that is an upper bound anyway. */
export function durationLabel(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  if (ms < DAY_MS) return count(Math.round(ms / HOUR_MS), "hour");
  return count(Math.round(ms / DAY_MS), "day");
}

/**
 * The Board's metrics line (decision 52): "Last 30 days: 12 applied · 2 reached Interviewing (17%)
 * · median 40 min from saved to ready". Saved to Ready includes idle time, so it is worded as
 * elapsed time, not work time.
 */
export function metricsLine(m: BoardMetricsDto): string {
  const applied =
    m.rate === null
      ? "no applications sent"
      : `${m.applied} applied · ${m.interviewing} reached Interviewing (${Math.round(m.rate * 100)}%)`;
  const ready =
    m.medianSavedToReadyMs === null
      ? "no jobs marked ready"
      : `median ${durationLabel(m.medianSavedToReadyMs)} from saved to ready`;
  return `Last ${m.windowDays} days: ${applied} · ${ready}`;
}
