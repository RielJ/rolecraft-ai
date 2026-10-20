import { z } from "zod";
import { type GithubLink, githubLabel } from "@/domain/github-link";
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
  type RepoBundle,
  type TokenBudget,
  validatePicks,
} from "@/domain/github-read";
import { estimateTokens } from "@/domain/prompts";
import type { OwnedRepo } from "@/domain/repo-scan";
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
      message: "gh is not signed in. Sign in with gh yourself, then read again; hanapbuhay never signs gh in or out.",
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
  commit: z.object({ message: z.string() }),
  author: z.object({ login: z.string() }).nullable().default(null),
});
const Login = z.object({ login: z.string() }).nullable().default(null);
const Pull = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: Login,
  head: z.object({ sha: z.string() }),
  changed_files: z.number().int().nonnegative(),
});
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

export type GithubReadInput = {
  link: GithubLink;
  /** The GitHub account whose commits count as the user's. */
  user: string;
  pick: GithubPick;
  step?: (text: string) => Promise<void>;
};

export type GithubReaderMode = "public" | "gh" | "fixture";

export type GithubReader = {
  readonly mode: GithubReaderMode;
  /** `HB_GITHUB_USER`, when set. With gh it is required and is the only account gh may be. */
  readonly user: string | null;
  read(input: GithubReadInput): Promise<GithubBundle>;
  /** The repos `user` owns, organizations' excluded (decision 78). Null when this reader can't list. */
  readonly list: ((input: { user: string }) => Promise<OwnedRepo[]>) | null;
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
 * The signed-in account's own repos: `user/repos?affiliation=owner`, newest push first, 100 a page,
 * up to `MAX_REPO_PAGES` pages. Repos owned by anyone but `user` are dropped as a second guard.
 */
export async function listOwnedRepos({
  get,
  user,
}: {
  get: GithubTransport["get"];
  user: string;
}): Promise<OwnedRepo[]> {
  const repos: OwnedRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const body = await get(`user/repos?affiliation=owner&sort=pushed&per_page=100&page=${page}`);
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

    await step(`Reading ${input.user}'s commits`);
    const commits = await readCommits(
      `${base}/commits?author=${encodeURIComponent(input.user)}&per_page=${MAX_GITHUB_COMMITS}&sha=${encodeURIComponent(branch)}`,
      budget,
    );

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
    };
  }

  async function readCommits(path: string, budget: TokenBudget): Promise<GithubCommit[]> {
    const list = await optional(async () => parse(z.array(Commit), await get(path), "the commits"), []);
    const commits: GithubCommit[] = [];
    let left = GITHUB_SECTION_TOKENS.commits;
    for (const c of list.slice(0, MAX_GITHUB_COMMITS)) {
      const line = `${c.sha.slice(0, 12)} ${subject(c.commit.message)}`;
      const cost = estimateTokens(line);
      if (cost > left || cost > budget.left()) break;
      budget.take(line, cost);
      left -= cost;
      commits.push({ sha: c.sha, subject: subject(c.commit.message) });
    }
    return commits;
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
    list: null,
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
        message: `gh is signed in as "${login || "nobody"}", but HB_GITHUB_USER is "${user}". Switch gh to ${user} yourself (hanapbuhay never changes gh's account), or change HB_GITHUB_USER.`,
      });
    }
  }
  return {
    ...createReader({ mode: "gh", user, transport, beforeRead: checkAccount }),
    // gh lists only as HB_GITHUB_USER, whatever account the caller names.
    async list() {
      await checkAccount();
      return listOwnedRepos({ get: transport.get, user });
    },
  };
}
