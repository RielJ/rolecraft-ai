import { type Eligibility, MATCH_LEVELS, type MatchLevel, type UserSeniority } from "@/shared/enums";
import { titleKey } from "./dedup";
import { type JobSeniority, seniority as titleSeniority } from "./features";
import { convert, type FxRates, type Pay, toMonthly } from "./pay";

/**
 * Match rules (docs/ARCHITECTURE.md, "Match rules"). The level is computed on read from the job's stored
 * features and the user's confirmed facts and preferences, so it never goes stale.
 */

export type { MatchLevel, UserSeniority };
export type ReasonSign = "positive" | "negative" | "neutral";
export type Reason = { sign: ReasonSign; text: string };
export type Match = {
  level: MatchLevel;
  reasons: Reason[];
  /**
   * How many of the posting's required skills your confirmed facts name (decision 76), and of its
   * nice-to-have skills. The required ones decide the level and order jobs within it. A posting
   * with no nice-to-have text, or none outside it, counts all its skills as one list:
   * `nice.asked` is 0.
   */
  skills: { matched: number; asked: number; nice: { matched: number; asked: number } };
};

/** What the user brings: target titles, skills found in confirmed fact text, seniority and years. */
export type MatchProfile = {
  targetTitles: readonly string[];
  skills: readonly string[];
  seniority: UserSeniority | null;
  years: number | null;
};

/** The job's stored features, plus the role filter's verdict computed on read (section 3.7a). */
export type MatchJob = {
  title: string;
  skills: readonly string[];
  /** The `skills` named only in the posting's nice-to-have text (decision 76). */
  niceSkills: readonly string[];
  seniority: JobSeniority | null;
  minYears: number | null;
  eligibility: Eligibility;
  /**
   * The user moved this excluded job to Matches (decision 53). The verdict still stands as the
   * rules read it, but it no longer makes the job Weak; it caps the level at Possible instead.
   */
  eligibilityOverridden?: boolean;
  /** Set when the role filter says "unsure" for this job; it caps the level at Possible. */
  roleUnclear: { reason: string } | null;
};

/** Thresholds from section 3.7. */
export const TITLE_FIT = 0.6;
export const TITLE_PARTIAL = 0.3;
export const STRONG_COVERAGE = 0.6;
export const WEAK_COVERAGE = 0.3;
/** Weak by coverage needs at least this many job skills, so a two-skill posting is not judged on one miss. */
export const WEAK_MIN_JOB_SKILLS = 3;
/** Reasons name at most this many matched and this many missing skills. */
export const MAX_SKILLS_NAMED = 5;

const LADDER: readonly JobSeniority[] = ["intern", "junior", "mid", "senior", "lead", "staff", "principal"];

// Rank words are dropped from both titles before comparing, so "Senior Frontend Engineer"
// fits a target of "Frontend Engineer". Manager words are roles, not ranks, and stay.
const RANK_WORDS: ReadonlySet<string> = new Set([
  "intern",
  "internship",
  "trainee",
  "ojt",
  "junior",
  "jnr",
  "jr",
  "entry",
  "level",
  "graduate",
  "associate",
  "mid",
  "intermediate",
  "ii",
  "iii",
  "senior",
  "sr",
  "snr",
  "lead",
  "staff",
  "principal",
  "distinguished",
]);

/** Joined words a title may spell either way. "Full-stack" already splits on its hyphen. */
const TITLE_COMPOUNDS: Readonly<Record<string, readonly string[]>> = {
  fullstack: ["full", "stack"],
  frontend: ["front", "end"],
  backend: ["back", "end"],
};

/** Role words that mean the same job for title fit. */
const TITLE_ROLE_WORDS: Readonly<Record<string, string>> = { developer: "engineer", programmer: "engineer" };

/** Where a title's role ends and its tail (team, location, stack) starts: " - ", " | ", " — ", " – " or "(". */
const TITLE_TAIL = /\s[-|—–]\s|\(/;

function wordsOf(title: string): ReadonlySet<string> {
  return new Set(
    titleKey(title)
      .split(" ")
      .flatMap((t) => TITLE_COMPOUNDS[t] ?? [t])
      .map((t) => TITLE_ROLE_WORDS[t] ?? t)
      .filter((t) => t !== "" && !RANK_WORDS.has(t)),
  );
}

/**
 * The words title fit compares (section 3.7). Only matching reads these: `titleKey`, which dedup
 * uses, keeps the title's own words. A tail is cut when at least two words come before it.
 */
function titleTokens(title: string): ReadonlySet<string> {
  const tail = title.search(TITLE_TAIL);
  if (tail > 0) {
    const head = wordsOf(title.slice(0, tail));
    if (head.size >= 2) return head;
  }
  return wordsOf(title);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const LEVEL_WORD: Readonly<Record<JobSeniority, string>> = {
  intern: "Intern",
  junior: "Junior",
  mid: "Mid-level",
  senior: "Senior",
  lead: "Lead",
  staff: "Staff",
  principal: "Principal",
  manager: "Manager",
};

function named(skills: readonly string[]): string {
  const shown = skills.slice(0, MAX_SKILLS_NAMED).join(", ");
  const more = skills.length - MAX_SKILLS_NAMED;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

type Prepared = {
  targets: readonly { title: string; tokens: ReadonlySet<string> }[];
  skills: ReadonlySet<string>;
  targetsManager: boolean;
  seniority: UserSeniority | null;
  years: number | null;
};

function prepare(profile: MatchProfile): Prepared {
  const targets = profile.targetTitles
    .map((title) => ({ title, tokens: titleTokens(title) }))
    .filter((t) => t.tokens.size > 0);
  return {
    targets,
    skills: new Set(profile.skills.map((s) => s.toLowerCase())),
    targetsManager: profile.targetTitles.some((t) => titleSeniority(t) === "manager"),
    seniority: profile.seniority,
    years: profile.years,
  };
}

type TitleResult = { fit: "fit" | "partial" | "none"; reason: Reason } | { fit: "unscored"; reason: Reason };

function titleFit(p: Prepared, title: string): TitleResult {
  if (p.targets.length === 0) {
    return {
      fit: "unscored",
      reason: { sign: "neutral", text: "No target titles in your profile, so the title is not scored" },
    };
  }
  const job = titleTokens(title);
  let best = { score: 0, title: "" };
  for (const target of p.targets) {
    const score = jaccard(job, target.tokens);
    if (score > best.score) best = { score, title: target.title };
  }
  if (best.score >= TITLE_FIT) {
    return { fit: "fit", reason: { sign: "positive", text: `Title fits your target “${best.title}”` } };
  }
  if (best.score >= TITLE_PARTIAL) {
    return { fit: "partial", reason: { sign: "positive", text: `Title is close to your target “${best.title}”` } };
  }
  return { fit: "none", reason: { sign: "negative", text: "Title is not close to any of your target titles" } };
}

function seniorityReason(p: Prepared, job: MatchJob): Reason | null {
  if (job.seniority === "manager") {
    return p.targetsManager
      ? null
      : { sign: "negative", text: "Manager role, and none of your target titles is a manager role" };
  }
  if (job.seniority === null || p.seniority === null) return null;
  const gap = LADDER.indexOf(job.seniority) - LADDER.indexOf(p.seniority);
  if (Math.abs(gap) < 2) return null;
  const yours = LEVEL_WORD[p.seniority].toLowerCase();
  return {
    sign: "negative",
    text: `${LEVEL_WORD[job.seniority]} role, and you are ${yours}: ${gap > 0 ? "above" : "below"} your level`,
  };
}

function yearsReason(p: Prepared, job: MatchJob): Reason | null {
  if (job.minYears === null || p.years === null || job.minYears <= p.years + 1) return null;
  const unit = p.years === 1 ? "year" : "years";
  return { sign: "negative", text: `Asks for ${job.minYears}+ years of experience; you have ${p.years} ${unit}` };
}

function eligibilityReason(
  eligibility: Eligibility,
  overridden: boolean,
): { reason: Reason; cap: boolean; weak: boolean } {
  switch (eligibility) {
    case "ph":
      return { reason: { sign: "positive", text: "Open to the Philippines" }, cap: false, weak: false };
    case "worldwide":
      return { reason: { sign: "positive", text: "Hires worldwide" }, cap: false, weak: false };
    case "apac":
      return { reason: { sign: "positive", text: "Hires in APAC" }, cap: false, weak: false };
    case "americas":
      return {
        reason: { sign: "negative", text: "Hires in the Americas, so it is Possible at best" },
        cap: true,
        weak: false,
      };
    case "unclear":
      return {
        reason: { sign: "negative", text: "Does not say where it hires, so it is Possible at best" },
        cap: true,
        weak: false,
      };
    case "excluded":
      return overridden
        ? {
            reason: {
              sign: "negative",
              text: "The posting limits where it hires, and you moved it to Matches, so it is Possible at best",
            },
            cap: true,
            weak: false,
          }
        : { reason: { sign: "negative", text: "Does not hire from the Philippines" }, cap: false, weak: true };
    default: {
      const _exhaustive: never = eligibility;
      return _exhaustive;
    }
  }
}

function score(p: Prepared, job: MatchJob): Match {
  const reasons: Reason[] = [];

  const title = titleFit(p, job.title);
  reasons.push(title.reason);

  // Required skills decide; nice-to-have ones only inform. With no required skill left, all count.
  const isNice = new Set(job.niceSkills);
  const split = job.skills.some((s) => !isNice.has(s));
  const required = split ? job.skills.filter((s) => !isNice.has(s)) : job.skills;
  const nice = split ? job.skills.filter((s) => isNice.has(s)) : [];
  const have = (s: string) => p.skills.has(s.toLowerCase());
  const matched = required.filter(have);
  const missing = required.filter((s) => !have(s));
  const niceMatched = nice.filter(have);
  const niceMissing = nice.filter((s) => !have(s));
  const coverage = matched.length / Math.max(1, required.length);
  if (job.skills.length === 0) reasons.push({ sign: "neutral", text: "The posting names no skills we know" });
  if (matched.length > 0) reasons.push({ sign: "positive", text: `In your facts: ${named(matched)}` });
  if (missing.length > 0) reasons.push({ sign: "negative", text: `Not in your facts: ${named(missing)}` });
  if (niceMatched.length > 0) {
    reasons.push({ sign: "positive", text: `Nice to have, in your facts: ${named(niceMatched)}` });
  }
  if (niceMissing.length > 0) {
    reasons.push({ sign: "neutral", text: `Nice to have, not in your facts: ${named(niceMissing)}` });
  }

  const seniority = seniorityReason(p, job);
  if (seniority) reasons.push(seniority);
  const years = yearsReason(p, job);
  if (years) reasons.push(years);

  const eligibility = eligibilityReason(job.eligibility, job.eligibilityOverridden === true);
  reasons.push(eligibility.reason);
  if (job.roleUnclear) {
    reasons.push({ sign: "negative", text: `Role unclear (${job.roleUnclear.reason}), so it is Possible at best` });
  }

  const weak =
    title.fit === "none" || (coverage < WEAK_COVERAGE && required.length >= WEAK_MIN_JOB_SKILLS) || eligibility.weak;
  const strong =
    (title.fit === "fit" || title.fit === "partial") &&
    coverage >= STRONG_COVERAGE &&
    seniority === null &&
    years === null &&
    !eligibility.cap &&
    job.roleUnclear === null;
  return {
    level: weak ? "weak" : strong ? "strong" : "possible",
    reasons,
    skills: {
      matched: matched.length,
      asked: required.length,
      nice: { matched: niceMatched.length, asked: nice.length },
    },
  };
}

/** A scorer for one profile, so target titles are tokenized once for a whole list of jobs. */
export function matcher(profile: MatchProfile): (job: MatchJob) => Match {
  const prepared = prepare(profile);
  return (job) => score(prepared, job);
}

/** Section 3.7: Strong, Possible or Weak, with a signed reason for each rule that spoke. */
export function matchJob({ job, profile }: { job: MatchJob; profile: MatchProfile }): Match {
  return matcher(profile)(job);
}

/** Sort key: Strong first. */
export function levelRank(level: MatchLevel): number {
  return MATCH_LEVELS.indexOf(level);
}

/**
 * The Matches pay filter (section 3.7, decision 20): true only when the job's pay, made monthly in
 * the view currency, is under `atLeast`. The top of a range counts, so a range that reaches the
 * filter stays. No pay, no period or no rate for the currency is never hidden.
 */
export function payBelow({
  pay,
  atLeast,
  viewCurrency,
  rates,
}: {
  pay: Omit<Pay, "phrase"> | null;
  atLeast: number;
  viewCurrency: string;
  rates: FxRates;
}): boolean {
  if (pay === null || pay.period === null) return false;
  const top = toMonthly({ amount: pay.max ?? pay.min, period: pay.period });
  const inView = convert({ amount: top, currency: pay.currency, viewCurrency, rates });
  return inView !== null && inView < atLeast;
}
