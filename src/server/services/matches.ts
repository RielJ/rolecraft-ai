import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { skillsInFacts } from "@/domain/features";
import { levelRank, type MatchJob, type MatchProfile, matcher, payBelow } from "@/domain/match";
import { convert, type FxRates, monthlyInView, payFromColumns, toMonthly } from "@/domain/pay";
import { DESCRIPTION_HEAD_CHARS, roleFit } from "@/domain/roles";
import type { JobId, MatchDetail, MatchItem, MatchList, MatchQuery, Money } from "@/shared/api";
import type { RoleFamily } from "@/shared/enums";
import { SOURCE_SITES } from "@/shared/labels";
import { eligibilityOverrides, facts, jobListings, jobs, opportunities, sources, users } from "../db/schema";
import { type Deps, notFound } from "./context";
import { jobFacts } from "./jobs";

/**
 * Matches (PLAN.md sections 3.7, 3.7a and 4). The level and the "Role unclear" tag are computed
 * on every read from the job's stored features and the user's confirmed facts and targeting, so a
 * confirmed fact or a changed role family shows on the next request with nothing stored to update.
 */

/** Rows past this are not sent; the list is sorted first, so they are the weakest and oldest. */
export const MAX_MATCHES = 500;

type Targeting = {
  profile: MatchProfile;
  minPay: Money | null;
  families: readonly RoleFamily[];
  excludeWords: readonly string[];
  viewCurrency: string;
  rates: FxRates;
};

/** Everything a match reads about the user, loaded once per request. */
async function loadTargeting(deps: Pick<Deps, "db" | "userId">): Promise<Targeting> {
  const [[user], confirmed] = await Promise.all([
    deps.db
      .select({
        targetTitles: users.targetTitles,
        roleFamilies: users.roleFamilies,
        excludeTitleWords: users.excludeTitleWords,
        seniority: users.seniority,
        years: users.yearsExperience,
        viewCurrency: users.viewCurrency,
        fxRates: users.fxRates,
        minPay: users.minPay,
      })
      .from(users)
      .where(eq(users.id, deps.userId)),
    deps.db
      .select({ text: facts.text })
      .from(facts)
      .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed"))),
  ]);
  if (!user) throw notFound("Your profile");
  return {
    profile: {
      targetTitles: user.targetTitles,
      // The same list Profile shows as "Skills found in your confirmed facts" (decision 9).
      skills: skillsInFacts({ texts: confirmed.map((f) => f.text) }),
      seniority: user.seniority,
      years: user.years,
    },
    minPay: user.minPay,
    families: user.roleFamilies,
    excludeWords: user.excludeTitleWords,
    viewCurrency: user.viewCurrency,
    rates: Object.fromEntries(Object.entries(user.fxRates).map(([code, e]) => [code, e.rate])),
  };
}

/**
 * The role filter on read (section 3.7a). Sync already dropped the sure misses, so a job that
 * reads as "drop" now (a family unpicked since, or a new exclude word) is kept and tagged with the
 * reason rather than hidden: when in doubt, keep. Pasted and linked jobs skip the filter.
 */
function roleUnclear(
  t: Targeting,
  job: { origin: string; title: string; descriptionHead: string },
): { reason: string } | null {
  if (job.origin !== "source") return null;
  const fit = roleFit({
    title: job.title,
    tags: [],
    description: job.descriptionHead,
    families: t.families,
    excludeWords: t.excludeWords,
  });
  return fit.fit === "keep" ? null : { reason: fit.reason };
}

async function seenOn(deps: Pick<Deps, "db">, ids: readonly JobId[]) {
  if (ids.length === 0) return new Map<JobId, MatchItem["seenOn"]>();
  const rows = await deps.db
    .select({ jobId: jobListings.jobId, kind: sources.kind, label: sources.label, listingUrl: jobListings.listingUrl })
    .from(jobListings)
    .innerJoin(sources, eq(sources.id, jobListings.sourceId))
    .where(inArray(jobListings.jobId, [...ids]))
    .orderBy(desc(jobListings.isPrimary), asc(sources.label));
  const byJob = new Map<JobId, MatchItem["seenOn"]>();
  for (const { jobId, kind, label, listingUrl } of rows) {
    const list = byJob.get(jobId) ?? [];
    const site = SOURCE_SITES[kind];
    list.push({ label, listingUrl, via: site.attribution ? site.name : null });
    byJob.set(jobId, list);
  }
  return byJob;
}

const MATCH_COLUMNS = {
  id: jobs.id,
  origin: jobs.origin,
  title: jobs.title,
  company: jobs.company,
  locationText: jobs.locationText,
  firstSeenAt: jobs.firstSeenAt,
  applyUrl: jobs.applyUrl,
  skills: jobs.skills,
  seniority: jobs.seniority,
  minYears: jobs.minYears,
  eligibility: jobs.eligibility,
  payMin: jobs.payMin,
  payMax: jobs.payMax,
  payCurrency: jobs.payCurrency,
  payPeriod: jobs.payPeriod,
  payPhrase: jobs.payPhrase,
  descriptionHead: sql<string>`left(${jobs.description}, ${DESCRIPTION_HEAD_CHARS})`,
};

function matchJobOf(
  row: { title: string; skills: string[]; seniority: MatchJob["seniority"]; minYears: number | null } & Pick<
    MatchJob,
    "eligibility"
  >,
  unclear: { reason: string } | null,
  overridden: boolean,
): MatchJob {
  return {
    title: row.title,
    skills: row.skills,
    seniority: row.seniority,
    minYears: row.minYears,
    eligibility: row.eligibility,
    eligibilityOverridden: overridden,
    roleUnclear: unclear,
  };
}

/** The user moved this job to Matches from Filtered out (decision 53): it is no longer hidden as excluded. */
const overriddenColumn = sql<boolean>`${eligibilityOverrides.jobId} IS NOT NULL`;

/**
 * The pay filter in force. The page's value wins; without one, the minimum pay saved on Profile
 * applies, made monthly in the view currency and rounded. A saved minimum in a currency with no
 * rate cannot be compared, so it filters nothing (decision 20).
 */
function payFilterOf(t: Targeting, payAtLeast: number | undefined): MatchList["payFilter"] {
  if (payAtLeast !== undefined) return { atLeast: payAtLeast > 0 ? payAtLeast : null, from: "page", missingRate: null };
  if (t.minPay === null) return { atLeast: null, from: null, missingRate: null };
  const monthly = convert({
    amount: toMonthly({ amount: t.minPay.amount, period: t.minPay.period }),
    currency: t.minPay.currency,
    viewCurrency: t.viewCurrency,
    rates: t.rates,
  });
  return monthly === null
    ? { atLeast: null, from: null, missingRate: t.minPay.currency }
    : { atLeast: Math.round(monthly), from: "profile", missingRate: null };
}

/**
 * The Matches inbox: open jobs not yet saved or dismissed, Strong first. With a search, full-text
 * hits are ranked within each level; without one, newest first. Excluded jobs show only when
 * asked for, unsure ones unless asked not to, and the pay filter never hides a job it cannot
 * convert.
 */
export async function listMatches(deps: Pick<Deps, "db" | "userId">, query: MatchQuery = {}): Promise<MatchList> {
  const q = query.q?.trim() ?? "";
  const tsQuery = sql`websearch_to_tsquery('english', ${q})`;
  const [t, rows] = await Promise.all([
    loadTargeting(deps),
    deps.db
      .select({
        ...MATCH_COLUMNS,
        hit: q === "" ? sql<boolean>`true` : sql<boolean>`${jobs.search} @@ ${tsQuery}`,
        rank: q === "" ? sql<number>`0` : sql<number>`ts_rank(${jobs.search}, ${tsQuery})`,
        overridden: overriddenColumn,
      })
      .from(jobs)
      .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
      .leftJoin(eligibilityOverrides, eq(eligibilityOverrides.jobId, jobs.id))
      .where(and(eq(jobs.userId, deps.userId), isNull(jobs.closedAt), isNull(opportunities.id))),
  ]);

  const score = matcher(t.profile);
  const payFilter = payFilterOf(t, query.payAtLeast);
  const counts = { open: rows.length, excluded: 0, excludedOpen: 0, unsure: 0, belowPay: 0, search: 0 };
  const shown: (MatchItem & { rank: number; coverage: number; skillsMatched: number; seenAt: number })[] = [];
  for (const row of rows) {
    const excluded = row.eligibility === "excluded" && !row.overridden;
    if (excluded) counts.excludedOpen++;
    if (!row.hit) {
      counts.search++;
      continue;
    }
    if (excluded && query.excluded !== true) {
      counts.excluded++;
      continue;
    }
    const unclear = roleUnclear(t, row);
    if (unclear && query.unsure === false) {
      counts.unsure++;
      continue;
    }
    const pay = payFromColumns(row);
    if (
      payFilter.atLeast !== null &&
      payBelow({ pay, atLeast: payFilter.atLeast, viewCurrency: t.viewCurrency, rates: t.rates })
    ) {
      counts.belowPay++;
      continue;
    }
    const match = score(matchJobOf(row, unclear, row.overridden));
    shown.push({
      id: row.id,
      title: row.title,
      company: row.company,
      locationText: row.locationText,
      firstSeenAt: row.firstSeenAt.toISOString(),
      applyUrl: row.applyUrl,
      seenOn: [],
      level: match.level,
      roleUnclear: unclear?.reason ?? null,
      eligibility: row.eligibility,
      skills: match.skills,
      pay:
        pay === null
          ? null
          : (monthlyInView({ pay, viewCurrency: t.viewCurrency, rates: t.rates }) ?? row.payPhrase ?? null),
      rank: Number(row.rank),
      coverage: match.skills.asked ? match.skills.matched / match.skills.asked : 0,
      skillsMatched: match.skills.matched,
      seenAt: row.firstSeenAt.getTime(),
    });
  }

  shown.sort(
    (a, b) =>
      levelRank(a.level) - levelRank(b.level) ||
      b.rank - a.rank ||
      // Within a level, the jobs your skills cover best come first.
      b.coverage - a.coverage ||
      b.skillsMatched - a.skillsMatched ||
      b.seenAt - a.seenAt ||
      a.title.localeCompare(b.title),
  );
  const page = shown.slice(0, MAX_MATCHES);
  const listings = await seenOn(
    deps,
    page.map((j) => j.id),
  );
  return {
    jobs: page.map(({ rank: _rank, coverage: _coverage, skillsMatched: _skillsMatched, seenAt: _seenAt, ...item }) => ({
      ...item,
      seenOn: listings.get(item.id) ?? [],
    })),
    counts,
    viewCurrency: t.viewCurrency,
    payFilter,
  };
}

/** The reading pane for one job: its facts, match level and every reason. */
export async function matchDetail(deps: Deps, jobId: JobId): Promise<MatchDetail> {
  const [[row], t, listings] = await Promise.all([
    deps.db
      .select({ job: jobs, opportunityId: opportunities.id, overridden: overriddenColumn })
      .from(jobs)
      .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
      .leftJoin(eligibilityOverrides, eq(eligibilityOverrides.jobId, jobs.id))
      .where(and(eq(jobs.userId, deps.userId), eq(jobs.id, jobId))),
    loadTargeting(deps),
    seenOn(deps, [jobId]),
  ]);
  if (!row) throw notFound("That job");
  const { job } = row;
  const unclear = roleUnclear(t, {
    origin: job.origin,
    title: job.title,
    descriptionHead: job.description.slice(0, DESCRIPTION_HEAD_CHARS),
  });
  const match = matcher(t.profile)(matchJobOf(job, unclear, row.overridden));
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    description: job.description,
    applyUrl: job.applyUrl,
    seenOn: listings.get(job.id) ?? [],
    level: match.level,
    reasons: match.reasons,
    roleUnclear: unclear?.reason ?? null,
    facts: await jobFacts(deps, job),
    opportunityId: row.opportunityId,
  };
}
