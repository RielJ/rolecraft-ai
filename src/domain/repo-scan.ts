import type { GithubRepoRef } from "./github-link";

/**
 * Finding the user's own GitHub repos (decision 78). Rules only, no AI: forks, the profile README
 * repo and near-empty repos go to a collapsed "hidden by rules" group, each with its reason; the
 * user can still pick them. Both groups are ordered by last push, and repos an add-on already
 * links are marked.
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

/** Why the rules hid a repo. */
export type RepoHideReason = "fork" | "profile" | "small";

export type ScannedRepo = OwnedRepo & { added: boolean; hiddenBy: RepoHideReason | null };

export type RepoScan = { shown: ScannedRepo[]; hidden: ScannedRepo[] };

const key = ({ owner, repo }: GithubRepoRef) => `${owner}/${repo}`.toLowerCase();

/** Why a repo is hidden, or null when it is shown. A repo gets its first reason only. */
function hiddenBy({ repo, user }: { repo: OwnedRepo; user: string }): RepoHideReason | null {
  if (repo.fork) return "fork";
  if (repo.name.toLowerCase() === user.toLowerCase()) return "profile";
  if (repo.sizeKb < MIN_REPO_KB) return "small";
  return null;
}

/** Newest push first, then more stars, then name. A repo never pushed to goes last. */
function byActivity(a: OwnedRepo, b: OwnedRepo): number {
  const pushed = (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
  return pushed || b.stars - a.stars || a.name.localeCompare(b.name);
}

/** Every listed repo, split into shown and hidden by rules, each group ordered and marked. */
export function scanRepos({
  user,
  repos,
  linked,
}: {
  /** The account the repos were listed for. */
  user: string;
  repos: readonly OwnedRepo[];
  /** Repos that add-ons already link. */
  linked: readonly GithubRepoRef[];
}): RepoScan {
  const taken = new Set(linked.map(key));
  const all = repos
    .map(
      (repo): ScannedRepo => ({
        ...repo,
        added: taken.has(key({ owner: repo.owner, repo: repo.name })),
        hiddenBy: hiddenBy({ repo, user }),
      }),
    )
    .toSorted(byActivity);
  return { shown: all.filter((r) => r.hiddenBy === null), hidden: all.filter((r) => r.hiddenBy !== null) };
}

/** The add-on a picked repo becomes: its name, link, main language and description. */
export function repoAddon(repo: OwnedRepo): { title: string; body: string; link: string; skills: string[] } {
  const description = repo.description?.trim() ?? "";
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
