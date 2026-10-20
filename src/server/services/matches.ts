import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { companyKey } from "@/domain/dedup";
import { skillsInFacts } from "@/domain/features";
import { levelRank, type MatchJob, type MatchProfile, matcher, payBelow } from "@/domain/match";
import { convert, type FxRates, monthlyInView, payFromColumns, toMonthly } from "@/domain/pay";
import { DESCRIPTION_HEAD_CHARS, roleFit } from "@/domain/roles";
import { customSkillNames, isBuiltinSkill, profileSkills } from "@/domain/user-skills";
import {
  type JobId,
  type MatchDetail,
  type MatchItem,
  type MatchList,
  type MatchQuery,
  MatchSourceGroup,
  type Money,
  type SourceId,
} from "@/shared/api";
import { isAtsKind, type JobOrigin, type RoleFamily, type SourceKind } from "@/shared/enums";
import { SOURCE_SITES } from "@/shared/labels";
import {
  eligibilityOverrides,
  facts,
  hiddenCompanies,
  jobListings,
  jobs,
  opportunities,
  sources,
  users,
} from "../db/schema";
import { AppError, type Deps, notFound } from "./context";
import { jobFacts } from "./jobs";
import { loadUserSkillRows } from "./user-skills";

/**
 * Matches (docs/ARCHITECTURE.md, "Match rules"; decision 44). The level and the "Role unclear" tag are computed
 * on every read from the job's stored features and the user's confirmed facts and targeting, so a
 * confirmed fact or a changed role family shows on the next request with nothing stored to update.
 */

/** Rows past this are not sent; the list is sorted first, so they are the weakest and oldest. */
export const MAX_MATCHES = 500;

type Targeting = {
  profile: MatchProfile;
  /** Job skills Matches knows: built-ins and the user's own current list, lowercased (decision 66). */
  knownSkill: (skill: string) => boolean;
  minPay: Money | null;
  families: readonly RoleFamily[];
  excludeWords: readonly string[];
  viewCurrency: string;
  rates: FxRates;
};

/** Everything a match reads about the user, loaded once per request. */
async function loadTargeting(deps: Pick<Deps, "db" | "userId">): Promise<Targeting> {
  const [[user], confirmed, skillRows] = await Promise.all([
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
    loadUserSkillRows(deps),
  ]);
  if (!user) throw notFound("Your profile");
  const custom = new Set(customSkillNames(skillRows).map((s) => s.toLowerCase()));
  return {
    knownSkill: (skill) => isBuiltinSkill(skill) || custom.has(skill.toLowerCase()),
    profile: {
      targetTitles: user.targetTitles,
      // Profile's "Skills used for matching": found in facts, plus added, minus hidden (decision 66).
      skills: profileSkills({ factSkills: skillsInFacts({ texts: confirmed.map((f) => f.text) }), rows: skillRows })
        .matching,
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

type Listing = { sourceId: SourceId; kind: SourceKind; label: string; listingUrl: string };

/** Every listing of the user's open jobs, primary first, so each job's source is known before the list is cut. */
async function listingsByJob(deps: Pick<Deps, "db" | "userId">) {
  const rows = await deps.db
    .select({
      jobId: jobListings.jobId,
      sourceId: sources.id,
      kind: sources.kind,
      label: sources.label,
      listingUrl: jobListings.listingUrl,
    })
    .from(jobListings)
    .innerJoin(sources, eq(sources.id, jobListings.sourceId))
    .innerJoin(jobs, eq(jobs.id, jobListings.jobId))
    .where(and(eq(jobListings.userId, deps.userId), isNull(jobs.closedAt)))
    .orderBy(desc(jobListings.isPrimary), asc(sources.label));
  const byJob = new Map<JobId, Listing[]>();
  for (const { jobId, ...listing } of rows) {
    const list = byJob.get(jobId) ?? [];
    list.push(listing);
    byJob.set(jobId, list);
  }
  return byJob;
}

const seenOnOf = (listings: readonly Listing[]): MatchItem["seenOn"] =>
  listings.map(({ kind, label, listingUrl }) => {
    const site = SOURCE_SITES[kind];
    return { label, listingUrl, via: site.attribution ? site.name : null };
  });

/** The Source filter's groups a job belongs to: a job seen on a board and a site is in both. */
function sourceGroupsOf(origin: JobOrigin, listings: readonly Listing[]): Set<MatchSourceGroup> {
  const groups = new Set<MatchSourceGroup>();
  if (origin !== "source") groups.add("added");
  for (const l of listings) groups.add(isAtsKind(l.kind) ? "boards" : "sites");
  return groups;
}

function inSource(source: MatchQuery["source"], groups: ReadonlySet<MatchSourceGroup>, listings: readonly Listing[]) {
  if (source === undefined) return true;
  const group = MatchSourceGroup.safeParse(source);
  if (group.success) return groups.has(group.data);
  return listings.some((l) => l.sourceId === source);
}

/** Tallies for the Company and Source filters' choices. */
class Facets {
  private readonly companies = new Map<string, { count: number; spellings: Map<string, number> }>();
  private readonly groups: Record<MatchSourceGroup, number> = { boards: 0, sites: 0, added: 0 };
  private readonly sites = new Map<SourceId, { label: string; count: number }>();

  constructor(private readonly hiddenKeys: ReadonlySet<string>) {}

  addCompany(key: string, name: string) {
    const entry = this.companies.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    entry.count++;
    entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
    this.companies.set(key, entry);
  }

  addSources(groups: ReadonlySet<MatchSourceGroup>, listings: readonly Listing[]) {
    for (const g of groups) this.groups[g]++;
    const seen = new Set<SourceId>();
    for (const l of listings) {
      if (isAtsKind(l.kind) || seen.has(l.sourceId)) continue;
      seen.add(l.sourceId);
      const site = this.sites.get(l.sourceId) ?? { label: l.label, count: 0 };
      site.count++;
      this.sites.set(l.sourceId, site);
    }
  }

  result(): MatchList["facets"] {
    const companies = [...this.companies].map(([key, { count, spellings }]) => ({
      key,
      // The most common spelling, then the first A to Z, so the name is stable between reads.
      name: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key,
      count,
      hidden: this.hiddenKeys.has(key),
    }));
    const sites = [...this.sites].map(([id, { label, count }]) => ({ id, label, count }));
    return {
      companies: companies.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      sources: {
        groups: { ...this.groups },
        sites: sites.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      },
    };
  }
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
  niceSkills: jobs.niceSkills,
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

/**
 * A stored job's skills may name a skill the user has since removed from their own list; removing
 * one takes it off stored jobs at once (decision 68), and this read-time filter is the safety net
 * (decision 66).
 */
function matchJobOf(
  t: Pick<Targeting, "knownSkill">,
  row: {
    title: string;
    skills: string[];
    niceSkills: string[];
    seniority: MatchJob["seniority"];
    minYears: number | null;
  } & Pick<MatchJob, "eligibility">,
  unclear: { reason: string } | null,
  overridden: boolean,
): MatchJob {
  return {
    title: row.title,
    skills: row.skills.filter(t.knownSkill),
    niceSkills: row.niceSkills.filter(t.knownSkill),
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
  const picked = new Set((query.company ?? []).map(companyKey));
  const [t, rows, listings, hidden] = await Promise.all([
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
    listingsByJob(deps),
    listHiddenCompanies(deps),
  ]);

  const score = matcher(t.profile);
  const payFilter = payFilterOf(t, query.payAtLeast);
  const hiddenKeys = new Set(hidden.map((h) => h.key));
  const facets = new Facets(hiddenKeys);
  const counts = {
    open: rows.length,
    excluded: 0,
    excludedOpen: 0,
    unsure: 0,
    belowPay: 0,
    search: 0,
    hiddenCompany: 0,
    picked: 0,
  };
  const shown: (MatchItem & { rank: number; coverage: number; skillsMatched: number; seenAt: number })[] = [];
  for (const row of rows) {
    // The Company and Source filters: the summary counts only jobs inside them, so "12 excluded"
    // under a picked company means 12 of that company's jobs.
    const key = companyKey(row.company);
    const jobListings = listings.get(row.id) ?? [];
    const groups = sourceGroupsOf(row.origin, jobListings);
    const companyOk = picked.size === 0 || picked.has(key);
    const sourceOk = inSource(query.source, groups, jobListings);
    const inPick = companyOk && sourceOk;
    const hiddenOut = hiddenKeys.has(key) && !picked.has(key);
    if (!inPick) counts.picked++;

    const excluded = row.eligibility === "excluded" && !row.overridden;
    if (excluded && inPick) counts.excludedOpen++;
    if (!row.hit) {
      if (inPick) counts.search++;
      continue;
    }
    if (excluded && query.excluded !== true) {
      if (inPick) counts.excluded++;
      continue;
    }
    const unclear = roleUnclear(t, row);
    if (unclear && query.unsure === false) {
      if (inPick) counts.unsure++;
      continue;
    }
    const pay = payFromColumns(row);
    if (
      payFilter.atLeast !== null &&
      payBelow({ pay, atLeast: payFilter.atLeast, viewCurrency: t.viewCurrency, rates: t.rates })
    ) {
      if (inPick) counts.belowPay++;
      continue;
    }
    // Each filter's choices are counted with the other filter on, so a count is what picking it shows.
    if (sourceOk) facets.addCompany(key, row.company);
    if (companyOk && !hiddenOut) facets.addSources(groups, jobListings);
    if (!inPick) continue;
    if (hiddenOut) {
      counts.hiddenCompany++;
      continue;
    }
    const match = score(matchJobOf(t, row, unclear, row.overridden));
    shown.push({
      companyKey: key,
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
  return {
    jobs: page.map(({ rank: _rank, coverage: _coverage, skillsMatched: _skillsMatched, seenAt: _seenAt, ...item }) => ({
      ...item,
      seenOn: seenOnOf(listings.get(item.id) ?? []),
    })),
    counts,
    facets: facets.result(),
    hiddenCompanies: hidden,
    viewCurrency: t.viewCurrency,
    payFilter,
  };
}

// ---------- Hidden companies ----------

async function listHiddenCompanies(deps: Pick<Deps, "db" | "userId">): Promise<MatchList["hiddenCompanies"]> {
  const rows = await deps.db
    .select({ key: hiddenCompanies.companyKey, name: hiddenCompanies.name })
    .from(hiddenCompanies)
    .where(eq(hiddenCompanies.userId, deps.userId));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Hide every job from this company in Matches. Hiding it again keeps the first spelling. */
export async function hideCompany(deps: Pick<Deps, "db" | "userId">, company: string) {
  const key = companyKey(company);
  if (key === "") throw new AppError({ code: "invalid_input", message: "That company name has no letters or digits." });
  await deps.db
    .insert(hiddenCompanies)
    .values({ userId: deps.userId, companyKey: key, name: company.trim() })
    .onConflictDoNothing();
  return listHiddenCompanies(deps);
}

/** Show the company's jobs in Matches again. Showing one that is not hidden does nothing. */
export async function showCompany(deps: Pick<Deps, "db" | "userId">, company: string) {
  await deps.db
    .delete(hiddenCompanies)
    .where(and(eq(hiddenCompanies.userId, deps.userId), eq(hiddenCompanies.companyKey, companyKey(company))));
  return listHiddenCompanies(deps);
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
  const match = matcher(t.profile)(matchJobOf(t, job, unclear, row.overridden));
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    description: job.description,
    applyUrl: job.applyUrl,
    seenOn: listings.get(job.id) ?? [],
    level: match.level,
    reasons: match.reasons,
    skills: match.skills,
    roleUnclear: unclear?.reason ?? null,
    facts: await jobFacts(deps, job),
    opportunityId: row.opportunityId,
  };
}
