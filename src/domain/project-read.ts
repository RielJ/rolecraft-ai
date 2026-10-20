import type { ChangedFile } from "./github-read";
import { estimateTokens } from "./prompts";

/**
 * Reading what the user did in a project (decision 81): their commits with the files each one
 * changed, a few commits per feature picked by the light model, and those commits' hunks. Both
 * the folder reader and the GitHub reader fill these shapes; nothing here runs git or fetches.
 */

/** One of the user's commits, with the files it changed (lock, generated and secret files left out). */
export type UserCommit = { sha: string; subject: string; date: string | null; files: ChangedFile[] };

/** A piece of work the light model found in the user's commits, and the commits that show it. */
export type Feature = { name: string; shas: string[] };

/** The hunks of one changed file in one picked commit, as read. */
export type CommitPatch = { sha: string; path: string; text: string; truncated: boolean };

/** "own": at least half the commits are the user's, so the README describes their project. */
export type Framing = "own" | "contribution";

/** The commits whose hunks a read shows, and the features they were picked for (none in a fallback). */
export type CommitChoice = { features: Feature[]; shas: string[] };

/**
 * Picks the commits to read (the service passes the light-model call). Readers call it with the
 * user's commits, newest first, and the README.
 */
export type ChooseCommits = (input: {
  name: string;
  user: string;
  readme: string | null;
  commits: readonly UserCommit[];
}) => Promise<CommitChoice>;

export const MAX_FEATURES = 6;
export const MAX_FEATURE_COMMITS = 3;
/** With fewer of the user's commits than this, grouping is skipped and the biggest are read. */
export const MIN_GROUPING_COMMITS = 5;
/** Commits read when grouping is skipped or its reply is unusable. */
export const FALLBACK_COMMITS = 8;
/** The user's commits listed for grouping, newest first. */
export const MAX_LISTED_COMMITS = 300;
/** Tokens of the commit list in the grouping prompt. */
export const FEATURE_LIST_TOKENS = 4_000;
/** Tokens of hunks in one read, shared evenly by the picked commits. */
export const PATCH_TOKENS = 4_500;
/** Hunks are read for at most this many commits when they come from the GitHub API. */
export const API_PATCH_COMMITS = 10;

// ---------- Which files count ----------

const SECRET_NAME =
  /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|service[-_]?account.*\.json|.*\.(?:pem|key|p12|pfx|jks|keystore|gpg|asc|tfvars|kdbx))$/i;

/** Files never read or shown, wherever they are: env files, keys, credentials (decision 81). */
export function isSecretPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return SECRET_NAME.test(name);
}

const NOISE =
  /(?:^|\/)(?:node_modules|vendor|dist|build|out|\.next|coverage|target|__snapshots__|__generated__)\/|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock|flake\.lock)$|\.(?:min\.js|min\.css|map|snap|lock|pb\.go|g\.dart)$|_pb2\.py$|\.generated\.|\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|wasm)$/i;

/** Lock files, build output, vendored and generated code, and binaries: not the user's writing. */
export function isNoisePath(path: string): boolean {
  return NOISE.test(path);
}

/** Lines the user wrote in a commit, counting only files that are theirs to write. */
export function commitWeight(commit: UserCommit): number {
  return commit.files.reduce(
    (n, f) => n + (isNoisePath(f.path) || isSecretPath(f.path) ? 0 : f.additions + f.deletions),
    0,
  );
}

/** A commit's files without noise or secrets, biggest first. */
export function meaningfulFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return files
    .filter((f) => !isNoisePath(f.path) && !isSecretPath(f.path))
    .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

// ---------- Whose project ----------

export function framingOf({ mine, total }: { mine: number; total: number }): Framing {
  return mine > 0 && mine * 2 >= total ? "own" : "contribution";
}

// ---------- Picking commits ----------

/**
 * The fallback pick: the user's biggest commits, at most `perMonth` from any one month, so one
 * big week doesn't fill the read. Commits that changed nothing of theirs are skipped.
 */
export function biggestCommits({
  commits,
  max = FALLBACK_COMMITS,
  perMonth = 2,
}: {
  commits: readonly UserCommit[];
  max?: number;
  perMonth?: number;
}): string[] {
  const used = new Map<string, number>();
  const out: string[] = [];
  const ranked = commits.filter((c) => commitWeight(c) > 0).toSorted((a, b) => commitWeight(b) - commitWeight(a));
  for (const c of ranked) {
    const month = c.date?.slice(0, 7) ?? "?";
    const n = used.get(month) ?? 0;
    if (n >= perMonth) continue;
    used.set(month, n + 1);
    out.push(c.sha);
    if (out.length === max) break;
  }
  return out;
}

/** The commit a cited sha (7 to 40 characters) names, when it names exactly one. */
export function resolveSha(commits: readonly { sha: string }[], cited: string): string | null {
  const ref = cited.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(ref)) return null;
  const matches = commits.filter((c) => c.sha.toLowerCase().startsWith(ref));
  return matches.length === 1 ? (matches[0]?.sha ?? null) : null;
}

/**
 * The model's features, kept to commits in the list: unknown or ambiguous shas are dropped, a
 * commit belongs to one feature only, each feature keeps at most 3 commits, at most 6 features.
 */
export function validateFeatures({
  features,
  commits,
}: {
  features: readonly { name: string; commits: readonly string[] }[];
  commits: readonly UserCommit[];
}): Feature[] {
  const taken = new Set<string>();
  const out: Feature[] = [];
  for (const f of features) {
    const name = f.name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) continue;
    const shas: string[] = [];
    for (const cited of f.commits) {
      const sha = resolveSha(commits, cited);
      if (!sha || taken.has(sha)) continue;
      taken.add(sha);
      shas.push(sha);
      if (shas.length === MAX_FEATURE_COMMITS) break;
    }
    if (shas.length) out.push({ name, shas });
    if (out.length === MAX_FEATURES) break;
  }
  return out;
}

/** One line per commit for the grouping prompt: sha, month, size, subject, top files. */
export function commitListLine(c: UserCommit): string {
  const files = meaningfulFiles(c.files);
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const top = files
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  return `${c.sha.slice(0, 12)} ${c.date?.slice(0, 7) ?? "?"} +${add} -${del} ${c.subject}${top ? ` [${top}]` : ""}`;
}

/** The listed commit lines, newest first, within `maxTokens`. */
export function commitList({ commits, maxTokens }: { commits: readonly UserCommit[]; maxTokens: number }): {
  lines: string[];
  more: number;
} {
  const lines: string[] = [];
  let used = 0;
  for (const c of commits) {
    const line = commitListLine(c);
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) break;
    used += cost;
    lines.push(line);
  }
  return { lines, more: commits.length - lines.length };
}

/**
 * The commits listed in the facts prompt, within `maxTokens`: the picked ones first, so a fact can
 * always cite them, then the newest of the rest.
 */
export function listedCommits({
  commits,
  picked,
  maxTokens,
}: {
  commits: readonly UserCommit[];
  picked: readonly string[];
  maxTokens: number;
}): { sha: string; subject: string }[] {
  const first = new Set(picked);
  const ordered = [...commits.filter((c) => first.has(c.sha)), ...commits.filter((c) => !first.has(c.sha))];
  const out: { sha: string; subject: string }[] = [];
  let left = maxTokens;
  for (const c of ordered) {
    const cost = estimateTokens(`${c.sha.slice(0, 12)} ${c.subject}`) + 1;
    if (cost > left) break;
    left -= cost;
    out.push({ sha: c.sha, subject: c.subject });
  }
  return out;
}

/** `git log --numstat` output written with `--format=%x1e%H%x1f%ae%x1f%aI%x1f%s`, one record per commit. */
export function parseNumstatLog(text: string): (UserCommit & { email: string })[] {
  const out: (UserCommit & { email: string })[] = [];
  for (const record of text.split("\x1e").slice(1)) {
    const [head = "", ...rest] = record.split("\n");
    const [sha, email, date, subject] = head.split("\x1f");
    if (!sha || email === undefined) continue;
    const files: ChangedFile[] = [];
    for (const line of rest) {
      const [add, del, path] = line.split("\t");
      if (!path || add === undefined || del === undefined) continue;
      // Binary files show "-"; they count as no lines written.
      files.push({ path, additions: Number(add) || 0, deletions: Number(del) || 0 });
    }
    out.push({ sha, email, date: date || null, subject: (subject ?? "").trim().slice(0, 200), files });
  }
  return out;
}

// ---------- Hunks ----------

/** `git show` / GitHub patch text split per file; binary files and secrets are dropped. */
export function splitDiff(diff: string): { path: string; patch: string }[] {
  const out: { path: string; patch: string }[] = [];
  const parts = diff.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const header = part.slice(0, part.indexOf("\n"));
    const path = / b\/(.+)$/.exec(header)?.[1];
    const hunks = part.indexOf("\n@@");
    if (!path || hunks < 0 || isSecretPath(path) || isNoisePath(path)) continue;
    out.push({ path, patch: part.slice(hunks + 1).trimEnd() });
  }
  return out;
}

/**
 * Hunks for the picked commits within `maxTokens`: each commit gets an even share, its biggest
 * files first, and a file is cut short rather than skipped when its share runs out.
 */
export function fitPatches({
  patches,
  maxTokens = PATCH_TOKENS,
}: {
  /** Per picked commit, in pick order. */
  patches: readonly { sha: string; files: readonly { path: string; patch: string }[] }[];
  maxTokens?: number;
}): CommitPatch[] {
  const withFiles = patches.filter((p) => p.files.length > 0);
  if (withFiles.length === 0) return [];
  const share = Math.floor(maxTokens / withFiles.length);
  const out: CommitPatch[] = [];
  for (const commit of withFiles) {
    let left = share;
    const files = commit.files.toSorted((a, b) => b.patch.length - a.patch.length);
    for (const file of files) {
      if (left < 40) break;
      const maxChars = left * 4;
      const truncated = file.patch.length > maxChars;
      const text = truncated ? file.patch.slice(0, maxChars) : file.patch;
      left -= estimateTokens(text);
      out.push({ sha: commit.sha, path: file.path, text, truncated });
    }
  }
  return out;
}
