import { basename } from "node:path";
import {
  createTokenBudget,
  type FolderBundle,
  GITHUB_SECTION_TOKENS,
  GITHUB_TOKEN_CAP,
  type GithubFile,
  isReadablePath,
  MIN_FILE_TOKENS,
  manifestPaths,
  type RemoteLinks,
  type TokenBudget,
  validatePicks,
} from "@/domain/github-read";
import {
  type ChooseCommits,
  type CommitSource,
  type CommitsFrom,
  framingOf,
  isSecretPath,
  MAX_LISTED_COMMITS,
  MAX_PATCH_FILES,
  meaningfulFiles,
  parseNumstatLog,
  type RawPatch,
  splitDiff,
} from "@/domain/project-read";
import { estimateTokens } from "@/domain/prompts";
import { readCommitEvidence } from "./commit-evidence";
import type { Git, GitLimits } from "./git";
import type { GithubPick } from "./github";

/**
 * Reading one folder for facts (decision 81), with git only: the committed tree (so git-ignored
 * files never show up), the README and manifests at HEAD, the user's commits with the files each
 * changed, and the hunks of the commits `choose` picks. Secret files are never read: they are left
 * out of the tree and passed to no `git show`. Within the 12,000-token cap, hunks come after the
 * README, manifests, tree and commit list, and picked files take what is left.
 */

/** Where a public remote's links point; null when the remote isn't public or isn't GitHub or GitLab. */
export type PublicRemote = (remote: string) => Promise<{ host: "github" | "gitlab"; web: string; name: string } | null>;

export type FolderReadInput = {
  /** Resolved by `FolderReader.resolve`. */
  path: string;
  /** Shown as the person in the prompt. */
  user: string;
  isMine: (email: string) => boolean;
  choose: ChooseCommits;
  pick: GithubPick;
  publicRemote: PublicRemote;
  step?: (text: string) => Promise<void>;
};

export class FolderReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderReadError";
  }
}

/** Commits counted for the share, newest first, merges left out. */
const MAX_LOG_COMMITS = 3_000;
const README = /^readme(\.(md|markdown|txt|rst))?$/i;

function byDepth(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

function takeLines(budget: TokenBudget, lines: readonly string[], max: number): string[] {
  const cut = budget.take(lines.join("\n"), max);
  if (!cut) return [];
  const shown = cut.text.split("\n");
  return cut.truncated ? shown.slice(0, -1) : shown;
}

/** `:(literal)path`, so a path is never read as a pathspec pattern. */
const literal = (path: string) => `:(literal)${path}`;

export async function readFolderProject(git: Git, input: FolderReadInput): Promise<FolderBundle> {
  const { path } = input;
  const step = input.step ?? (async () => {});
  const at = (args: string[], limits?: Parameters<Git["repo"]>[2]) => git.repo(path, args, limits);

  const head = await at(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.exit !== 0 || !head.stdout.trim()) {
    throw new FolderReadError(`${basename(path)} is not a git repo with commits, so there is nothing to read.`);
  }
  const headSha = head.stdout.trim();
  const remoteUrl = (await at(["config", "--get", "remote.origin.url"])).stdout.trim() || null;
  const remote = remoteUrl ? await input.publicRemote(remoteUrl).catch(() => null) : null;
  const name = remote?.name ?? basename(path);
  const budget = createTokenBudget(GITHUB_TOKEN_CAP);
  const files: GithubFile[] = [];

  await step(`Reading the file tree of ${name}`);
  const listing = await at(["ls-tree", "-r", "--name-only", "-z", headSha]);
  const all = listing.stdout
    .split("\0")
    .filter((p) => p && !isSecretPath(p))
    .sort(byDepth);
  const tree = takeLines(budget, all, GITHUB_SECTION_TOKENS.tree);

  const blob = async (file: string): Promise<string | null> => {
    const r = await at(["cat-file", "blob", `${headSha}:${file}`], { maxBytes: 64 * 1024 });
    return r.exit === 0 && !r.stdout.includes("\0") ? r.stdout : null;
  };

  await step("Reading the README and manifests");
  const readmePath = all.filter((p) => !p.includes("/") && README.test(p)).sort()[0];
  const readme = readmePath ? await blob(readmePath) : null;
  if (readmePath && readme !== null) {
    const cut = budget.take(readme, GITHUB_SECTION_TOKENS.readme);
    if (cut) files.push({ path: readmePath, ...cut });
  }
  let manifestLeft = GITHUB_SECTION_TOKENS.manifests;
  for (const manifest of manifestPaths(all)) {
    if (manifestLeft <= 0) break;
    const text = await blob(manifest);
    if (text === null) continue;
    const cut = budget.take(text, Math.min(GITHUB_SECTION_TOKENS.manifest, manifestLeft));
    if (!cut) break;
    manifestLeft -= estimateTokens(cut.text);
    files.push({ path: manifest, ...cut });
  }

  const source = gitCommitSource(git, { path, head: headSha, isMine: input.isMine, from: "folder" });
  const evidence = await readCommitEvidence({
    source,
    choose: input.choose,
    name,
    user: input.user,
    readme,
    budget,
    step,
  });
  const { commits, features, patches } = evidence;
  const share = evidence.share ?? { mine: 0, total: 0 };

  if (budget.left() >= MIN_FILE_TOKENS && tree.length > 0) {
    await step("Choosing files to read");
    const picks = validatePicks({
      picks: await input.pick({ repo: name, description: "", tree, already: files.map((f) => f.path) }),
      tree,
      read: files.map((f) => f.path),
    });
    for (const file of picks) {
      if (budget.left() < MIN_FILE_TOKENS) break;
      if (!isReadablePath(file)) continue;
      await step(`Reading ${file}`);
      const text = await blob(file);
      if (text === null) continue;
      const cut = budget.take(text, GITHUB_SECTION_TOKENS.file);
      if (!cut) break;
      files.push({ path: file, ...cut });
    }
  }

  const links = remote
    ? await remoteLinks(at, { remote, read: files.map((f) => f.path), listed: commits.map((c) => c.sha) })
    : null;
  return {
    kind: "folder",
    name,
    user: input.user,
    private: links === null,
    description: "",
    links,
    files,
    tree,
    treeTotal: all.length,
    commits,
    tokens: GITHUB_TOKEN_CAP - budget.left(),
    framing: framingOf(share),
    share,
    features,
    patches,
  };
}

/**
 * The user's commits and hunks from a git folder: a folder read, a local clone of a GitHub repo,
 * or a blob-less temp clone. `sized: false` lists paths without line counts, so a blob-less clone
 * fetches no blobs to list; `git show` then fetches only the picked commits' blobs.
 */
export function gitCommitSource(
  git: Git,
  {
    path,
    head = "HEAD",
    isMine,
    from,
    sized = true,
    showLimits = {},
    close,
  }: {
    path: string;
    head?: string;
    isMine: (email: string) => boolean;
    from: CommitsFrom;
    sized?: boolean;
    showLimits?: GitLimits;
    close?: () => Promise<void>;
  },
): CommitSource {
  const at = (args: string[], limits?: GitLimits) => git.repo(path, args, limits);
  return {
    from,
    maxPatchCommits: Number.POSITIVE_INFINITY,
    async list() {
      const log = await at([
        "log",
        "--no-merges",
        "--no-renames",
        `--max-count=${MAX_LOG_COMMITS}`,
        "--format=%x1e%H%x1f%ae%x1f%aI%x1f%s",
        sized ? "--numstat" : "--name-only",
        head,
        "--",
      ]);
      const everyone = parseNumstatLog(log.stdout, { sized });
      const mine = everyone.filter((c) => isMine(c.email));
      return { mine: mine.slice(0, MAX_LISTED_COMMITS), share: { mine: mine.length, total: everyone.length } };
    },
    async patches(commits, step) {
      const out: RawPatch[] = [];
      for (const commit of commits) {
        const paths = meaningfulFiles(commit.files).slice(0, MAX_PATCH_FILES);
        if (paths.length === 0) continue;
        await step(`Reading the changes in ${commit.sha.slice(0, 7)} ${commit.subject}`.slice(0, 120));
        const shown = await at(
          [
            "show",
            "--format=",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--unified=3",
            commit.sha,
            "--",
            ...paths.map((f) => literal(f.path)),
          ],
          { maxBytes: 512 * 1024, ...showLimits },
        );
        if (shown.exit === 0) out.push({ sha: commit.sha, files: splitDiff(shown.stdout) });
      }
      return out;
    },
    ...(from === "local clone"
      ? {
          async pushed(shas: readonly string[]) {
            const r = await at(["rev-list", "--remotes=origin", "--max-count=100000"]);
            const onRemote = new Set(r.stdout.split("\n"));
            return shas.filter((sha) => onRemote.has(sha));
          },
        }
      : {}),
    ...(close ? { close } : {}),
  };
}

/**
 * Links for a public remote: the commits on any of its branches, and the read files its default
 * branch has. Commits never pushed and files only on this machine stay unlinked.
 */
async function remoteLinks(
  at: (args: string[], limits?: Parameters<Git["repo"]>[2]) => ReturnType<Git["repo"]>,
  { remote, read, listed }: { remote: { host: "github" | "gitlab"; web: string }; read: string[]; listed: string[] },
): Promise<RemoteLinks> {
  let remoteHead: string | null = null;
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    const r = await at(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (r.exit === 0 && r.stdout.trim()) {
      remoteHead = r.stdout.trim();
      break;
    }
  }
  // Public, but never fetched here: nothing can be shown to be on the remote, so nothing is linked.
  if (!remoteHead) return { host: remote.host, web: remote.web, at: "", pushed: [], files: [] };
  const pushed = await at(["rev-list", "--remotes=origin", "--max-count=100000"]);
  const tracked = await at(["ls-tree", "-r", "--name-only", "-z", remoteHead]);
  const files = new Set(tracked.stdout.split("\0"));
  const onRemote = new Set(pushed.stdout.split("\n"));
  return {
    host: remote.host,
    web: remote.web,
    at: remoteHead,
    pushed: listed.filter((sha) => onRemote.has(sha)),
    files: read.filter((f) => files.has(f)),
  };
}
