import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type LocalScan, localAddon, type ScannedLocal, scanLocal } from "@/domain/local-scan";
import { githubUserFor } from "@/domain/project-role";
import { type OwnedRepo, type RepoScan, repoAddon, repoKey, type ScannedRepo, scanRepos } from "@/domain/repo-scan";
import type { AddProjectsInput, ProfileDto, ProjectScanDto, ScannedFolderDto, ScannedRepoDto } from "@/shared/api";
import { profileItems } from "../db/schema";
import { AppError, type Deps } from "./context";
import { linkedRepos, listOwned, NO_READS, planReads, queueReads, readEstimateUsd } from "./github";
import { getProfile, loadContact, saveAddons } from "./profile";

/**
 * "Find my projects" (decision 78): the user's GitHub repos through gh, and the folders in
 * `HB_PROJECTS_DIR`, split by rules into shown and hidden. Nothing is saved by a scan. A local
 * clone of a listed repo shows once, under GitHub, and its commits keep the repo out of "nearly
 * empty". One source failing doesn't hide the other.
 */

type Scanned = {
  github: { status: "ok"; user: string; scan: RepoScan } | { status: "error"; message: string } | null;
  local: { status: "ok"; dir: string; scan: LocalScan } | { status: "error"; message: string } | null;
};

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

async function scanAll(deps: Deps): Promise<Scanned> {
  const [owned, linked, titles, contact] = await Promise.all([
    deps.github.list
      ? listOwned(deps).then(
          (r): { status: "ok"; user: string; repos: OwnedRepo[] } => ({ status: "ok", ...r }),
          failed,
        )
      : null,
    linkedRepos(deps),
    unlinkedTitles(deps),
    loadContact(deps),
  ]);

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
      ? { status: "ok", user: owned.user, scan: scanRepos({ user: owned.user, repos: owned.repos, linked, clones }) }
      : owned;
  return { github, local };
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

function needsSource(deps: Deps): void {
  if (!deps.github.list && !deps.projects) {
    throw new AppError({
      code: "needs_input",
      message:
        "Finding your projects needs a source. Set HB_GITHUB=gh with HB_GITHUB_USER, or HB_PROJECTS_DIR, then restart the app.",
    });
  }
}

export async function scanProjects(deps: Deps): Promise<ProjectScanDto> {
  needsSource(deps);
  const { github, local } = await scanAll(deps);
  return {
    github:
      github?.status === "ok"
        ? {
            status: "ok",
            user: github.user,
            shown: github.scan.shown.map(repoDto),
            hidden: github.scan.hidden.map(repoDto),
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
  needsSource(deps);
  const { github, local } = await scanAll(deps);
  const repos = input.repos ?? [];
  const folders = input.folders ?? [];
  for (const [source, asked] of [
    [github, repos.length],
    [local, folders.length],
  ] as const) {
    if (asked > 0 && source?.status === "error") throw new AppError({ code: "needs_input", message: source.message });
  }

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
  if (pickedRepos.length + pickedFolders.length === 0) {
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
  return getProfile(deps);
}
