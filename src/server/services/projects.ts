import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type LocalScan, localAddon, type ScannedLocal, scanLocal } from "@/domain/local-scan";
import { githubUserFor, scanAccount } from "@/domain/project-role";
import {
  type CommitCounts,
  type Contribution,
  contributionAddon,
  countPlan,
  groupContributions,
  isTinyContribution,
  type OwnedRepo,
  type RepoScan,
  repoAddon,
  repoKey,
  type ScannedRepo,
  scanRepos,
} from "@/domain/repo-scan";
import type {
  AddProjectsInput,
  ContributionDto,
  ContributionSizeDto,
  ProfileDto,
  ProjectScanDto,
  ScannedFolderDto,
  ScannedRepoDto,
} from "@/shared/api";
import { profileLogin } from "@/shared/github-link";
import { GithubError } from "../adapters/github";
import { profileItems, users } from "../db/schema";
import { AppError, type Deps } from "./context";
import { githubAppError, linkedRepos, listOwned, NO_READS, planReads, queueReads, readEstimateUsd } from "./github";
import { getProfile, loadContact, saveAddons } from "./profile";

/**
 * "Find my projects" (decision 78): the user's GitHub repos through gh, and the folders in
 * `HB_PROJECTS_DIR`, split by rules into shown and hidden. Nothing is saved by a scan. A local
 * clone of a listed repo shows once, under GitHub, and its commits keep the repo out of "nearly
 * empty". One source failing doesn't hide the other.
 *
 * Decision 86: without gh, a pasted profile (or the contact links' one) is listed through the
 * public API; commits are counted per repo within the hour's call budget; and one search finds
 * merged pull requests in other people's public repos.
 */

type Failed = { status: "error"; message: string };

type GithubScan = {
  status: "ok";
  user: string;
  /** False when the account came from a pasted profile no setting names: Add saves it. */
  known: boolean;
  scan: RepoScan;
  counted: number;
  countNote: string | null;
  contributions: { status: "ok"; rows: Contribution[] } | Failed;
};

type Scanned = {
  github: GithubScan | Failed | null;
  local: { status: "ok"; dir: string; scan: LocalScan } | Failed | null;
};

/** Counting runs this many calls at once. */
const COUNT_CONCURRENCY = 6;

const failed = (err: unknown) => {
  if (err instanceof AppError) return { status: "error" as const, message: err.message };
  throw err;
};

/** Add-ons without a link, by title: a folder added before matches its own name. */
async function unlinkedTitles(deps: Pick<Deps, "db" | "userId">): Promise<string[]> {
  const rows = await deps.db
    .select({ title: profileItems.title, link: profileItems.link })
    .from(profileItems)
    .where(eq(profileItems.userId, deps.userId));
  return rows.flatMap(({ title, link }) => (link || !title ? [] : [title]));
}

/** The account to scan, refused when a pasted profile isn't the user's. */
function accountFor(deps: Deps, { links, profile }: { links: readonly string[]; profile: string | undefined }) {
  const asked = profile === undefined ? null : profileLogin(profile);
  if (profile !== undefined && asked === null) {
    return { status: "refused" as const, message: `"${profile}" isn't a GitHub login or profile link.` };
  }
  return scanAccount({ gh: deps.github.mode === "gh", configured: deps.github.user, links, asked });
}

async function softGithub<T>(run: () => Promise<T>): Promise<T | GithubError> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GithubError) return err;
    throw err;
  }
}

/**
 * Commit counts for as many repos as the hour's budget allows (decision 86). A repo GitHub can't
 * count yet is skipped; running out of calls stops the rest.
 */
async function countCommits(deps: Deps, { user, repos }: { user: string; repos: readonly OwnedRepo[] }) {
  const budget = await softGithub(() => deps.github.rateBudget());
  const remaining = budget instanceof GithubError ? 0 : budget;
  const queue = countPlan({ repos, user, remaining });
  const counts = new Map<string, CommitCounts>();
  let limited = false;
  const worker = async () => {
    for (let repo = queue.shift(); repo && !limited; repo = queue.shift()) {
      const got = await softGithub(() => deps.github.commitCounts({ owner: repo.owner, repo: repo.name, user }));
      if (got instanceof GithubError) {
        if (got.kind === "rate_limited") limited = true;
        continue;
      }
      if (got) counts.set(repoKey({ owner: repo.owner, repo: repo.name }), got);
    }
  };
  await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, worker));
  const countNote =
    counts.size === repos.length
      ? null
      : `Counted commits for ${counts.size} of ${repos.length} repos. ${
          remaining === null
            ? "GitHub hadn't finished counting the rest. Scan again in a minute."
            : "GitHub allows 60 calls an hour without sign-in; set HB_GITHUB=gh to count every repo."
        }`;
  return { counts, countNote };
}

async function findContributions(
  deps: Deps,
  { user, linked }: { user: string; linked: Parameters<typeof groupContributions>[0]["linked"] },
): Promise<GithubScan["contributions"]> {
  const pulls = await softGithub(() => deps.github.mergedPulls({ user }));
  if (pulls instanceof GithubError) return { status: "error", message: githubAppError(pulls).message };
  return { status: "ok", rows: groupContributions({ pulls, user, linked }) };
}

async function scanGithub(
  deps: Deps,
  {
    links,
    profile,
    linked,
    count,
    contributions,
  }: {
    links: readonly string[];
    profile: string | undefined;
    linked: Awaited<ReturnType<typeof linkedRepos>>;
    count: boolean;
    contributions: boolean;
  },
) {
  const account = accountFor(deps, { links, profile });
  if (!account) return null;
  if (account.status === "refused") return { status: "error" as const, message: account.message };
  const { user, known } = account;
  try {
    const repos = await listOwned(deps, user);
    const [{ counts, countNote }, found] = await Promise.all([
      count ? countCommits(deps, { user, repos }) : { counts: new Map<string, CommitCounts>(), countNote: null },
      contributions
        ? findContributions(deps, { user, linked })
        : Promise.resolve({ status: "ok" as const, rows: [] as Contribution[] }),
    ]);
    return { status: "ok" as const, user, known, repos, counts, countNote, contributions: found };
  } catch (err) {
    return failed(err);
  }
}

async function scanAll(
  deps: Deps,
  {
    profile,
    count = true,
    contributions = true,
  }: { profile?: string | undefined; count?: boolean; contributions?: boolean } = {},
): Promise<Scanned> {
  const [linked, titles, contact] = await Promise.all([linkedRepos(deps), unlinkedTitles(deps), loadContact(deps)]);
  const owned = await scanGithub(deps, { links: contact.contact.links, profile, linked, count, contributions });

  let local: Scanned["local"] = null;
  const projects = deps.projects;
  if (projects) {
    try {
      const { folders, emails } = await projects.list();
      const githubUser =
        owned?.status === "ok"
          ? owned.user
          : (githubUserFor({ configured: deps.github.user, links: contact.contact.links })?.user ?? null);
      const listed =
        owned?.status === "ok" ? new Set(owned.repos.map((r) => repoKey({ owner: r.owner, repo: r.name }))) : null;
      local = {
        status: "ok",
        dir: projects.dir,
        scan: scanLocal({ folders, emails, githubUser, listed, linked, titles }),
      };
    } catch (err) {
      local = { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const clones = local?.status === "ok" ? local.scan.clones : new Map();
  const github: Scanned["github"] =
    owned?.status === "ok"
      ? {
          status: "ok",
          user: owned.user,
          known: owned.known,
          scan: scanRepos({
            user: owned.user,
            repos: owned.repos,
            linked,
            clones,
            counts: owned.counts,
            now: deps.clock.now(),
          }),
          counted: owned.counts.size,
          countNote: owned.countNote,
          contributions: owned.contributions,
        }
      : owned;
  return { github, local };
}

function contributionDto(c: Contribution): ContributionDto {
  return { repo: `${c.owner}/${c.name}`, url: contributionAddon(c).link, pulls: c.pulls, added: c.added };
}

function repoDto(repo: ScannedRepo): ScannedRepoDto {
  return {
    name: repo.name,
    url: repoAddon(repo).link,
    private: repo.private,
    archived: repo.archived,
    language: repo.language,
    stars: repo.stars,
    pushedAt: repo.pushedAt,
    description: repo.description ?? repo.localSummary,
    added: repo.added,
    hiddenBy: repo.hiddenBy,
    localCommits: repo.localCommits,
    sizeKb: repo.sizeKb,
    ownCommits: repo.ownCommits,
    totalCommits: repo.totalCommits,
    stale: repo.stale,
  };
}

function folderDto(repo: ScannedLocal): ScannedFolderDto {
  return {
    folder: repo.folder,
    url: localAddon(repo).link,
    remoteOwner: repo.remoteOwner,
    languages: repo.languages,
    lastCommitAt: repo.lastCommitAt,
    ownCommits: repo.ownCommits,
    totalCommits: repo.totalCommits,
    summary: repo.summary,
    added: repo.added,
    hiddenBy: repo.hiddenBy,
  };
}

export async function scanProjects(deps: Deps, input: { profile?: string | undefined } = {}): Promise<ProjectScanDto> {
  const { github, local } = await scanAll(deps, { profile: input.profile });
  return {
    githubMode: deps.github.mode,
    github:
      github?.status === "ok"
        ? {
            status: "ok",
            user: github.user,
            shown: github.scan.shown.map(repoDto),
            hidden: github.scan.hidden.map(repoDto),
            counted: github.counted,
            countNote: github.countNote,
            contributions:
              github.contributions.status === "ok"
                ? { status: "ok", rows: github.contributions.rows.map(contributionDto) }
                : github.contributions,
          }
        : github,
    local:
      local?.status === "ok"
        ? {
            status: "ok",
            dir: local.dir,
            shown: local.scan.shown.map(folderDto),
            hidden: local.scan.hidden.map(folderDto),
            onGithub: local.scan.onGithub,
          }
        : local,
    readEstimateUsd: await readEstimateUsd(deps),
  };
}

/**
 * Add picked repos and folders as `open_source` add-ons. Both sources are scanned again and only
 * names found there are added, so text and links come from GitHub and the folders, never from the
 * request. Names already added are skipped. A source the request needs that fails is an error.
 */
export async function addProjects(deps: Deps, input: AddProjectsInput): Promise<ProfileDto> {
  const repos = input.repos ?? [];
  const folders = input.folders ?? [];
  const contributions = input.contributions ?? [];
  // Counts aren't fetched again, so the hour's calls are kept for reads (decision 86).
  const { github, local } = await scanAll(deps, {
    profile: input.profile,
    count: false,
    contributions: contributions.length > 0,
  });
  for (const [source, asked] of [
    [github, repos.length + contributions.length],
    [local, folders.length],
  ] as const) {
    if (asked > 0 && source?.status === "error") throw new AppError({ code: "needs_input", message: source.message });
    if (asked > 0 && !source) {
      throw new AppError({
        code: "needs_input",
        message:
          "Add your GitHub profile link to your contact links, or paste your profile in Find my projects, then scan again.",
      });
    }
  }
  const found = github?.status === "ok" && github.contributions.status === "ok" ? github.contributions.rows : [];
  if (contributions.length > 0 && github?.status === "ok" && github.contributions.status === "error") {
    throw new AppError({ code: "needs_input", message: github.contributions.message });
  }
  const wantedContributions = new Set(contributions.map((n) => n.toLowerCase()));
  const pickedContributions = found.filter(
    (c) => wantedContributions.has(`${c.owner}/${c.name}`.toLowerCase()) && !c.added,
  );

  const wantedRepos = new Set(repos.map((n) => n.toLowerCase()));
  const pickedRepos =
    github?.status === "ok"
      ? [...github.scan.shown, ...github.scan.hidden].filter((r) => wantedRepos.has(r.name.toLowerCase()) && !r.added)
      : [];
  const wantedFolders = new Set(folders);
  const pickedFolders =
    local?.status === "ok"
      ? [...local.scan.shown, ...local.scan.hidden].filter((r) => wantedFolders.has(r.folder) && !r.added)
      : [];
  if (pickedRepos.length + pickedFolders.length + pickedContributions.length === 0) {
    throw new AppError({
      code: "needs_input",
      message: "None of those projects can be added: they are already add-ons, or they are no longer there.",
    });
  }
  // A git folder keeps its path, so it can be read for facts (decision 81).
  const dir = deps.projects?.dir ?? null;
  const folderPath = async (repo: (typeof pickedFolders)[number]) =>
    dir && repo.hiddenBy !== "not_git" ? deps.folders.resolve(join(dir, repo.folder)).catch(() => null) : null;
  const folderAddons = await Promise.all(
    pickedFolders.map(async (repo) => ({
      kind: "open_source" as const,
      ...localAddon(repo),
      folder: await folderPath(repo),
    })),
  );
  // Repos are read from GitHub, folders with git; a folder that isn't a git repo is only split.
  const sources: ("github" | "folder" | null)[] = [
    ...pickedRepos.map(() => "github" as const),
    ...pickedContributions.map(() => "github" as const),
    ...folderAddons.map((a) => (a.folder ? ("folder" as const) : null)),
  ];
  const plan = input.read
    ? await planReads(deps, {
        github: sources.filter((s) => s === "github").length,
        folder: sources.filter((s) => s === "folder").length,
      })
    : NO_READS;
  const ids = await saveAddons(deps, {
    addons: [
      ...pickedRepos.map((repo) => ({ kind: "open_source" as const, ...repoAddon(repo), githubPrivate: repo.private })),
      // The search only finds public repos.
      ...pickedContributions.map((c) => ({
        kind: "open_source" as const,
        ...contributionAddon(c),
        githubPrivate: false,
      })),
      ...folderAddons,
    ],
    confirmOverCap: input.confirmOverCap ?? false,
    extraUsd: plan.estimateUsd,
  });
  if (input.read) {
    const items = ids.flatMap((itemId, i) => {
      const source = sources[i];
      return source ? [{ itemId, source }] : [];
    });
    await queueReads(deps, { items, plan });
  }
  if (github?.status === "ok" && !github.known) await saveProfileLink(deps, github.user);
  return getProfile(deps);
}

/**
 * A pasted profile becomes a contact link once something from it is added, so later reads know
 * which commits are the user's (decision 81). Only when no link names an account yet.
 */
async function saveProfileLink(deps: Deps, user: string): Promise<void> {
  const { contact } = await loadContact(deps);
  if (githubUserFor({ configured: null, links: contact.links })) return;
  await deps.db
    .update(users)
    .set({ links: [...contact.links, `https://github.com/${user}`] })
    .where(eq(users.id, deps.userId));
}

/**
 * The changed lines of a contribution's newest merged pull requests, at most 3, so the dialog can
 * ask before a typo fix is added (decision 86). Costs up to 4 calls, only when the user picks one.
 */
export async function contributionSize(
  deps: Deps,
  input: { repo: string; profile?: string | undefined },
): Promise<ContributionSizeDto> {
  const { contact } = await loadContact(deps);
  const account = accountFor(deps, { links: contact.links, profile: input.profile });
  if (!account || account.status === "refused") {
    throw new AppError({ code: "needs_input", message: account?.message ?? "Paste your GitHub profile first." });
  }
  const [owner = "", name = ""] = input.repo.split("/");
  try {
    const pulls = (await deps.github.mergedPulls({ user: account.user }))
      .filter((p) => p.owner.toLowerCase() === owner.toLowerCase() && p.repo.toLowerCase() === name.toLowerCase())
      .toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt))
      .slice(0, 3);
    const lines = await Promise.all(
      pulls.map((p) => deps.github.pullLines({ owner: p.owner, repo: p.repo, number: p.number })),
    );
    return { lines, tiny: isTinyContribution(lines) };
  } catch (err) {
    if (err instanceof GithubError) throw githubAppError(err);
    throw err;
  }
}
