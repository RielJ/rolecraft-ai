import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { GithubRepoRef } from "@/domain/github-link";
import type { FolderBundle } from "@/domain/github-read";
import { type LocalFolder, parseGithubRemote } from "@/domain/local-scan";
import type { CommitSource } from "@/domain/project-read";
import { type FolderReadInput, gitCommitSource, readFolderProject } from "./folder-read";
import { createGit, type GitSpawn } from "./git";

/**
 * Reads the folders in `HB_PROJECTS_DIR`, one level deep (decision 78). Only for a server running
 * on the user's own machine (`bun run dev`); Docker leaves it unset and the option is hidden.
 *
 * Git runs through `Bun.spawn` with an argv array and no shell. It only reads: `git log` for the
 * author emails and the newest commit date, and `git config --get remote.origin.url`. Neither reads
 * the index, and `core.fsmonitor` is forced off, so a cloned repo's config can't make the scan run
 * a program. Symlinked folders and files are skipped, so the scan never leaves the folder. Apart
 * from git, the only file read is the README, capped at 64 KB.
 */

/** Reads one folder: its git history, remote, root files and README. */
export type FolderReader = {
  /** `path` absolute or starting with `~`, with symlinks resolved. Throws when it isn't a folder. */
  resolve(path: string): Promise<string>;
  /** Reads the folder `resolve` names. */
  read(path: string): Promise<LocalFolder>;
  /** The user's commit emails: git's global `user.email` and `HB_GIT_EMAILS`, lower case. */
  emails(): Promise<string[]>;
  /** Read a resolved folder for facts (decision 81). Throws `FolderReadError` when it can't. */
  deep(input: FolderReadInput): Promise<FolderBundle>;
  /** A clone's commits and hunks for a GitHub read (decision 81). */
  commits(input: Omit<Parameters<typeof gitCommitSource>[1], "head">): CommitSource;
  /** `remote.origin.url` of a folder with commits; null for anything else. */
  remote(path: string): Promise<string | null>;
};

export type ProjectsReader = {
  /** The folder scanned, as configured. */
  readonly dir: string;
  list(): Promise<{ folders: LocalFolder[]; emails: string[] }>;
  /** The folder whose origin is `ref` on GitHub, with symlinks resolved; null when none is. */
  findClone(ref: GithubRepoRef): Promise<string | null>;
};

/** At most this many folders are read; the rest are ignored. */
export const MAX_FOLDERS = 200;
/** Commits counted per repo, newest first. */
const MAX_COMMITS = 5000;
const README_BYTES = 64 * 1024;
const README = /^readme(\.(md|markdown|txt|rst))?$/i;
const CONCURRENCY = 6;

export type FolderReaderOptions = {
  /** `HB_GIT_EMAILS`: older or other addresses the user commits with. */
  extraEmails?: readonly string[];
  git?: string;
  spawn?: GitSpawn;
  /** Add `git config --global user.email` to the user's emails. Tests turn it off. */
  readConfigEmail?: boolean;
};

/** `~` and `~/x` to the home folder, then an absolute path; null for a relative one. */
export function expandPath(raw: string): string | null {
  const path = raw.trim();
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

export function createFolderReader({
  extraEmails = [],
  git: gitBinary,
  spawn,
  readConfigEmail = true,
}: FolderReaderOptions = {}): FolderReader {
  const git = createGit({ ...(gitBinary ? { git: gitBinary } : {}), ...(spawn ? { spawn } : {}) });
  const run = (args: string[]) => git.run(args);
  const repoGit = (path: string, args: string[]) => git.repo(path, args);

  async function readGit(path: string): Promise<LocalFolder["git"]> {
    const [log, remote] = await Promise.all([
      repoGit(path, ["log", `--max-count=${MAX_COMMITS}`, "--format=%ae%x09%cI", "HEAD", "--"]),
      repoGit(path, ["config", "--get", "remote.origin.url"]),
    ]);
    const authors: Record<string, number> = {};
    let lastCommitAt: string | null = null;
    // A repo with no commits fails `git log`; it is still a repo, with nothing in it.
    if (log.exit === 0) {
      for (const line of log.stdout.split("\n")) {
        const [email, date] = line.split("\t");
        if (!email || !date) continue;
        lastCommitAt ??= date;
        const key = email.toLowerCase();
        authors[key] = (authors[key] ?? 0) + 1;
      }
    }
    return { authors, lastCommitAt, remote: remote.exit === 0 ? remote.stdout.trim() || null : null };
  }

  async function readFolder(path: string): Promise<LocalFolder> {
    const folder = basename(path);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const rootFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    const hasGit = entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isFile()));
    const readmeName = rootFiles.filter((name) => README.test(name)).sort()[0];
    const readme = readmeName ? await Bun.file(join(path, readmeName)).slice(0, README_BYTES).text() : null;
    return { folder, git: hasGit ? await readGit(path) : null, rootFiles, readme };
  }

  async function configEmails(): Promise<string[]> {
    if (!readConfigEmail) return [];
    const { exit, stdout } = await run(["config", "--global", "--get-all", "user.email"]);
    return exit === 0
      ? stdout
          .split("\n")
          .map((e) => e.trim())
          .filter(Boolean)
      : [];
  }

  async function resolveFolder(raw: string): Promise<string> {
    const expanded = expandPath(raw);
    if (!expanded) throw new Error(`${raw} is not an absolute path. Start it with / or ~/.`);
    const path = await realpath(expanded).catch(() => null);
    const stat = path ? await lstat(path).catch(() => null) : null;
    if (!path || !stat?.isDirectory()) throw new Error(`${raw} is not a folder on this machine.`);
    return path;
  }

  return {
    resolve: resolveFolder,
    async read(raw) {
      return readFolder(await resolveFolder(raw));
    },
    deep: (input) => readFolderProject(git, input),
    commits: (input) => gitCommitSource(git, input),
    async remote(path) {
      const head = await repoGit(path, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      if (head.exit !== 0) return null;
      const remote = await repoGit(path, ["config", "--get", "remote.origin.url"]);
      return remote.exit === 0 ? remote.stdout.trim() || null : null;
    },
    async emails() {
      const all = [...(await configEmails()), ...extraEmails].map((e) => e.trim().toLowerCase()).filter(Boolean);
      return [...new Set(all)];
    },
  };
}

/** Reads the folders in `dir`, one level deep; symlinked folders are skipped. */
export function createProjectsReader({ dir, ...options }: FolderReaderOptions & { dir: string }): ProjectsReader {
  return createProjectsReaderFrom({ dir, folders: createFolderReader(options) });
}

function createProjectsReaderFrom({ dir, folders: reader }: { dir: string; folders: FolderReader }): ProjectsReader {
  async function folderNames(): Promise<string[]> {
    const root = await lstat(dir).catch(() => null);
    if (!root?.isDirectory()) throw new Error(`HB_PROJECTS_DIR (${dir}) is not a folder.`);
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_FOLDERS);
  }
  return {
    dir,
    async findClone({ owner, repo }) {
      const want = `${owner}/${repo}`.toLowerCase();
      const names = await folderNames();
      for (let i = 0; i < names.length; i += CONCURRENCY) {
        const batch = names.slice(i, i + CONCURRENCY).map((name) => join(dir, name));
        const remotes = await Promise.all(batch.map((path) => reader.remote(path)));
        const at = remotes.findIndex((url) => {
          const ref = url ? parseGithubRemote(url) : null;
          return ref !== null && `${ref.owner}/${ref.repo}`.toLowerCase() === want;
        });
        const found = batch[at];
        if (found) return realpath(found);
      }
      return null;
    },
    async list() {
      const names = await folderNames();
      const folders: LocalFolder[] = [];
      for (let i = 0; i < names.length; i += CONCURRENCY) {
        folders.push(
          ...(await Promise.all(names.slice(i, i + CONCURRENCY).map((name) => reader.read(join(dir, name))))),
        );
      }
      return { folders, emails: await reader.emails() };
    },
  };
}
