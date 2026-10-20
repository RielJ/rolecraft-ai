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

const FixtureCommit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), message: z.string(), author: z.string() });
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
  commit: { message: c.message },
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

/**
 * A transport over snapshots. `log`, when given, gets every path asked for, so tests can prove
 * what was (and was not) read.
 */
export function createFixtureTransport({
  snapshots,
  log,
}: {
  snapshots: readonly GithubSnapshotInput[];
  log?: string[];
}): GithubTransport {
  const parsed = snapshots.map((s) => GithubSnapshot.parse(s));
  return {
    async get(path) {
      await Promise.resolve();
      log?.push(path);
      const url = new URL(path, "https://api.github.invalid/");
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

/** The reader over the snapshots in `dir`, loaded on each read so edits show up without a restart. */
export function createFixtureReader({ dir, user }: { dir: string; user: string | null }): GithubReader {
  return {
    mode: "fixture",
    user,
    async read(input) {
      const transport = createFixtureTransport({ snapshots: await loadSnapshots(dir) });
      return createReader({ mode: "fixture", user, transport }).read(input);
    },
    async list({ user: owner }) {
      return ownedSnapshots({ snapshots: await loadSnapshots(dir), user: owner });
    },
  };
}
