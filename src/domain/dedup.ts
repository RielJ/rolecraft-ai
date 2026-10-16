import { normalize, sentencesOf, tokens } from "./text";

const TITLE_SYNONYMS: Readonly<Record<string, string>> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  jnr: "junior",
};

/** Lowercased, parentheticals and punctuation dropped, sr -> senior, tokens sorted. */
export function titleKey(title: string): string {
  const withoutParens = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  return tokens(withoutParens)
    .map((t) => TITLE_SYNONYMS[t] ?? t)
    .sort()
    .join(" ");
}

const COMPANY_SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co"]);

/** Lowercased, punctuation and trailing legal suffixes (Inc, LLC, Ltd, Corp, Co) dropped. */
export function companyKey(company: string): string {
  const parts = tokens(company);
  while (parts.length > 1 && COMPANY_SUFFIXES.has(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(" ");
}

const TRACKING_PARAM = /^(utm_.*|ref|referrer|source)$/i;

/** Host lowercased, utm_* and ref params dropped, hash dropped, no trailing slash. Null if not http(s). */
export function applyUrlKey(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`;
}

// ---------- exact-match merge (decision 46) ----------

/** Same company, title and description count as one posting only within this many days. */
export const AUTO_MERGE_DAYS = 28;
const DAY_MS = 86_400_000;

export type MergeKeys = {
  titleKey: string;
  companyKey: string;
  applyUrlKey: string | null;
  descriptionKey: string;
  /** `posted_at`, or `first_seen_at` when the posting gave no date. */
  seenAt: Date;
};

/**
 * Two postings are the same posting (decision 46): the same apply URL and title, or the same
 * company, title and description within 28 days. Same company and title alone never merges.
 */
export function isAutoMerge({ a, b }: { a: MergeKeys; b: MergeKeys }): boolean {
  if (a.titleKey !== b.titleKey) return false;
  if (a.applyUrlKey !== null && a.applyUrlKey === b.applyUrlKey) return true;
  return (
    a.companyKey === b.companyKey &&
    a.descriptionKey === b.descriptionKey &&
    Math.abs(a.seenAt.getTime() - b.seenAt.getTime()) <= AUTO_MERGE_DAYS * DAY_MS
  );
}

// ---------- likely duplicates the user merges (section 3.8) ----------

export type DuplicateCandidate = {
  id: string;
  titleKey: string;
  companyKey: string;
  description: string;
  locationText: string;
  payPhrase: string | null;
  skills: readonly string[];
  minYears: number | null;
  closedAt: Date | null;
};

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

const SHINGLE = 3;

/** Word 3-shingles of the normalized description. */
function shingles(text: string): Set<string> {
  const words = tokens(text);
  const out = new Set<string>();
  if (words.length < SHINGLE) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(" "));
  return out;
}

const TITLE_JACCARD = 0.5;
const DESCRIPTION_JACCARD = 0.8;

/**
 * Open jobs that may be the same as `job` (section 3.8): the same company with title token
 * Jaccard ≥ 0.5, or the same title with description shingle Jaccard ≥ 0.8. The job itself is
 * left out; postings that already auto-merged are one job row, so they never pair up here.
 */
export function likelyDuplicates<C extends DuplicateCandidate>({
  job,
  candidates,
}: {
  job: DuplicateCandidate;
  candidates: readonly C[];
}): C[] {
  const titleTokens = new Set(job.titleKey.split(" ").filter(Boolean));
  let jobShingles: Set<string> | null = null;
  return candidates.filter((c) => {
    if (c.id === job.id || c.closedAt !== null) return false;
    if (c.companyKey === job.companyKey) {
      const other = new Set(c.titleKey.split(" ").filter(Boolean));
      if (jaccard(titleTokens, other) >= TITLE_JACCARD) return true;
    }
    if (c.titleKey === job.titleKey) {
      jobShingles ??= shingles(job.description);
      return jaccard(jobShingles, shingles(c.description)) >= DESCRIPTION_JACCARD;
    }
    return false;
  });
}

/** One line per job naming what sets it apart: requirements, location or pay. */
export type DuplicateDiff = { job: string; other: string };

function requirements(self: DuplicateCandidate, other: DuplicateCandidate): string | null {
  const otherSkills = new Set(other.skills.map((s) => s.toLowerCase()));
  const own = self.skills.filter((s) => !otherSkills.has(s.toLowerCase())).slice(0, 5);
  const parts: string[] = [];
  if (self.minYears !== other.minYears && self.minYears !== null) parts.push(`${self.minYears}+ years`);
  if (own.length) parts.push(own.join(", "));
  if (parts.length) return `Asks for ${parts.join(", ")}`;
  return self.minYears !== other.minYears || other.skills.length > self.skills.length ? "Asks for less" : null;
}

/** The first sentence of `self` that `other` lacks, cut to 100 characters. */
function firstOwnSentence(self: string, other: string): string | null {
  const theirs = new Set(sentencesOf(other).map((s) => normalize(s)));
  const own = sentencesOf(self).find((s) => !theirs.has(normalize(s)));
  if (own === undefined) return null;
  return own.length > 100 ? `${own.slice(0, 99).trimEnd()}…` : own;
}

/**
 * The two-line diff the duplicate hint shows (section 3.8): for each job, the requirements,
 * location and pay that differ. When none of those differ, the first sentence each has that the
 * other lacks. Lines read "Same requirements, location and pay" when nothing differs.
 */
export function duplicateDiff({ job, other }: { job: DuplicateCandidate; other: DuplicateCandidate }): DuplicateDiff {
  const line = (self: DuplicateCandidate, them: DuplicateCandidate): string => {
    const parts: string[] = [];
    const req = requirements(self, them);
    if (req) parts.push(req);
    if (normalize(self.locationText) !== normalize(them.locationText)) {
      parts.push(self.locationText.trim() || "No location stated");
    }
    if (normalize(self.payPhrase ?? "") !== normalize(them.payPhrase ?? "")) {
      parts.push(self.payPhrase ?? "Pay not stated");
    }
    if (parts.length) return parts.join(" · ");
    return firstOwnSentence(self.description, them.description) ?? "Same requirements, location and pay";
  };
  return { job: line(job, other), other: line(other, job) };
}
