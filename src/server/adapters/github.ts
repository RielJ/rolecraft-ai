import { z } from "zod";
import {
  createTokenBudget,
  GITHUB_SECTION_TOKENS,
  GITHUB_TOKEN_CAP,
  type GithubBundle,
  type GithubComment,
  type GithubCommit,
  type GithubFile,
  MAX_GITHUB_COMMITS,
  MIN_FILE_TOKENS,
  manifestPaths,
  type PullBundle,
  type PullStatus,
  type RepoBundle,
  type TokenBudget,
  validatePicks,
} from "@/domain/github-read";
import {
  biggestCommits,
  type ChooseCommits,
  type CommitSource,
  framingOf,
  isNoisePath,
  isSecretPath,
  MAX_LISTED_COMMITS,
  MAX_PATCH_FILES,
  type RawPatch,
  type UserCommit,
} from "@/domain/project-read";
import type { GithubAbout } from "@/domain/project-source";
import { estimateTokens } from "@/domain/prompts";
import type { CommitCounts, MergedPull, OwnedRepo } from "@/domain/repo-scan";
import { type GithubLink, githubLabel } from "@/shared/github-link";
import { readCommitEvidence } from "./commit-evidence";
import { type HttpClient, HttpError, MAX_BYTES } from "./http";

/**
 * Reading a GitHub repo or pull request for an add-on (decision 55). One interface, two readers:
 *
 * - public: unauthenticated REST through the polite `http.ts` client (timeouts, retries,
 *   Retry-After). Public repos only, and GitHub allows 60 such requests an hour.
 * - gh (`HB_GITHUB=gh`): `gh api ...` through `Bun.spawn` with an argv array and no shell. Before
 *   every read it asks gh which account is active (`gh api user --jq .login`) and refuses unless
 *   that is `HB_GITHUB_USER`. It never runs `gh auth ...`, never reads gh's config or token files
 *   and never changes gh's state: switching accounts is the user's job.
 *
 * Both run the same read over a `GithubTransport`, so what is read and the token cap are the same.
 *
 * Listing the user's own repos (decision 78) is gh only: `user/repos` lists the signed-in account,
 * and only gh is pinned to `HB_GITHUB_USER`. The public reader's `list` is null.
 */

// ---------- Errors ----------

export type GithubErrorKind = "not_found" | "rate_limited" | "account_mismatch" | "unavailable" | "too_large";

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  constructor({ kind, message }: { kind: GithubErrorKind; message: string }) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
  }
}

// ---------- Transports ----------

/** GET one REST path (`repos/o/r/readme`, no leading slash) and return the JSON body as text. */
export type GithubTransport = { get(path: string): Promise<string> };

const API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

/** The public transport: `https://api.github.com/<path>` through the shared HTTP client. */
export function createPublicTransport(http: HttpClient): GithubTransport {
  return {
    async get(path) {
      try {
        const res = await http.getText(`${API}/${path}`, { accept: ACCEPT });
        return res.body;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        if (err.kind === "status" && (err.status === 403 || err.status === 429)) {
          throw new GithubError({
            kind: "rate_limited",
            message:
              "GitHub's limit for reading without signing in (60 requests an hour) is used up. Wait an hour and read again, or set HB_GITHUB=gh to read through your own gh sign-in.",
          });
        }
        if (err.kind === "status" && err.status === 404) {
          throw new GithubError({ kind: "not_found", message: `GitHub has nothing at ${path}.` });
        }
        if (err.kind === "too_large") throw new GithubError({ kind: "too_large", message: err.message });
        throw new GithubError({ kind: "unavailable", message: `GitHub could not be read: ${err.message}` });
      }
    },
  };
}

/** The slice of `Bun.spawn` the gh transport uses, so tests can inject a fake gh. */
export type GhSpawn = (
  cmd: string[],
  options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; env: Record<string, string | undefined> },
) => {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

const defaultGhSpawn: GhSpawn = (cmd, options) => Bun.spawn(cmd, options);

export type GhOptions = {
  /** The gh binary, `gh` on PATH by default. */
  bin?: string;
  spawn?: GhSpawn;
  timeoutMs?: number;
};

/** The argv of a `gh api` GET. Every gh call this app makes is `gh api`; none is `gh auth`. */
export function ghApiArgs({ bin, path, jq }: { bin: string; path: string; jq?: string }): string[] {
  return [bin, "api", "--method", "GET", "-H", `Accept: ${ACCEPT}`, path, ...(jq ? ["--jq", jq] : [])];
}

function ghFailure({ stderr, exit }: { stderr: string; exit: number }): GithubError {
  const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? "");
  if (status === 403 || status === 429 || /rate limit/i.test(stderr)) {
    return new GithubError({
      kind: "rate_limited",
      message: "GitHub's rate limit for your gh account is used up. Wait for it to reset and read again.",
    });
  }
  if (status === 404) return new GithubError({ kind: "not_found", message: "GitHub has nothing there." });
  if (exit === 4 || status === 401) {
    return new GithubError({
      kind: "unavailable",
      message: "gh is not signed in. Sign in with gh yourself, then read again; rolecraft never signs gh in or out.",
    });
  }
  const line = stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  return new GithubError({ kind: "unavailable", message: `gh failed (exit ${exit})${line ? `: ${line}` : "."}` });
}

/** Run one `gh api` call. Exported for tests; the reader is the only other caller. */
export function createGhRunner({ bin = "gh", spawn = defaultGhSpawn, timeoutMs = 30_000 }: GhOptions = {}) {
  return async function gh({ path, jq }: { path: string; jq?: string }): Promise<string> {
    const argv = ghApiArgs({ bin, path, ...(jq ? { jq } : {}) });
    // The hard rule: never `gh auth` (token, switch, login, logout), whatever built the argv.
    if (argv.slice(1).some((a) => a === "auth")) {
      throw new GithubError({ kind: "unavailable", message: "Refusing to run a gh auth command." });
    }
    let proc: ReturnType<GhSpawn>;
    try {
      proc = spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // No prompts and no update check: gh must not wait on a terminal or write state.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      });
    } catch (err) {
      throw new GithubError({ kind: "unavailable", message: `gh could not start (${String(err)}). Is gh installed?` });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const result = await Promise.race([done, timedOut]);
      if (result === "timeout") {
        proc.kill();
        throw new GithubError({ kind: "unavailable", message: `gh took longer than ${timeoutMs / 1000}s.` });
      }
      const [stdout, stderr, exit] = result;
      if (exit !== 0) throw ghFailure({ stderr, exit });
      if (stdout.length > MAX_BYTES)
        throw new GithubError({ kind: "too_large", message: "GitHub's answer is over 2 MB." });
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The gh transport: `gh api <path>` for each GET. */
export function createGhTransport(gh: ReturnType<typeof createGhRunner>): GithubTransport {
  return { get: (path) => gh({ path }) };
}

// ---------- Responses (validated where they cross in) ----------

const Repo = z.object({
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  default_branch: z.string(),
  language: z.string().nullable().default(null),
  /** In KB. */
  size: z.number().nonnegative().default(0),
});
const TreeEntry = z.object({ path: z.string(), type: z.string() });
const Tree = z.object({ tree: z.array(TreeEntry), truncated: z.boolean().default(false) });
const ContentsList = z.array(TreeEntry.extend({ type: z.string() }));
const Content = z.object({
  path: z.string(),
  content: z.string().default(""),
  encoding: z.string().default("base64"),
});
const Commit = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({ date: z.string().nullable().default(null) })
      .nullable()
      .default(null),
  }),
  author: z.object({ login: z.string() }).nullable().default(null),
});
const CommitDetail = z.object({
  files: z
    .array(
      z.object({
        filename: z.string(),
        additions: z.number().default(0),
        deletions: z.number().default(0),
        /** Absent for binary files and very large diffs. */
        patch: z.string().optional(),
      }),
    )
    .default([]),
});
/** `contributors?anon=1`: accounts with a login, and emails no account claims with none. */
const Contributor = z.object({
  login: z.string().optional(),
  email: z.string().optional(),
  contributions: z.number().int().nonnegative(),
});
const Login = z.object({ login: z.string() }).nullable().default(null);
const Pull = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: Login,
  head: z.object({ sha: z.string() }),
  changed_files: z.number().int().nonnegative(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
});

/** A pull request's status from its `state` and `merged_at`. */
function pullStatus(pull: { state: "open" | "closed"; merged_at: string | null }): PullStatus {
  if (pull.merged_at !== null) return "merged";
  return pull.state;
}
const PullFile = z.object({ filename: z.string(), additions: z.number(), deletions: z.number() });
const Comment = z.object({ user: Login, body: z.string().nullable().default(null) });

/** The JSON body as `schema`'s type, or a GithubError naming `what`. */
function parse<T>(schema: z.ZodType<T>, body: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GithubError({ kind: "unavailable", message: `GitHub sent something other than JSON for ${what}.` });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GithubError({ kind: "unavailable", message: `GitHub's answer for ${what} was not the shape expected.` });
  }
  return parsed.data;
}

// ---------- The read ----------

/** Asked once per repo read, after the README and manifests: which files are worth reading. */
export type GithubPick = (input: {
  repo: string;
  description: string;
  tree: string[];
  already: string[];
}) => Promise<string[]>;

/** What the reader knows of a repo when it asks where its commits come from. */
export type RepoInfo = { owner: string; repo: string; branch: string; private: boolean; sizeKb: number };

/**
 * Where a repo read's commits and hunks come from (decision 81). The service picks a local clone,
 * a temp clone or the API; `api` is the reader's own, reading hunks for at most `maxPatchCommits`.
 */
export type OpenCommitSource = (
  input: RepoInfo & { api: (options: { maxPatchCommits: number }) => CommitSource },
) => Promise<CommitSource>;

export type GithubReadInput = {
  link: GithubLink;
  /** The GitHub account whose commits count as the user's. */
  user: string;
  pick: GithubPick;
  /** Picks the commits whose hunks are read; the biggest ones when absent. */
  choose?: ChooseCommits;
  /** Whether a commit email is the user's, for clones and the contributors' count. None when absent. */
  isMine?: (email: string) => boolean;
  /** The API, with no cap on hunks, when absent. */
  source?: OpenCommitSource;
  step?: (text: string) => Promise<void>;
};

export type GithubReaderMode = "public" | "gh" | "fixture";

export type GithubReader = {
  readonly mode: GithubReaderMode;
  /** `HB_GITHUB_USER`, when set. With gh it is required and is the only account gh may be. */
  readonly user: string | null;
  read(input: GithubReadInput): Promise<GithubBundle>;
  /** A repo's or pull request's name, visibility, description, language and README, to fill the add-on form (decision 80). */
  about(link: GithubLink): Promise<GithubAbout>;
  /**
   * The repos `user` owns, organizations' excluded (decision 78). gh lists private repos too; the
   * public reader lists `users/<login>/repos`, public only (decision 86).
   */
  list(input: { user: string }): Promise<OwnedRepo[]>;
  /** `user`'s commits and everyone's on the default branch, one call; null when GitHub gives no list. */
  commitCounts(input: { owner: string; repo: string; user: string }): Promise<CommitCounts | null>;
  /** Core API calls left this hour, or null when no small limit applies (gh). Costs no call. */
  rateBudget(): Promise<number | null>;
  /** `user`'s merged pull requests in other people's public repos: one search call. */
  mergedPulls(input: { user: string }): Promise<MergedPull[]>;
  /** A pull request's changed lines, additions plus deletions: one call. */
  pullLines(input: { owner: string; repo: string; number: number }): Promise<number>;
};

// ---------- Listing owned repos ----------

/** At most this many pages of 100 repos per listing. */
export const MAX_REPO_PAGES = 3;

const ListedRepo = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean().default(false),
  size: z.number().nonnegative(),
  language: z.string().nullable().default(null),
  stargazers_count: z.number().int().nonnegative().default(0),
  pushed_at: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});

/**
 * An account's own repos, newest push first, 100 a page, up to `MAX_REPO_PAGES` pages. Signed in
 * (`signedIn`, gh): `user/repos?affiliation=owner`, private ones included. Otherwise
 * `users/<login>/repos?type=owner`, which GitHub answers with public repos only. Repos owned by
 * anyone but `user` are dropped as a second guard.
 */
export async function listOwnedRepos({
  get,
  user,
  signedIn = true,
}: {
  get: GithubTransport["get"];
  user: string;
  signedIn?: boolean;
}): Promise<OwnedRepo[]> {
  const repos: OwnedRepo[] = [];
  const listing = signedIn ? "user/repos?affiliation=owner" : `users/${encodeURIComponent(user)}/repos?type=owner`;
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const body = await get(`${listing}&sort=pushed&per_page=100&page=${page}`);
    const listed = parse(z.array(ListedRepo), body, "your repos");
    for (const r of listed) {
      if (r.owner.login.toLowerCase() !== user.toLowerCase()) continue;
      repos.push({
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        sizeKb: r.size,
        language: r.language,
        stars: r.stargazers_count,
        pushedAt: r.pushed_at,
        description: r.description,
      });
    }
    if (listed.length < 100) break;
  }
  return repos;
}

/**
 * `user`'s commits and everyone's, from `contributors?anon=1` (one page of 100). Emails no account
 * claims count as `user`'s when `isMine` says so. An empty repo (204, no body) is 0 of 0.
 */
async function contributorCounts({
  get,
  base,
  user,
  isMine = () => false,
}: {
  get: GithubTransport["get"];
  base: string;
  user: string;
  isMine?: (email: string) => boolean;
}): Promise<CommitCounts | null> {
  const body = await get(`${base}/contributors?anon=1&per_page=100`);
  if (body.trim() === "") return { own: 0, total: 0 };
  // GitHub sends `{}` while it is still computing a list; that repo is not counted.
  const people = parse(z.union([z.array(Contributor), z.object({})]), body, "contributors");
  if (!Array.isArray(people)) return null;
  const me = user.toLowerCase();
  const own = people
    .filter((p) => p.login?.toLowerCase() === me || (p.login === undefined && p.email && isMine(p.email)))
    .reduce((n, p) => n + p.contributions, 0);
  const total = people.reduce((n, p) => n + p.contributions, 0);
  return { own: Math.min(own, total), total };
}

const RateLimit = z.object({ resources: z.object({ core: z.object({ remaining: z.number().int() }) }) });

const SearchedPull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  repository_url: z.string(),
  closed_at: z.string().nullable().default(null),
  pull_request: z.object({ merged_at: z.string().nullable().default(null) }).optional(),
});
const PullSearch = z.object({ items: z.array(SearchedPull) });
const PullSize = z.object({ additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });

/**
 * The search query for `user`'s merged pull requests in repos they don't own. `is:public` is always
 * in it, through gh too, so an employer's private repo never shows up (decision 86).
 */
export const mergedPullsQuery = (user: string) => `type:pr is:merged is:public author:${user} -user:${user}`;

const repoPath = ({ owner, repo }: { owner: string; repo: string }) =>
  `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const contentPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function optional<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // A missing README, an empty repo (409) or an oversized file is not a failed read.
    if (err instanceof GithubError && (err.kind === "not_found" || err.kind === "too_large")) return fallback;
    throw err;
  }
}

function decodeContent(content: z.infer<typeof Content>): string | null {
  if (content.encoding !== "base64") return null;
  const text = Buffer.from(content.content, "base64").toString("utf8");
  return text.includes("\u0000") ? null : text;
}

/** The fallback commit choice: the biggest commits, no features. */
const biggestChoice: ChooseCommits = async ({ commits }) => ({ features: [], shas: biggestCommits({ commits }) });

/** Like `optional`, but any failure other than a used-up rate limit gives the fallback. */
async function soft<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GithubError && err.kind !== "rate_limited") return fallback;
    throw err;
  }
}

function subject(message: string): string {
  return (message.split("\n")[0] ?? "").trim().slice(0, 200);
}

/** Shallow paths first, so a cut tree still shows the top of the repo. */
function byDepth(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

/** Lines that fit `max` tokens of the budget, whole lines only. */
function takeLines(budget: TokenBudget, lines: readonly string[], max: number): string[] {
  const cut = budget.take(lines.join("\n"), max);
  if (!cut) return [];
  const shown = cut.text.split("\n");
  return cut.truncated ? shown.slice(0, -1) : shown;
}

export function createReader({
  mode,
  user,
  transport,
  beforeRead = async () => {},
}: {
  mode: GithubReaderMode;
  user: string | null;
  transport: GithubTransport;
  /** Runs before the first call of every read; the gh reader checks the account here. */
  beforeRead?: () => Promise<void>;
}): GithubReader {
  const get = transport.get;

  async function meta(link: GithubLink) {
    try {
      return parse(Repo, await get(repoPath(link)), "the repo");
    } catch (err) {
      if (err instanceof GithubError && err.kind === "not_found") {
        const hint =
          mode === "public"
            ? " If it is private, set HB_GITHUB=gh so it is read through your own gh sign-in."
            : " Check the link, and that your gh account can see it.";
        throw new GithubError({ kind: "not_found", message: `github.com/${githubLabel(link)} was not found.${hint}` });
      }
      throw err;
    }
  }

  async function file(base: string, path: string, ref: string): Promise<string | null> {
    const raw = await get(`${base}/contents/${contentPath(path)}?ref=${encodeURIComponent(ref)}`);
    return decodeContent(parse(Content, raw, path));
  }

  async function treePaths(base: string, branch: string): Promise<string[]> {
    const paths = await optional(async () => {
      const tree = parse(Tree, await get(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`), "the tree");
      return tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
    }, null);
    if (paths) return paths;
    // Too large for one answer (or no branch yet): the top level is still a useful tree.
    const top = await optional(async () => parse(ContentsList, await get(`${base}/contents`), "the tree"), []);
    return top.filter((e) => e.type === "file").map((e) => e.path);
  }

  async function readRepo(input: GithubReadInput & { link: { kind: "repo" } }): Promise<RepoBundle> {
    const step = input.step ?? (async () => {});
    const info = await meta(input.link);
    const [owner = input.link.owner, repo = input.link.repo] = info.full_name.split("/");
    const base = repoPath({ owner, repo });
    const branch = info.default_branch;
    const budget = createTokenBudget(GITHUB_TOKEN_CAP);
    const files: GithubFile[] = [];
    const description = budget.take(info.description ?? "", 200)?.text ?? "";

    await step(`Reading the file tree of ${owner}/${repo}`);
    const all = (await treePaths(base, branch)).sort(byDepth);
    const tree = takeLines(budget, all, GITHUB_SECTION_TOKENS.tree);

    await step("Reading the README and manifests");
    const readme = await optional(async () => parse(Content, await get(`${base}/readme`), "the README"), null);
    const readmeText = readme ? decodeContent(readme) : null;
    if (readme && readmeText !== null) {
      const cut = budget.take(readmeText, GITHUB_SECTION_TOKENS.readme);
      if (cut) files.push({ path: readme.path, ...cut });
    }
    let manifestLeft = GITHUB_SECTION_TOKENS.manifests;
    for (const path of manifestPaths(all)) {
      if (manifestLeft <= 0) break;
      const text = await optional(() => file(base, path, branch), null);
      if (text === null) continue;
      const cut = budget.take(text, Math.min(GITHUB_SECTION_TOKENS.manifest, manifestLeft));
      if (!cut) break;
      manifestLeft -= estimateTokens(cut.text);
      files.push({ path, ...cut });
    }

    const isMine = input.isMine ?? (() => false);
    const api = ({ maxPatchCommits }: { maxPatchCommits: number }) =>
      apiCommitSource({ base, branch, user: input.user, isMine, maxPatchCommits });
    const repoInfo: RepoInfo = { owner, repo, branch, private: info.private, sizeKb: info.size };
    const source = input.source
      ? await input.source({ ...repoInfo, api })
      : api({ maxPatchCommits: Number.POSITIVE_INFINITY });
    let evidence: Awaited<ReturnType<typeof readCommitEvidence>>;
    try {
      evidence = await readCommitEvidence({
        source,
        choose: input.choose ?? biggestChoice,
        name: `${owner}/${repo}`,
        user: input.user,
        readme: readmeText,
        budget,
        step,
      });
    } finally {
      await source.close?.();
    }
    const { commits, share, features, patches, pushed } = evidence;

    if (budget.left() >= MIN_FILE_TOKENS) {
      await step("Choosing files to read");
      const picks = validatePicks({
        picks: await input.pick({
          repo: `${owner}/${repo}`,
          description,
          tree,
          already: files.map((f) => f.path),
        }),
        tree,
        read: files.map((f) => f.path),
      });
      for (const path of picks) {
        if (budget.left() < MIN_FILE_TOKENS) break;
        await step(`Reading ${path}`);
        const text = await optional(() => file(base, path, branch), null);
        if (text === null) continue;
        const cut = budget.take(text, GITHUB_SECTION_TOKENS.file);
        if (!cut) break;
        files.push({ path, ...cut });
      }
    }

    return {
      kind: "repo",
      owner,
      repo,
      user: input.user,
      private: info.private,
      description,
      at: branch,
      files,
      tree,
      treeTotal: all.length,
      commits,
      tokens: GITHUB_TOKEN_CAP - budget.left(),
      // Counted commits decide; a repo whose commits can't be counted falls back to its owner.
      framing:
        share && share.total > 0
          ? framingOf(share)
          : owner.toLowerCase() === input.user.toLowerCase()
            ? "own"
            : "contribution",
      share: share && share.total > 0 ? share : null,
      features,
      patches,
      pushed,
      commitsFrom: source.from,
    };
  }

  /** The user's commits from `commits?author=`, hunks from `commits/<sha>`, the share from `contributors`. */
  function apiCommitSource({
    base,
    branch,
    user,
    isMine,
    maxPatchCommits,
  }: {
    base: string;
    branch: string;
    user: string;
    isMine: (email: string) => boolean;
    maxPatchCommits: number;
  }): CommitSource {
    return {
      from: "api",
      maxPatchCommits,
      async list() {
        const path = `${base}/commits?author=${encodeURIComponent(user)}&per_page=100&sha=${encodeURIComponent(branch)}`;
        const listed = await optional(async () => parse(z.array(Commit), await get(path), "the commits"), []);
        const mine: UserCommit[] = listed.slice(0, MAX_LISTED_COMMITS).map((c) => ({
          sha: c.sha,
          subject: subject(c.commit.message),
          date: c.commit.author?.date ?? null,
          files: [],
          sized: false,
        }));
        const counts = await soft(() => contributorCounts({ get, base, user, isMine }), null);
        return { mine, share: counts && { mine: counts.own, total: counts.total } };
      },
      async patches(commits, step) {
        const out: RawPatch[] = [];
        for (const commit of commits) {
          await step(`Reading the changes in ${commit.sha.slice(0, 7)} ${commit.subject}`.slice(0, 120));
          const detail = await soft(
            async () => parse(CommitDetail, await get(`${base}/commits/${encodeURIComponent(commit.sha)}`), "a commit"),
            null,
          );
          if (!detail) continue;
          const files = detail.files
            .filter((f) => f.patch && !isSecretPath(f.filename) && !isNoisePath(f.filename))
            .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
            .slice(0, MAX_PATCH_FILES)
            .map((f) => ({ path: f.filename, patch: f.patch ?? "" }));
          out.push({ sha: commit.sha, files });
        }
        return out;
      },
    };
  }

  async function readPull(input: GithubReadInput & { link: { kind: "pull"; number: number } }): Promise<PullBundle> {
    const step = input.step ?? (async () => {});
    const info = await meta(input.link);
    const [owner = input.link.owner, repo = input.link.repo] = info.full_name.split("/");
    const base = `${repoPath({ owner, repo })}`;
    const n = input.link.number;
    const budget = createTokenBudget(GITHUB_TOKEN_CAP);

    await step(`Reading pull request #${n}`);
    let pull: z.infer<typeof Pull>;
    try {
      pull = parse(Pull, await get(`${base}/pulls/${n}`), "the pull request");
    } catch (err) {
      if (err instanceof GithubError && err.kind === "not_found") {
        throw new GithubError({ kind: "not_found", message: `Pull request #${n} of ${owner}/${repo} was not found.` });
      }
      throw err;
    }
    const description = budget.take(info.description ?? "", 200)?.text ?? "";
    const title = budget.take(pull.title, 100)?.text ?? "";
    const body = budget.take(pull.body ?? "", GITHUB_SECTION_TOKENS.pullText)?.text ?? "";

    await step("Reading the changed files");
    const files = await optional(
      async () => parse(z.array(PullFile), await get(`${base}/pulls/${n}/files?per_page=100`), "the files"),
      [],
    );
    const changedLines = takeLines(
      budget,
      files.map((f) => `${f.filename} +${f.additions} -${f.deletions}`),
      GITHUB_SECTION_TOKENS.diffStat,
    );
    const changed = files.slice(0, changedLines.length).map((f) => ({
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
    }));

    await step(`Reading ${input.user}'s commits on it`);
    const all = await optional(
      async () => parse(z.array(Commit), await get(`${base}/pulls/${n}/commits?per_page=100`), "the commits"),
      [],
    );
    const mine = all.filter((c) => c.author?.login.toLowerCase() === input.user.toLowerCase()).reverse();
    const commits: GithubCommit[] = [];
    let commitLeft = GITHUB_SECTION_TOKENS.commits;
    for (const c of mine.slice(0, MAX_GITHUB_COMMITS)) {
      const line = `${c.sha.slice(0, 12)} ${subject(c.commit.message)}`;
      const cost = estimateTokens(line);
      if (cost > commitLeft || cost > budget.left()) break;
      budget.take(line, cost);
      commitLeft -= cost;
      commits.push({ sha: c.sha, subject: subject(c.commit.message) });
    }

    await step("Reading the review discussion");
    const lists = await Promise.all(
      [`issues/${n}/comments`, `pulls/${n}/comments`, `pulls/${n}/reviews`].map((p) =>
        optional(async () => parse(z.array(Comment), await get(`${base}/${p}?per_page=100`), "the discussion"), []),
      ),
    );
    const discussion: GithubComment[] = [];
    let talkLeft = GITHUB_SECTION_TOKENS.discussion;
    for (const c of lists.flat()) {
      const text = (c.body ?? "").trim();
      if (!text) continue;
      const cut = budget.take(text, Math.min(300, talkLeft));
      if (!cut) break;
      talkLeft -= estimateTokens(cut.text);
      discussion.push({ author: c.user?.login ?? "someone", body: cut.text });
      if (talkLeft <= 0) break;
    }

    return {
      kind: "pull",
      owner,
      repo,
      number: n,
      status: pullStatus(pull),
      user: input.user,
      private: info.private,
      description,
      at: pull.head.sha,
      title,
      body,
      author: pull.user?.login ?? "someone",
      changed,
      changedTotal: Math.max(pull.changed_files, files.length),
      commits,
      discussion,
      tokens: GITHUB_TOKEN_CAP - budget.left(),
      framing: "contribution",
      share: null,
      features: [],
      patches: [],
    };
  }

  /** At most this much README text is kept: the form only takes its first paragraph. */
  const ABOUT_README_CHARS = 16_000;

  async function about(link: GithubLink): Promise<GithubAbout> {
    const info = await meta(link);
    const [owner = link.owner, repo = link.repo] = info.full_name.split("/");
    const base = repoPath({ owner, repo });
    let pull: GithubAbout["pull"] = null;
    if (link.kind === "pull") {
      try {
        const p = parse(Pull, await get(`${base}/pulls/${link.number}`), "the pull request");
        pull = { number: link.number, title: p.title, body: p.body?.slice(0, ABOUT_README_CHARS) ?? null };
      } catch (err) {
        if (err instanceof GithubError && err.kind === "not_found") {
          throw new GithubError({
            kind: "not_found",
            message: `Pull request #${link.number} of ${owner}/${repo} was not found.`,
          });
        }
        throw err;
      }
    }
    const readme =
      link.kind === "repo"
        ? await optional(async () => parse(Content, await get(`${base}/readme`), "the README"), null)
        : null;
    return {
      owner,
      repo,
      private: info.private,
      description: info.description,
      language: info.language,
      readme: readme ? (decodeContent(readme)?.slice(0, ABOUT_README_CHARS) ?? null) : null,
      pull,
    };
  }

  return {
    mode,
    user,
    async read(input) {
      await beforeRead();
      const { link } = input;
      return link.kind === "pull" ? readPull({ ...input, link }) : readRepo({ ...input, link });
    },
    async about(link) {
      await beforeRead();
      return about(link);
    },
    async list({ user: owner }) {
      return listOwnedRepos({ get, user: owner, signedIn: mode !== "public" });
    },
    commitCounts({ owner, repo, user: who }) {
      return contributorCounts({ get, base: repoPath({ owner, repo }), user: who });
    },
    async rateBudget() {
      if (mode === "gh") return null;
      return parse(RateLimit, await get("rate_limit"), "the rate limit").resources.core.remaining;
    },
    async mergedPulls({ user: who }) {
      const q = encodeURIComponent(mergedPullsQuery(who));
      const found = parse(PullSearch, await get(`search/issues?q=${q}&per_page=100`), "the pull request search");
      return found.items.flatMap((item): MergedPull[] => {
        const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url);
        const mergedAt = item.pull_request?.merged_at ?? item.closed_at;
        if (!match?.[1] || !match[2] || !mergedAt) return [];
        return [{ owner: match[1], repo: match[2], number: item.number, title: item.title, mergedAt }];
      });
    },
    async pullLines({ owner, repo, number }) {
      const size = parse(PullSize, await get(`${repoPath({ owner, repo })}/pulls/${number}`), "a pull request");
      return size.additions + size.deletions;
    },
  };
}

/** Unauthenticated REST: public repos only. */
export function createPublicReader({ http, user }: { http: HttpClient; user: string | null }): GithubReader {
  return createReader({ mode: "public", user, transport: createPublicTransport(http) });
}

/** The active gh account, from `gh api user --jq .login`. */
export async function ghLogin(gh: ReturnType<typeof createGhRunner>): Promise<string> {
  return (await gh({ path: "user", jq: ".login" })).trim();
}

/**
 * `gh api` with the account check before every read. `user` is `HB_GITHUB_USER`; a read while gh
 * is signed in as anyone else is refused, naming both accounts.
 */
export function createGhReader({ user, ...options }: GhOptions & { user: string }): GithubReader {
  const gh = createGhRunner(options);
  const transport = createGhTransport(gh);
  async function checkAccount() {
    const login = await ghLogin(gh);
    if (login.toLowerCase() !== user.toLowerCase()) {
      throw new GithubError({
        kind: "account_mismatch",
        message: `gh is signed in as "${login || "nobody"}", but HB_GITHUB_USER is "${user}". Switch gh to ${user} yourself (rolecraft never changes gh's account), or change HB_GITHUB_USER.`,
      });
    }
  }
  const reader = createReader({ mode: "gh", user, transport, beforeRead: checkAccount });
  return {
    ...reader,
    // gh lists and searches only as HB_GITHUB_USER, whatever account the caller names.
    async list() {
      await checkAccount();
      return listOwnedRepos({ get: transport.get, user });
    },
    async mergedPulls() {
      await checkAccount();
      return reader.mergedPulls({ user });
    },
  };
}
