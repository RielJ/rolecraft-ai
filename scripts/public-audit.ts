/**
 * Public-repository safety guard: `bun scripts/public-audit.ts [--history] [--cwd <dir>]`.
 *
 * Default mode checks what a commit could publish right now: every tracked file (both the staged
 * copy in the index and the working-tree copy) plus untracked files Git does not ignore. Ignored
 * files (.env, data/, .pi/ ...) are never listed and never read. `--history` also checks every
 * blob and path reachable from any ref, reading each distinct blob once.
 *
 * Two kinds of finding:
 * - a path that should never be in a public repo (private agent state, env files, runtime data,
 *   database dumps, private key files, build/test output, node_modules). Content at such a path is
 *   not read.
 * - a high-confidence secret pattern (provider key prefixes with full-length bodies, private key
 *   blocks with a key body). Output names only path, line, and category: never the matched value.
 *
 * Fixtures: a match counts as a placeholder only when the token itself says so (it contains
 * "example", "fake", "dummy", "placeholder", "fixture", "redacted", "notreal", or "sample"), has a
 * run of 6+ identical characters, or uses fewer than 6 distinct characters. There is no path
 * exemption: a real-looking key in a test file fails like anywhere else. Short fakes such as
 * `sk-ant-good-key-a1B2` never match because the patterns require real key lengths.
 *
 * This is best-effort. A clean result is not proof that no secret exists: it knows a fixed set
 * of formats, skips binary and very large files, and cannot see unreachable objects.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Source = "worktree" | "index" | "history";

export type Finding = {
  path: string;
  category: string;
  source: Source;
  line?: number;
  /** History only: the oldest commit (abbreviated) that holds the path or blob. */
  commit?: string;
};

export type TextFinding = { line: number; category: string };

const MAX_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Paths

const BUILD_DIR = /^(dist|dist-[^/]+|build-output)$/;
const TEST_DIR = new Set(["test-results", "playwright-report", "blob-report", "coverage"]);

/** The category of a path that must never be published, or null. */
export function pathViolation(path: string): string | null {
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";
  const lower = base.toLowerCase();
  if (segments.includes(".pi")) return "private-agent-state";
  if (segments.includes("node_modules")) return "dependencies";
  if (base === ".envrc" || base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return "env-file";
  if (segments.length > 1 && segments[0] === "data") return "runtime-data";
  if (segments.slice(0, -1).some((s) => BUILD_DIR.test(s)) || lower.endsWith(".tsbuildinfo")) return "build-output";
  if (segments.slice(0, -1).some((s) => TEST_DIR.has(s))) return "test-output";
  if (
    /\.(dump|pgdump|sqlite|sqlite3|db)$/.test(lower) ||
    /\.sql\.(gz|bz2|xz|zst|zip)$/.test(lower) ||
    (lower.endsWith(".sql") && segments[0] !== "drizzle")
  ) {
    return "database-dump";
  }
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(lower) || /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(lower)) {
    return "private-key-file";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Secrets

type Pattern = { category: string; regex: RegExp /** Capture group holding the part to judge. */; group?: number };

// Each regex is written so that its own source text does not match it.
const PATTERNS: Pattern[] = [
  {
    category: "private-key",
    regex:
      /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}[ \t]*\r?\n(?:[A-Za-z-]+:[^\n]*\r?\n)*(?:\r?\n)?([A-Za-z0-9+/=]{40,})/g,
    group: 1,
  },
  { category: "anthropic-key", regex: /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{80,}/g },
  { category: "openai-key", regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { category: "openai-key", regex: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { category: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { category: "github-token", regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { category: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { category: "aws-access-key-id", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { category: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: "slack-token", regex: /\bxox[abeprs]-[0-9A-Za-z-]{20,}/g },
  { category: "slack-webhook", regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
  { category: "stripe-key", regex: /\b[sr]k_live_[0-9A-Za-z]{20,}/g },
  { category: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

const PLACEHOLDER_WORDS = ["example", "fake", "dummy", "placeholder", "fixture", "redacted", "notreal", "sample"];

/** True when a matched token is an obvious fixture, judged from the token alone. */
export function isPlaceholder(token: string): boolean {
  const lower = token.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true;
  if (/(.)\1{5}/.test(token)) return true;
  // Judge distinct characters on the part after the last prefix separator.
  const body = token.slice(Math.max(token.lastIndexOf("_"), token.lastIndexOf("-")) + 1) || token;
  return new Set(body.length >= 12 ? body : token).size < 6;
}

/** Secret findings in a text: line and category only. */
export function scanText(text: string): TextFinding[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: TextFinding[] = [];
  const seen = new Set<string>();
  for (const { category, regex, group } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const token = group === undefined ? match[0] : (match[group] ?? match[0]);
      if (isPlaceholder(token)) continue;
      const line = lineOf(match.index);
      const key = `${line}:${category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line, category });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.category.localeCompare(b.category));
}

function scanBytes(bytes: Uint8Array): TextFinding[] {
  if (bytes.length > MAX_BYTES) return [];
  if (bytes.subarray(0, 8000).includes(0)) return []; // binary
  return scanText(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------------------------
// Git

function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function nulList(out: Buffer): string[] {
  return out.toString("utf8").split("\0").filter(Boolean);
}

/** Reads blobs with one `git cat-file --batch` per chunk. */
function readBlobs(cwd: string, shas: string[], onBlob: (sha: string, bytes: Buffer) => void): void {
  for (let start = 0; start < shas.length; start += 500) {
    const chunk = shas.slice(start, start + 500);
    const out = git(cwd, ["cat-file", "--batch"], `${chunk.join("\n")}\n`);
    let offset = 0;
    while (offset < out.length) {
      const eol = out.indexOf(10, offset);
      if (eol === -1) break;
      const [sha = "", type = "", size = "0"] = out.subarray(offset, eol).toString("utf8").split(" ");
      if (type === "missing") {
        offset = eol + 1;
        continue;
      }
      const length = Number(size);
      onBlob(sha, out.subarray(eol + 1, eol + 1 + length));
      offset = eol + 1 + length + 1;
    }
  }
}

const byPathLine = (a: Finding, b: Finding) =>
  a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.category.localeCompare(b.category);

/** Index and working-tree copies of tracked files, plus untracked files Git doesn't ignore. */
export function auditWorkingTree(cwd: string): Finding[] {
  const findings: Finding[] = [];
  const index = new Map<string, string>(); // path -> blob sha
  for (const entry of nulList(git(cwd, ["ls-files", "-s", "-z"]))) {
    const tab = entry.indexOf("\t");
    const [mode = "", sha = ""] = entry.slice(0, tab).split(" ");
    if (mode === "100644" || mode === "100755") index.set(entry.slice(tab + 1), sha);
  }
  const untracked = nulList(git(cwd, ["ls-files", "-o", "--exclude-standard", "-z"]));
  const paths = [...new Set([...nulList(git(cwd, ["ls-files", "-z"])), ...untracked])];

  const toRead: string[] = [];
  for (const path of paths) {
    const category = pathViolation(path);
    if (category) findings.push({ path, category, source: "worktree" });
    else toRead.push(path);
  }

  const worktreeKeys = new Set<string>();
  for (const path of toRead) {
    let bytes: Buffer;
    try {
      const stat = lstatSync(join(cwd, path));
      if (!stat.isFile() || stat.size > MAX_BYTES) continue; // symlinks are not followed
      bytes = readFileSync(join(cwd, path));
    } catch {
      continue; // deleted in the working tree; the index copy is still checked
    }
    for (const { line, category } of scanBytes(bytes)) {
      worktreeKeys.add(`${path}\0${line}\0${category}`);
      findings.push({ path, line, category, source: "worktree" });
    }
  }

  const shaPaths = new Map<string, string[]>();
  for (const path of toRead) {
    const sha = index.get(path);
    if (sha) shaPaths.set(sha, [...(shaPaths.get(sha) ?? []), path]);
  }
  readBlobs(cwd, [...shaPaths.keys()], (sha, bytes) => {
    const hits = scanBytes(bytes);
    for (const path of shaPaths.get(sha) ?? []) {
      for (const { line, category } of hits) {
        if (!worktreeKeys.has(`${path}\0${line}\0${category}`))
          findings.push({ path, line, category, source: "index" });
      }
    }
  });
  return findings.sort(byPathLine);
}

/** Oldest commit (abbreviated) among `git log --all <args>`, or undefined. */
function oldestCommit(cwd: string, args: string[]): string | undefined {
  const lines = git(cwd, ["log", "--all", "--format=%h", ...args])
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  return lines.at(-1);
}

/** Every path and every distinct blob reachable from any ref. Each blob is read once. */
export function auditHistory(cwd: string): { findings: Finding[]; blobsScanned: number } {
  const findings: Finding[] = [];

  // Paths: every name any commit added or changed, merges included.
  const historyPaths = new Set(
    git(cwd, ["log", "--all", "-m", "--no-renames", "--name-only", "--format=", "-z"])
      .toString("utf8")
      .split("\0")
      .map((p) => p.replace(/^\n+/, ""))
      .filter(Boolean),
  );
  for (const path of [...historyPaths].sort()) {
    const category = pathViolation(path);
    if (!category) continue;
    const commit = oldestCommit(cwd, ["--diff-filter=A", "--", path]) ?? oldestCommit(cwd, ["--", path]);
    findings.push({ path, category, source: "history", ...(commit ? { commit } : {}) });
  }

  // Blobs: rev-list names each object once, so duplicates across commits cost nothing.
  const objects = git(cwd, ["rev-list", "--objects", "--all"]).toString("utf8").split("\n").filter(Boolean);
  const nameOf = new Map<string, string>();
  for (const line of objects) {
    const space = line.indexOf(" ");
    if (space !== -1) nameOf.set(line.slice(0, space), line.slice(space + 1));
  }
  const checks = git(
    cwd,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    [...nameOf.keys()].join("\n"),
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const blobs: string[] = [];
  for (const line of checks) {
    const [sha = "", type, size] = line.split(" ");
    const path = nameOf.get(sha);
    if (type !== "blob" || path === undefined || Number(size) > MAX_BYTES || pathViolation(path)) continue;
    blobs.push(sha);
  }
  readBlobs(cwd, blobs, (sha, bytes) => {
    const path = nameOf.get(sha) ?? sha;
    const hits = scanBytes(bytes);
    if (hits.length === 0) return;
    const commit = oldestCommit(cwd, [`--find-object=${sha}`]);
    for (const { line, category } of hits) {
      findings.push({ path, line, category, source: "history", ...(commit ? { commit } : {}) });
    }
  });
  return { findings: findings.sort(byPathLine), blobsScanned: blobs.length };
}

// ---------------------------------------------------------------------------------------------
// CLI

/** One report line. Never includes file content. */
export function formatFinding(finding: Finding): string {
  const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
  const extra =
    finding.source === "history"
      ? `history${finding.commit ? `, first in ${finding.commit}` : ""}`
      : finding.source === "index"
        ? "staged copy"
        : "";
  return `  ${where}  ${finding.category}${extra ? `  (${extra})` : ""}`;
}

const USAGE = `usage: bun scripts/public-audit.ts [--history] [--cwd <dir>]
Best-effort check for private paths and high-confidence secrets before publishing.`;

/** Runs the audit; returns the exit code (0 clean, 1 findings, 2 usage or git error). */
export async function main(argv: string[], print: (line: string) => void = console.log): Promise<number> {
  let cwd = process.cwd();
  let history = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--history") history = true;
    else if (arg === "--cwd" && argv[i + 1]) cwd = argv[++i] ?? cwd;
    else {
      print(USAGE);
      return arg === "--help" || arg === "-h" ? 0 : 2;
    }
  }

  let findings: Finding[];
  let note = "";
  try {
    findings = auditWorkingTree(cwd);
    if (history) {
      if (git(cwd, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true") {
        print("public-audit: warning: shallow clone, so history is partial. Fetch with --unshallow for a full scan.");
      }
      const result = auditHistory(cwd);
      findings = findings.concat(result.findings);
      note = `, ${result.blobsScanned} history blobs`;
    }
  } catch (error) {
    // Git's stderr can echo paths but not file contents.
    print(`public-audit: git failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return 2;
  }

  const scope = history ? "current files and reachable history" : "current files";
  if (findings.length === 0) {
    print(`public-audit: no findings in ${scope}${note}. Best-effort only, not proof that no secret exists.`);
    return 0;
  }
  print(`public-audit: ${findings.length} finding(s) in ${scope}${note}. Values are not shown.`);
  for (const finding of findings) print(formatFinding(finding));
  print("Stop publication and rotate exposed credentials. Removing current files does not remove historical copies.");
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
