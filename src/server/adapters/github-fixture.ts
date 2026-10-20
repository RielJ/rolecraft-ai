import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OwnedRepo } from "@/domain/repo-scan";
import { createReader, GithubError, type GithubReader, type GithubTransport } from "./github";

/**
 * Recorded repos instead of GitHub (`HB_GITHUB=fixture`, and the eval). A snapshot holds a repo's
 * files, commits and pull requests in plain JSON; the transport answers the REST paths the reader
 * asks for from it, so the real read (token cap, picks, commit filter) runs unchanged.
 */

const FixtureCommit = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  message: z.string(),
  author: z.string(),
  date: z.string().nullable().default(null),
  /** What `commits/<sha>` reports (decision 81); `patch` is the hunks, from the first `@@`. */
  files: z
    .array(z.object({ path: z.string(), additions: z.number(), deletions: z.number(), patch: z.string().optional() }))
    .default([]),
});
const FixtureComment = z.object({ author: z.string(), body: z.string() });

export const GithubSnapshot = z.object({
  owner: z.string(),
  repo: z.string(),
  private: z.boolean().default(false),
  description: z.string().nullable().default(null),
  defaultBranch: z.string().default("main"),
  /** What the owned-repos listing reports (decision 78). */
  fork: z.boolean().default(false),
  archived: z.boolean().default(false),
  sizeKb: z.number().nonnegative().default(100),
  language: z.string().nullable().default(null),
  stars: z.number().int().nonnegative().default(0),
  pushedAt: z.string().nullable().default(null),
  /** Path to text. Every path is in the tree. */
  files: z.record(z.string(), z.string()),
  /** Newest first, like the commits API. */
  commits: z.array(FixtureCommit).default([]),
  pulls: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string().nullable().default(null),
        author: z.string(),
        headSha: z.string(),
        status: z.enum(["merged", "open", "closed"]).default("merged"),
        mergedAt: z.string().default("2026-01-01T00:00:00Z"),
        files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
        commits: z.array(FixtureCommit).default([]),
        comments: z.array(FixtureComment).default([]),
        reviewComments: z.array(FixtureComment).default([]),
        reviews: z.array(FixtureComment).default([]),
      }),
    )
    .default([]),
});
export type GithubSnapshot = z.infer<typeof GithubSnapshot>;
/** A snapshot as written, before defaults. */
export type GithubSnapshotInput = z.input<typeof GithubSnapshot>;

const notFound = () => new GithubError({ kind: "not_found", message: "Not in the fixtures." });
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const commitJson = (c: z.infer<typeof FixtureCommit>) => ({
  sha: c.sha,
  commit: { message: c.message, author: { date: c.date } },
  author: { login: c.author },
});
const commentJson = (c: z.infer<typeof FixtureComment>) => ({ user: { login: c.author }, body: c.body });

/** A JSON value, as the REST API would send it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function answer(snapshot: GithubSnapshot, rest: string, query: URLSearchParams): Json {
  const paths = Object.keys(snapshot.files);
  if (rest === "") {
    return {
      full_name: `${snapshot.owner}/${snapshot.repo}`,
      private: snapshot.private,
      description: snapshot.description,
      default_branch: snapshot.defaultBranch,
      language: snapshot.language,
      size: snapshot.sizeKb,
    };
  }
  if (rest.startsWith("git/trees/")) return { tree: paths.map((path) => ({ path, type: "blob" })), truncated: false };
  if (rest === "contents") return paths.filter((p) => !p.includes("/")).map((path) => ({ path, type: "file" }));
  if (rest === "readme") {
    const path = paths.find((p) => /^readme(\.[a-z]+)?$/i.test(p));
    if (path === undefined) throw notFound();
    return { path, content: base64(snapshot.files[path] ?? ""), encoding: "base64" };
  }
  if (rest.startsWith("contents/")) {
    const path = rest.slice("contents/".length).split("/").map(decodeURIComponent).join("/");
    const text = snapshot.files[path];
    if (text === undefined) throw notFound();
    return { path, content: base64(text), encoding: "base64" };
  }
  if (rest === "commits") {
    const author = query.get("author")?.toLowerCase();
    const perPage = Number(query.get("per_page") ?? "30");
    return snapshot.commits
      .filter((c) => author === undefined || c.author.toLowerCase() === author)
      .slice(0, perPage)
      .map(commitJson);
  }
  if (rest.startsWith("commits/")) {
    const sha = rest.slice("commits/".length);
    const commit = snapshot.commits.find((c) => c.sha === sha);
    if (!commit) throw notFound();
    return {
      ...commitJson(commit),
      files: commit.files.map((f) => ({
        filename: f.path,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch === undefined ? {} : { patch: f.patch }),
      })),
    };
  }
  if (rest === "contributors") {
    const counts = new Map<string, number>();
    for (const c of snapshot.commits) counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
    return [...counts].map(([login, contributions]) => ({ login, contributions }));
  }
  const pullMatch = /^(pulls|issues)\/(\d+)(?:\/(.*))?$/.exec(rest);
  const pull = snapshot.pulls.find((p) => p.number === Number(pullMatch?.[2]));
  if (!pullMatch || !pull) throw notFound();
  const [, area, , sub = ""] = pullMatch;
  if (area === "issues") {
    if (sub === "comments") return pull.comments.map(commentJson);
    throw notFound();
  }
  switch (sub) {
    case "":
      return {
        title: pull.title,
        body: pull.body,
        user: { login: pull.author },
        head: { sha: pull.headSha },
        changed_files: pull.files.length,
        state: pull.status === "open" ? "open" : "closed",
        merged_at: pull.status === "merged" ? pull.mergedAt : null,
        additions: pull.files.reduce((n, f) => n + f.additions, 0),
        deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
      };
    case "files":
      return pull.files.map((f) => ({ filename: f.path, additions: f.additions, deletions: f.deletions }));
    case "commits":
      return pull.commits.toReversed().map(commitJson);
    case "comments":
      return pull.reviewComments.map(commentJson);
    case "reviews":
      return pull.reviews.map(commentJson);
    default:
      throw notFound();
  }
}

const listedJson = (s: GithubSnapshot): Json => ({
  name: s.repo,
  owner: { login: s.owner },
  private: s.private,
  fork: s.fork,
  archived: s.archived,
  size: s.sizeKb,
  language: s.language,
  stargazers_count: s.stars,
  pushed_at: s.pushedAt,
  description: s.description,
});

/** The calls that aren't about one repo: listings, the rate limit, the pull request search. */
function answerAccount({
  parsed,
  url,
  remaining,
}: {
  parsed: readonly GithubSnapshot[];
  url: URL;
  remaining: number;
}): Json | undefined {
  const page = Number(url.searchParams.get("page") ?? "1");
  const owns = (login: string) => parsed.filter((s) => s.owner.toLowerCase() === login.toLowerCase());
  if (url.pathname === "/rate_limit") return { resources: { core: { remaining } } };
  // The signed-in account: every repo the snapshots give the first owner listed in `user/repos`.
  if (url.pathname === "/user/repos") return page === 1 ? owns(parsed[0]?.owner ?? "").map(listedJson) : [];
  const users = /^\/users\/([^/]+)\/repos$/.exec(url.pathname);
  if (users?.[1]) {
    return page === 1
      ? owns(decodeURIComponent(users[1]))
          .filter((s) => !s.private)
          .map(listedJson)
      : [];
  }
  if (url.pathname === "/search/issues") {
    const q = url.searchParams.get("q") ?? "";
    const author = /author:(\S+)/.exec(q)?.[1]?.toLowerCase() ?? "";
    return {
      items: parsed
        .filter((s) => !s.private && s.owner.toLowerCase() !== author)
        .flatMap((s) =>
          s.pulls
            .filter((p) => p.status === "merged" && p.author.toLowerCase() === author)
            .map((p) => ({
              number: p.number,
              title: p.title,
              repository_url: `https://api.github.com/repos/${s.owner}/${s.repo}`,
              closed_at: p.mergedAt,
              pull_request: { merged_at: p.mergedAt },
            })),
        ),
    };
  }
  return undefined;
}

/**
 * A transport over snapshots. `log`, when given, gets every path asked for, so tests can prove
 * what was (and was not) read. `remaining` is what `rate_limit` reports.
 */
export function createFixtureTransport({
  snapshots,
  log,
  remaining = 5000,
}: {
  snapshots: readonly GithubSnapshotInput[];
  log?: string[];
  remaining?: number;
}): GithubTransport {
  const parsed = snapshots.map((s) => GithubSnapshot.parse(s));
  return {
    async get(path) {
      await Promise.resolve();
      log?.push(path);
      const url = new URL(path, "https://api.github.invalid/");
      const account = answerAccount({ parsed, url, remaining });
      if (account !== undefined) return JSON.stringify(account);
      const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!match) throw notFound();
      const [, owner = "", repo = "", rest = ""] = match;
      const snapshot = parsed.find(
        (s) =>
          s.owner.toLowerCase() === decodeURIComponent(owner).toLowerCase() &&
          s.repo.toLowerCase() === decodeURIComponent(repo).toLowerCase(),
      );
      if (!snapshot) throw notFound();
      return JSON.stringify(answer(snapshot, rest, url.searchParams));
    },
  };
}

/** Every `*.json` snapshot in `dir`. */
export async function loadSnapshots(dir: string): Promise<GithubSnapshot[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(names.map(async (n) => GithubSnapshot.parse(await Bun.file(join(dir, n)).json())));
}

/** The snapshots `user` owns, as the owned-repos listing would report them. */
export function ownedSnapshots({
  snapshots,
  user,
}: {
  snapshots: readonly GithubSnapshot[];
  user: string;
}): OwnedRepo[] {
  return snapshots
    .filter((s) => s.owner.toLowerCase() === user.toLowerCase())
    .map((s) => ({
      owner: s.owner,
      name: s.repo,
      private: s.private,
      fork: s.fork,
      archived: s.archived,
      sizeKb: s.sizeKb,
      language: s.language,
      stars: s.stars,
      pushedAt: s.pushedAt,
      description: s.description,
    }));
}

/** The reader over the snapshots in `dir`, loaded on each call so edits show up without a restart. */
export function createFixtureReader({ dir, user }: { dir: string; user: string | null }): GithubReader {
  const fresh = async () =>
    createReader({ mode: "fixture", user, transport: createFixtureTransport({ snapshots: await loadSnapshots(dir) }) });
  return {
    mode: "fixture",
    user,
    read: async (input) => (await fresh()).read(input),
    about: async (link) => (await fresh()).about(link),
    async list({ user: owner }) {
      return ownedSnapshots({ snapshots: await loadSnapshots(dir), user: owner });
    },
    commitCounts: async (input) => (await fresh()).commitCounts(input),
    rateBudget: async () => (await fresh()).rateBudget(),
    mergedPulls: async (input) => (await fresh()).mergedPulls(input),
    pullLines: async (input) => (await fresh()).pullLines(input),
  };
}
