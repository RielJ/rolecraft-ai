import type {
  BoardMetricsDto,
  FillRatesResult,
  FxRateBy,
  GateBlocker,
  MatchSkills,
  OutdatedChange,
  StyleHit,
} from "./api";
import { parseBlank } from "./blanks";
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
    case "placeholder": {
      const blank = parseBlank(blocker.text);
      return blank.kind === "check"
        ? `Check a sentence your facts don't back: "${blank.sentence}"`
        : `Fill in: ${blank.label}`;
    }
    case "not_drafted":
      return `${outputKindLabel(blocker.outputKind)} is empty. Write it, or untick it.`;
    case "deleted_fact":
      return "This uses a fact you deleted. Regenerate it, or edit the claim out.";
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
    case "pronoun":
      return `"${hit.phrase}" in a resume. Drop the pronoun and start with the verb.`;
    case "repeated_opener":
      return `Starts with "${hit.phrase}", like other bullets near it. Start with a different verb that fits.`;
    case "same_shape":
      return `Ends with a ", ${hit.phrase} …" clause, like most bullets. Put the result first, or drop the clause.`;
    default: {
      const _exhaustive: never = hit.rule;
      return _exhaustive;
    }
  }
}

/** One line per changed fact in the outdated notice. */
export function outdatedLabel(reason: OutdatedChange["reason"]): string {
  switch (reason) {
    case "edited":
      return "A fact this used changed";
    case "deleted":
      return "A fact this used was deleted";
    case "unconfirmed":
      return "A fact this used is no longer confirmed";
    case "letters_only":
      return "A fact this used is now for letters only, so it cannot stay on a resume";
    default: {
      const _exhaustive: never = reason;
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

/** "just now", "1 minute ago", "2 hours ago", "3 days ago". A time a little ahead of the clock is "just now". */
export function agoLabel({ at, now }: { at: Date; now: Date }): string {
  const ms = now.getTime() - at.getTime();
  if (ms < MINUTE_MS) return "just now";
  if (ms < HOUR_MS) return `${count(Math.floor(ms / MINUTE_MS), "minute")} ago`;
  if (ms < DAY_MS) return `${count(Math.floor(ms / HOUR_MS), "hour")} ago`;
  return `${count(Math.floor(ms / DAY_MS), "day")} ago`;
}

/** "Refreshed 3 days ago" for the top bar (decision 11), or "Not refreshed yet". */
export function refreshedLabel({ at, now }: { at: Date | null; now: Date }): string {
  return at === null ? "Not refreshed yet" : `Refreshed ${agoLabel({ at, now })}`;
}

/**
 * Words past which a resume likely runs to a second page. Measured on the PDF template: a
 * bullet-heavy draft fit 343 words on page one, and the user's own two-page CV averages about 400
 * a page. A word count only estimates, so it warns and Preview PDF shows the real length.
 */
export const RESUME_ONE_PAGE_WORDS = 400;

/** Whether a resume of `words` words likely runs past one page. */
export const resumeLikelyLong = (words: number): boolean => words > RESUME_ONE_PAGE_WORDS;

/**
 * A file card's status line: "Drafted 2 hours ago · 290 words · 2 blanks". The newer of the
 * draft and the last edit names the time.
 */
export function fileStatusLabel({
  generatedAt,
  editedAt,
  words,
  blanks,
  now,
}: {
  generatedAt: string | null;
  editedAt: string | null;
  words: number;
  blanks: number;
  now: Date;
}): string {
  const edited = editedAt !== null && (generatedAt === null || editedAt >= generatedAt);
  const at = edited ? editedAt : generatedAt;
  const parts = [at === null ? "Written" : `${edited ? "Edited" : "Drafted"} ${agoLabel({ at: new Date(at), now })}`];
  parts.push(count(words, "word"));
  if (blanks > 0) parts.push(count(blanks, "blank"));
  return parts.join(" · ");
}

// ---------- exchange rates (decision 67) ----------

const FX_SOURCE_NAMES: Readonly<Record<FxRateBy, string>> = {
  ecb: "ECB",
  "currency-api": "currency-api",
  user: "Set by you",
};

/** Who a stored rate came from: "ECB", "currency-api" or "Set by you". */
export function fxProvenanceLabel(by: FxRateBy): string {
  return FX_SOURCE_NAMES[by];
}

// A rate date is a calendar day, so it is read and shown in UTC: "2026-10-16" is always 16 Oct.
const RATE_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "16 Oct" from "2026-10-16", in any time zone. */
export function rateDayLabel(rateDate: string): string {
  return RATE_DAY.format(new Date(`${rateDate}T00:00:00Z`));
}

export type FxAgeLine = {
  by: Exclude<FxRateBy, "user">;
  /** "ECB" or "currency-api". */
  source: string;
  /** ISO date, and "16 Oct". */
  rateDate: string;
  rateDay: string;
  /** ISO time, and "2 hours ago". */
  fetchedAt: string;
  fetchedAgo: string;
  /** The whole line: "ECB rates of 16 Oct · fetched 2 hours ago". */
  text: string;
};

/** "ECB rates of 16 Oct · fetched 2 hours ago". */
export function fxAgeLabel({
  by,
  rateDate,
  fetchedAt,
  now,
}: {
  by: Exclude<FxRateBy, "user">;
  rateDate: string;
  fetchedAt: Date;
  now: Date;
}): string {
  return `${FX_SOURCE_NAMES[by]} rates of ${rateDayLabel(rateDate)} · fetched ${agoLabel({ at: fetchedAt, now })}`;
}

/**
 * One age line per source that filled a stored rate, ECB first, from that source's newest fetch.
 * No lines when every rate was typed by the user.
 */
export function fxAgeLines({
  rates,
  now,
}: {
  rates: readonly { by: FxRateBy; setAt: string; rateDate: string | null }[];
  now: Date;
}): FxAgeLine[] {
  const lines: FxAgeLine[] = [];
  for (const by of ["ecb", "currency-api"] as const) {
    let newest: { setAt: string; rateDate: string } | null = null;
    for (const r of rates) {
      if (r.by !== by || r.rateDate === null) continue;
      if (newest === null || Date.parse(r.setAt) > Date.parse(newest.setAt)) {
        newest = { setAt: r.setAt, rateDate: r.rateDate };
      }
    }
    if (newest === null) continue;
    const fetchedAt = new Date(newest.setAt);
    lines.push({
      by,
      source: FX_SOURCE_NAMES[by],
      rateDate: newest.rateDate,
      rateDay: rateDayLabel(newest.rateDate),
      fetchedAt: newest.setAt,
      fetchedAgo: agoLabel({ at: fetchedAt, now }),
      text: fxAgeLabel({ by, rateDate: newest.rateDate, fetchedAt, now }),
    });
  }
  return lines;
}

/**
 * "Posted 12d ago" on a Board card, from the source's posting date. Without one it says when
 * the job was first found ("Found 3d ago"), so the card never claims a date it does not have.
 * Whole days; a date a little ahead of the clock counts as today.
 */
export function postedLabel({
  postedAt,
  firstSeenAt,
  now,
}: {
  postedAt: Date | null;
  firstSeenAt: Date;
  now: Date;
}): string {
  const verb = postedAt === null ? "Found" : "Posted";
  const days = wholeDays({ from: postedAt ?? firstSeenAt, now });
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  return `${verb} ${shortDays(days)} ago`;
}

/** Whole days from `from` to `now`; a time a little ahead of the clock counts as 0. */
function wholeDays({ from, now }: { from: Date; now: Date }): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/** "12d", "2mo", "3y": a day count short enough for a Board card. */
function shortDays(days: number): string {
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * How long a card has sat in its column: `short` on the card ("20d"), `long` for its tooltip and
 * screen readers ("for 20 days"), after the column name.
 */
export function inColumnLabel({ since, now }: { since: Date; now: Date }): { short: string; long: string } {
  const days = wholeDays({ from: since, now });
  if (days === 0) return { short: "Today", long: "since today" };
  return { short: shortDays(days), long: `for ${count(days, "day")}` };
}

/**
 * Where a Board card says the job hires: the eligibility verdict, short, when it is known; for an
 * unclear one, the posting's own location words; null when there is nothing to say.
 */
export function boardLocationLabel({
  eligibility,
  locationText,
}: {
  eligibility: Eligibility;
  locationText: string;
}): string | null {
  switch (eligibility) {
    case "ph":
      return "Open to PH";
    case "excluded":
      return "Excludes PH";
    case "worldwide":
    case "apac":
    case "americas":
      return eligibilityLabel(eligibility);
    case "unclear":
      return locationText.trim() || null;
    default: {
      const _exhaustive: never = eligibility;
      return _exhaustive;
    }
  }
}

/** "No jobs", "1 job", "1,204 jobs": the top bar's count of what Matches can show. */
export function jobCountLabel(n: number): string {
  if (n === 0) return "No jobs";
  return `${new Intl.NumberFormat("en-US").format(n)} ${n === 1 ? "job" : "jobs"}`;
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

const listOf = (codes: readonly string[]) => codes.join(", ");

/** The toast after Fill rates: what was filled, and what could not be. */
export function fillRatesSummary(fill: FillRatesResult): string {
  if (fill.viewChanged) return "Your view currency changed while filling, so nothing was saved. Fill again.";
  const parts: string[] = [];
  if (fill.filled.length > 0) parts.push(`Filled ${count(fill.filled.length, "rate")}.`);
  if (fill.unsupported.length > 0) parts.push(`No source publishes ${listOf(fill.unsupported)}.`);
  if (fill.unavailable.length > 0) parts.push(`Could not get ${listOf(fill.unavailable)}; try again later.`);
  return parts.length > 0 ? parts.join(" ") : "Every rate is already set.";
}

/** A percentage needs at least this many skills; below it the count says more (decision 76). */
export const SKILL_PERCENT_MIN = 3;

/**
 * How a job's skills read on Matches (decision 76). `short` is the list row: a percentage of the
 * required skills once there are enough of them, else the count. `full` is the exact count for the
 * reading pane, a tooltip and screen readers. Null when the posting names no skills we know.
 */
export function matchSkillsLabel(skills: MatchSkills): { short: string; full: string } | null {
  if (skills.asked === 0) return null;
  const { nice } = skills;
  const noun = nice.asked > 0 ? "required skills" : "skills";
  const count = `${skills.matched} of ${skills.asked} ${noun}`;
  const short =
    skills.asked >= SKILL_PERCENT_MIN ? `${Math.round((skills.matched / skills.asked) * 100)}% ${noun}` : count;
  const full = nice.asked > 0 ? `${count} · ${nice.matched} of ${nice.asked} nice-to-have` : count;
  return { short, full };
}
