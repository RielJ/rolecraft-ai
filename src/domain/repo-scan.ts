import type { GithubRepoRef } from "@/shared/github-link";

/**
 * Finding the user's own GitHub repos (decision 78). Rules only, no AI: forks, the profile README
 * repo and near-empty repos go to a collapsed "hidden by rules" group, each with its reason; the
 * user can still pick them. Both groups are ordered by last push, and repos an add-on already
 * links are marked. A local clone with the user's commits (local-scan.ts) keeps a repo out of
 * "small": GitHub's size can lag what was built.
 *
 * Decision 86 adds commit counts: a counted repo with few of the user's commits, or mostly other
 * people's, is hidden too, and counted repos are ordered by the user's commits. Stale repos are
 * flagged, never hidden. Merged pull requests in other people's repos group into contributions.
 */

/** One repo the account owns, as the listing reports it. */
export type OwnedRepo = {
  owner: string;
  name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  /** GitHub's `size`, in KB. */
  sizeKb: number;
  language: string | null;
  stars: number;
  /** ISO 8601, or null for a repo never pushed to. */
  pushedAt: string | null;
  description: string | null;
};

/** Repos under this size hold a README and little else. */
export const MIN_REPO_KB = 5;

/** Fewer commits by the user than this, and a local repo is hidden as "few commits". */
export const MIN_OWN_COMMITS = 5;

/** Why the rules hid a repo. */
export type RepoHideReason = "fork" | "profile" | "small" | "few_commits" | "others";

/** A repo with no push for this many months is flagged as stale. */
export const STALE_MONTHS = 18;

/** Without gh, at most this many repos are counted in one scan. */
export const COUNT_CAP = 30;

/** Calls kept back from counting, for reads and fills later in the hour. */
export const COUNT_RESERVE = 10;

/** The user's commits and everyone's, on the default branch. */
export type CommitCounts = { own: number; total: number };

/** Why a shown or hidden repo may look abandoned to a reader. */
export type Staleness = "archived" | "old";

/** What a local clone adds to a listed GitHub repo. */
export type CloneInfo = { ownCommits: number; summary: string | null };

export type ScannedRepo = OwnedRepo & {
  added: boolean;
  hiddenBy: RepoHideReason | null;
  /** The user's commits in a local clone, or null without one. */
  localCommits: number | null;
  /** The clone's README paragraph, used when GitHub has no description. */
  localSummary: string | null;
  /** The user's commits on GitHub, or null when not counted. */
  ownCommits: number | null;
  /** Every account's commits on GitHub, or null when not counted. */
  totalCommits: number | null;
  stale: Staleness | null;
};

export type RepoScan = { shown: ScannedRepo[]; hidden: ScannedRepo[] };

/** owner/repo in lower case, the key repos are compared by. */
export const repoKey = ({ owner, repo }: GithubRepoRef) => `${owner}/${repo}`.toLowerCase();

const isProfile = (repo: OwnedRepo, user: string) => repo.name.toLowerCase() === user.toLowerCase();

/** Why a repo is hidden, or null when it is shown. A repo gets its first reason only. */
function hiddenBy({
  repo,
  user,
  clone,
  counts,
}: {
  repo: OwnedRepo;
  user: string;
  clone: CloneInfo | undefined;
  counts: CommitCounts | undefined;
}): RepoHideReason | null {
  if (repo.fork) return "fork";
  if (isProfile(repo, user)) return "profile";
  const local = clone?.ownCommits ?? 0;
  if (repo.sizeKb < MIN_REPO_KB && local < MIN_OWN_COMMITS) return "small";
  if (!counts) return null;
  // A local clone can hold commits GitHub's default branch doesn't.
  if (Math.max(counts.own, local) < MIN_OWN_COMMITS) return "few_commits";
  if (counts.own * 2 < counts.total) return "others";
  return null;
}

/** "archived", "old" after STALE_MONTHS without a push, else null. */
export function staleness({ repo, now }: { repo: Pick<OwnedRepo, "archived" | "pushedAt">; now: Date }) {
  if (repo.archived) return "archived";
  if (!repo.pushedAt) return null;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - STALE_MONTHS);
  return new Date(repo.pushedAt) < cutoff ? "old" : null;
}

/** Newest push first, then more stars, then name. A repo never pushed to goes last. */
function byActivity(a: OwnedRepo, b: OwnedRepo): number {
  const pushed = (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
  return pushed || b.stars - a.stars || a.name.localeCompare(b.name);
}

/**
 * Counted repos first, by the user's commits, then size, then last push. Uncounted ones follow, by
 * last push. Stars never change the order: they measure popularity, not the user's work.
 */
function byWork(a: ScannedRepo, b: ScannedRepo): number {
  if (a.ownCommits === null || b.ownCommits === null) {
    if (a.ownCommits !== b.ownCommits) return a.ownCommits === null ? 1 : -1;
    return byActivity(a, b);
  }
  const pushed = (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
  return b.ownCommits - a.ownCommits || b.sizeKb - a.sizeKb || pushed || a.name.localeCompare(b.name);
}

/** Every listed repo, split into shown and hidden by rules, each group ordered and marked. */
export function scanRepos({
  user,
  repos,
  linked,
  clones = new Map(),
  counts = new Map(),
  now,
}: {
  /** The account the repos were listed for. */
  user: string;
  repos: readonly OwnedRepo[];
  /** Repos that add-ons already link. */
  linked: readonly GithubRepoRef[];
  /** By `repoKey`: local clones of listed repos, from the local scan. */
  clones?: ReadonlyMap<string, CloneInfo>;
  /** By `repoKey`: commit counts for the repos that were counted. */
  counts?: ReadonlyMap<string, CommitCounts>;
  /** For staleness. */
  now: Date;
}): RepoScan {
  const taken = new Set(linked.map(repoKey));
  const all = repos
    .map((repo): ScannedRepo => {
      const key = repoKey({ owner: repo.owner, repo: repo.name });
      const clone = clones.get(key);
      const counted = counts.get(key);
      return {
        ...repo,
        added: taken.has(key),
        hiddenBy: hiddenBy({ repo, user, clone, counts: counted }),
        localCommits: clone?.ownCommits ?? null,
        localSummary: clone?.summary ?? null,
        ownCommits: counted?.own ?? null,
        totalCommits: counted?.total ?? null,
        stale: staleness({ repo, now }),
      };
    })
    .toSorted(byWork);
  return { shown: all.filter((r) => r.hiddenBy === null), hidden: all.filter((r) => r.hiddenBy !== null) };
}

/**
 * The add-on a picked repo becomes: its name, link, main language and description (or, without
 * one, its local clone's README paragraph).
 */
export function repoAddon(
  repo: Pick<OwnedRepo, "owner" | "name" | "description" | "language"> & { localSummary?: string | null },
): {
  title: string;
  body: string;
  link: string;
  skills: string[];
} {
  const description = repo.description?.trim() || repo.localSummary?.trim() || "";
  const fallback = repo.language
    ? `${repo.name}, a ${repo.language} repository on GitHub.`
    : `${repo.name}, a repository on GitHub.`;
  return {
    title: repo.name,
    body: description || fallback,
    link: `https://github.com/${repo.owner}/${repo.name}`,
    skills: repo.language ? [repo.language] : [],
  };
}

/**
 * Which repos to count commits for, within the calls left this hour. Forks and the profile repo
 * come last, then newest push first. `remaining: null` means no limit applies (gh).
 */
export function countPlan({
  repos,
  user,
  remaining,
}: {
  repos: readonly OwnedRepo[];
  user: string;
  remaining: number | null;
}): OwnedRepo[] {
  const order = repos.toSorted((a, b) => {
    const late = (r: OwnedRepo) => (r.fork || isProfile(r, user) ? 1 : 0);
    return late(a) - late(b) || byActivity(a, b);
  });
  if (remaining === null) return order;
  return order.slice(0, Math.max(0, Math.min(COUNT_CAP, remaining - COUNT_RESERVE)));
}

/** One merged pull request in someone else's repo, as the search reports it. */
export type MergedPull = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** ISO 8601. */
  mergedAt: string;
};

/** Every merged pull request of the user's in one repo they don't own. */
export type Contribution = {
  owner: string;
  name: string;
  /** Newest merge first. */
  pulls: { number: number; title: string; mergedAt: string }[];
  added: boolean;
};

/**
 * Merged pull requests grouped into one row per repo: most pulls first, then the newest merge. A
 * repo the user owns is never a contribution.
 */
export function groupContributions({
  pulls,
  user,
  linked,
}: {
  pulls: readonly MergedPull[];
  user: string;
  linked: readonly GithubRepoRef[];
}): Contribution[] {
  const taken = new Set(linked.map(repoKey));
  const rows = new Map<string, Contribution>();
  for (const pull of pulls) {
    if (pull.owner.toLowerCase() === user.toLowerCase()) continue;
    const key = repoKey(pull);
    const row = rows.get(key) ?? { owner: pull.owner, name: pull.repo, pulls: [], added: taken.has(key) };
    if (!row.pulls.some((p) => p.number === pull.number))
      row.pulls.push({ number: pull.number, title: pull.title, mergedAt: pull.mergedAt });
    rows.set(key, row);
  }
  const newest = (c: Contribution) => c.pulls[0]?.mergedAt ?? "";
  return [...rows.values()]
    .map((c) => ({ ...c, pulls: c.pulls.toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt)) }))
    .toSorted(
      (a, b) =>
        b.pulls.length - a.pulls.length ||
        newest(b).localeCompare(newest(a)) ||
        repoKey({ owner: a.owner, repo: a.name }).localeCompare(repoKey({ owner: b.owner, repo: b.name })),
    );
}

/** At most this many pull request titles go into a contribution's text. */
export const CONTRIBUTION_TITLES = 3;

/**
 * The add-on a picked contribution becomes: the repo's name and link, and the titles of its merged
 * pull requests. The link's owner isn't the user, so its role is "contribution" (decision 82).
 */
export function contributionAddon(c: Pick<Contribution, "owner" | "name" | "pulls">): {
  title: string;
  body: string;
  link: string;
  skills: string[];
} {
  const titles = c.pulls.slice(0, CONTRIBUTION_TITLES).map((p) => p.title.trim().replace(/\.$/, ""));
  const more = c.pulls.length - titles.length;
  const tail = more > 0 ? `, and ${more} more` : "";
  const label = c.pulls.length === 1 ? "Merged pull request" : "Merged pull requests";
  return {
    title: c.name,
    body: `${label} in ${c.owner}/${c.name}: ${titles.join("; ")}${tail}.`,
    link: `https://github.com/${c.owner}/${c.name}`,
    skills: [],
  };
}

/** A pull request that changed fewer lines than this is tiny: a typo or one-line fix. */
export const TINY_PULL_LINES = 10;

/** A contribution is tiny when every checked pull request is. No pulls checked is not tiny. */
export const isTinyContribution = (lines: readonly number[]) =>
  lines.length > 0 && lines.every((n) => n < TINY_PULL_LINES);
