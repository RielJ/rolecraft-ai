import type { FactEvidence } from "@/shared/api";
import { commitUrl, fileUrl, type GithubRepoRef } from "@/shared/github-link";
import type { CommitPatch, CommitsFrom, Feature, Framing } from "./project-read";
import { isSecretPath } from "./project-read";
import { estimateTokens } from "./prompts";
import { checkCandidates } from "./split";
import { normalize } from "./text";

/**
 * What one GitHub read sends to the AI (decision 55), and the checks on what comes back. The
 * reader in `server/adapters/github.ts` fills a bundle within the token cap; nothing here fetches.
 */

// ---------- Limits ----------

/**
 * The hard cap on repo text in one read, in estimated tokens (four characters each). 12,000 keeps
 * the extraction prompt under about 13,000 tokens in, which is about 1.3 US cents on Haiku 5.5,
 * while leaving room for a full README, the manifests, the tree, 50 commit subjects and a few files.
 */
export const GITHUB_TOKEN_CAP = 12_000;

/** Per-section ceilings inside the cap, so one long README cannot crowd out the commits. */
export const GITHUB_SECTION_TOKENS = {
  readme: 3_000,
  manifest: 750,
  manifests: 1_500,
  tree: 1_000,
  commits: 1_500,
  file: 1_500,
  pullText: 2_000,
  diffStat: 1_000,
  discussion: 3_000,
} as const;

export const MAX_GITHUB_PICKS = 5;
export const MAX_GITHUB_COMMITS = 50;
/** A picked file is fetched only while at least this much of the cap is left. */
export const MIN_FILE_TOKENS = 200;

/** Root files that say what a project is built with, in the order they are read. At most three. */
export const MANIFEST_NAMES = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "deno.json",
  "pubspec.yaml",
  "Package.swift",
] as const;
const MAX_MANIFESTS = 3;

export function manifestPaths(tree: readonly string[]): string[] {
  const root = new Set(tree.filter((p) => !p.includes("/")));
  return MANIFEST_NAMES.filter((name) => root.has(name)).slice(0, MAX_MANIFESTS);
}

const SKIPPED_FILE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|wasm|min\.js|map)$/i;

/** Whether a tree path is worth reading as text: not a lock file, image, archive, binary or secret. */
export function isReadablePath(path: string): boolean {
  return !SKIPPED_FILE.test(path) && !isSecretPath(path);
}

// ---------- Budget ----------

/** Cut `text` to about `maxTokens`, on a line break when one is near. */
export function truncateTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lineEnd = cut.lastIndexOf("\n");
  return { text: lineEnd > maxChars * 0.8 ? cut.slice(0, lineEnd) : cut, truncated: true };
}

export type TokenBudget = {
  /** Tokens still free under the cap. */
  left(): number;
  /** Spend up to `max` tokens (never more than is left) on `text`; null once the cap is reached. */
  take(text: string, max: number): { text: string; truncated: boolean } | null;
};

export function createTokenBudget(cap: number = GITHUB_TOKEN_CAP): TokenBudget {
  let left = cap;
  return {
    left: () => left,
    take(text, max) {
      if (left <= 0) return null;
      const cut = truncateTokens(text, Math.min(max, left));
      left -= estimateTokens(cut.text);
      return cut;
    },
  };
}

// ---------- Bundles ----------

export type GithubFile = { path: string; text: string; truncated: boolean };
export type GithubCommit = { sha: string; subject: string };
export type ChangedFile = { path: string; additions: number; deletions: number };
export type GithubComment = { author: string; body: string };

type ReadBase = {
  /** Whose work this is: a GitHub login, or the user's commit emails for a folder. */
  user: string;
  private: boolean;
  description: string;
  /** The user's commits listed for the AI, newest first; picked commits always among them. */
  commits: GithubCommit[];
  /** Tokens of repo text used, at most `GITHUB_TOKEN_CAP`. */
  tokens: number;
  /** Whether the README describes the user's project (decision 81). */
  framing: Framing;
  /** The user's commits and all commits, when counted; null when framing came from the owner. */
  share: { mine: number; total: number } | null;
  /** The features the light model found, each with the commits whose hunks were read. */
  features: Feature[];
  /** Hunks of the picked commits, within `PATCH_TOKENS`. */
  patches: CommitPatch[];
};

type BundleBase = GithubRepoRef &
  ReadBase & {
    /** The branch (repo) or head commit (pull request) that file links point at. */
    at: string;
  };

type TreeFiles = {
  /** README, manifests and picked files, in the order they were read. */
  files: GithubFile[];
  /** Tree paths shown to the AI, and how many the tree had in all. */
  tree: string[];
  treeTotal: number;
};

export type RepoBundle = BundleBase &
  TreeFiles & {
    kind: "repo";
    /** Of the listed commits, those on GitHub; null when all are. A local clone may hold unpushed ones. */
    pushed: string[] | null;
    commitsFrom: CommitsFrom;
  };

export type PullBundle = BundleBase & {
  kind: "pull";
  number: number;
  title: string;
  body: string;
  /** Who opened it. */
  author: string;
  changed: ChangedFile[];
  changedTotal: number;
  discussion: GithubComment[];
};

export type GithubBundle = RepoBundle | PullBundle;

/**
 * Where a folder's evidence links point (decision 81): its remote, when that answers without
 * login. Only commits on a remote branch and files in the remote's tree get links.
 */
export type RemoteLinks = {
  host: "github" | "gitlab";
  /** `https://github.com/o/r` or `https://gitlab.com/g/p`. */
  web: string;
  /** The remote commit file links point at. */
  at: string;
  pushed: string[];
  files: string[];
};

/** A folder on this machine, read with git (decision 81). */
export type FolderBundle = ReadBase &
  TreeFiles & {
    kind: "folder";
    /** The project's name: its remote's `owner/repo`, or the folder's name. */
    name: string;
    /** Null for a private project: its facts show only `name`. */
    links: RemoteLinks | null;
  };

/** Anything a read fills: a GitHub repo or pull request, or a folder. */
export type ProjectBundle = GithubBundle | FolderBundle;

/** `owner/repo` for GitHub bundles, the project name for folders. */
export function bundleName(bundle: ProjectBundle): string {
  return bundle.kind === "folder" ? bundle.name : `${bundle.owner}/${bundle.repo}`;
}

function remoteFileUrl(links: RemoteLinks, path: string): string {
  const parts = path.split("/").map(encodeURIComponent).join("/");
  return links.host === "github"
    ? `${links.web}/blob/${encodeURIComponent(links.at)}/${parts}`
    : `${links.web}/-/blob/${encodeURIComponent(links.at)}/${parts}`;
}

function remoteCommitUrl(links: RemoteLinks, sha: string): string {
  return links.host === "github" ? `${links.web}/commit/${sha}` : `${links.web}/-/commit/${sha}`;
}

/** Picks from the AI, kept only when they are readable tree paths not read yet. At most five. */
export function validatePicks({
  picks,
  tree,
  read,
}: {
  picks: readonly string[];
  tree: readonly string[];
  read: readonly string[];
}): string[] {
  const inTree = new Set(tree);
  const taken = new Set(read);
  const out: string[] = [];
  for (const raw of picks) {
    const path = raw.trim().replace(/^\.?\//, "");
    if (!inTree.has(path) || taken.has(path) || !isReadablePath(path)) continue;
    taken.add(path);
    out.push(path);
    if (out.length === MAX_GITHUB_PICKS) break;
  }
  return out;
}

// ---------- Evidence ----------

const SHA = /^[0-9a-f]{7,40}$/i;

/** The files a fact may cite: those whose text was read (repo, folder), or the changed files (pull request). */
function citableFiles(bundle: ProjectBundle): string[] {
  return bundle.kind === "pull" ? bundle.changed.map((f) => f.path) : bundle.files.map((f) => f.path);
}

/** A file's or commit's link: GitHub for GitHub bundles, the public remote for folders, else null. */
function evidenceUrl(bundle: ProjectBundle, ref: { path: string } | { sha: string }): string | null {
  if (bundle.kind !== "folder") {
    if ("path" in ref) return fileUrl({ owner: bundle.owner, repo: bundle.repo, at: bundle.at, path: ref.path });
    if (bundle.kind === "repo" && bundle.pushed && !bundle.pushed.includes(ref.sha)) return null;
    return commitUrl({ owner: bundle.owner, repo: bundle.repo, sha: ref.sha });
  }
  const links = bundle.links;
  if (!links) return null;
  if ("path" in ref) return links.files.includes(ref.path) ? remoteFileUrl(links, ref.path) : null;
  return links.pushed.includes(ref.sha) ? remoteCommitUrl(links, ref.sha) : null;
}

/**
 * The evidence a cited path or sha stands for, or null when it names nothing that was read. A sha
 * may be shortened to seven characters as long as it names one commit.
 */
export function resolveEvidence({ bundle, cited }: { bundle: ProjectBundle; cited: string }): FactEvidence | null {
  const ref = cited.trim();
  const repo = bundleName(bundle);
  const path = ref.replace(/^\.?\//, "");
  if (citableFiles(bundle).includes(path)) {
    return { kind: "file", path, url: evidenceUrl(bundle, { path }), repo, private: bundle.private };
  }
  if (SHA.test(ref)) {
    const prefix = ref.toLowerCase();
    const matches = bundle.commits.filter((c) => c.sha.toLowerCase().startsWith(prefix));
    const [commit] = matches;
    if (matches.length === 1 && commit) {
      return { kind: "commit", sha: commit.sha, url: evidenceUrl(bundle, commit), repo, private: bundle.private };
    }
  }
  return null;
}

/** Every word of repo text the AI saw: the only evidence a fact's numbers and names may rest on. */
export function bundleEvidenceText(bundle: ProjectBundle): string {
  const name = bundleName(bundle);
  const head = [name, name.split("/").at(-1) ?? name, bundle.description];
  const commits = bundle.commits.map((c) => c.subject);
  const patches = bundle.patches.map((p) => `${p.path}\n${p.text}`);
  if (bundle.kind !== "pull")
    return [...head, ...bundle.files.map((f) => f.text), ...bundle.tree, ...commits, ...patches].join("\n");
  return [
    ...head,
    bundle.title,
    bundle.body,
    ...bundle.changed.map((f) => f.path),
    ...commits,
    ...patches,
    ...bundle.discussion.map((c) => c.body),
  ].join("\n");
}

export type GithubProposal = { text: string; evidence: string };
export type AcceptedGithubFact = { text: string; evidence: FactEvidence };
export type DroppedGithubFact = { text: string; reason: string };

/**
 * Keep a proposed fact only when (1) it cites a file or commit that was read, and (2) every
 * number, name, skill and link in it appears in what was read (the split's own token check).
 * Repeats after `normalize` keep the first.
 */
export function acceptGithubFacts({
  bundle,
  proposals,
}: {
  bundle: ProjectBundle;
  proposals: readonly GithubProposal[];
}): { kept: AcceptedGithubFact[]; dropped: DroppedGithubFact[] } {
  const kept: AcceptedGithubFact[] = [];
  const dropped: DroppedGithubFact[] = [];
  const seen = new Set<string>();
  const evidenceText = bundleEvidenceText(bundle);
  for (const proposal of proposals) {
    const text = proposal.text.replace(/\s+/g, " ").trim();
    const key = normalize(text);
    if (key === "" || seen.has(key)) continue;
    const evidence = resolveEvidence({ bundle, cited: proposal.evidence });
    if (!evidence) {
      dropped.push({ text, reason: `cites "${proposal.evidence}", which was not read` });
      continue;
    }
    const check = checkCandidates({ candidates: [text], evidence: evidenceText });
    const miss = check.dropped[0];
    if (miss) {
      dropped.push({ text, reason: `says ${miss.tokens.map((t) => `"${t}"`).join(", ")}, which the repo does not` });
      continue;
    }
    seen.add(key);
    kept.push({ text, evidence });
  }
  return { kept, dropped };
}
