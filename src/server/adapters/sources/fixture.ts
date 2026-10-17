import { join } from "node:path";
import { createHttpClient, type FetchFn } from "../http";
import { createSourceAdapters } from "./index";
import type { SourceAdapters } from "./types";

/**
 * The real adapters reading fixture files instead of the network (`HB_SOURCES=fixture`), for
 * Playwright and local demos. Paths under `dir` (a board exists if its file does):
 *   jobicy/remote-jobs.json, himalayas/jobs.json, remoteok/api.json,
 *   weworkremotely/remote-jobs.rss, remotive/remote-jobs.json      the built-in feeds
 *   greenhouse/<board>.json        the board's `/jobs?content=true` payload
 *   lever/<board>.json, ashby/<board>.json, recruitee/<board>.json, workable/<board>.json
 *   smartrecruiters/<board>.json   the postings list; smartrecruiters/<board>/<id>.json each detail
 * Board slugs are matched in lower case. Anything else answers 404.
 */
export function createFixtureSources({ dir }: { dir: string }): SourceAdapters {
  const fetch: FetchFn = async (input) => {
    const url = URL.parse(input);
    if (!url) return new Response("bad url", { status: 400 });
    const file = fixtureFile({ host: url.hostname.toLowerCase(), path: url.pathname });
    if (file === null) return new Response("not found", { status: 404 });
    const body = Bun.file(join(dir, file.path));
    if (!(await body.exists())) return new Response("not found", { status: 404 });
    const headers = { "Content-Type": file.path.endsWith(".rss") ? "application/rss+xml" : "application/json" };
    if (file.kind === "board") return Response.json({ name: file.name }, { headers });
    return new Response(await body.text(), { headers });
  };
  return createSourceAdapters(createHttpClient({ fetch, sleep: async () => {} }));
}

type FixtureFile = { kind: "board"; path: string; name: string } | { kind: "payload"; path: string };

const FEEDS: Readonly<Record<string, string>> = {
  "jobicy.com/api/v2/remote-jobs": "jobicy/remote-jobs.json",
  "himalayas.app/jobs/api": "himalayas/jobs.json",
  "remoteok.com/api": "remoteok/api.json",
  "weworkremotely.com/remote-jobs.rss": "weworkremotely/remote-jobs.rss",
  "remotive.com/api/remote-jobs": "remotive/remote-jobs.json",
};

const SLUG = "([a-z0-9_-]+)";
/** Company-board API paths, each to its fixture file. `$1` is the board, `$2` a posting id. */
const BOARDS: readonly { host: string | RegExp; path: RegExp; file: (m: string[]) => string }[] = [
  { host: "api.lever.co", path: new RegExp(`^/v0/postings/${SLUG}$`, "i"), file: ([b]) => `lever/${b}.json` },
  {
    host: "api.ashbyhq.com",
    path: new RegExp(`^/posting-api/job-board/${SLUG}$`, "i"),
    file: ([b]) => `ashby/${b}.json`,
  },
  {
    host: "api.smartrecruiters.com",
    path: new RegExp(`^/v1/companies/${SLUG}/postings$`, "i"),
    file: ([b]) => `smartrecruiters/${b}.json`,
  },
  {
    host: "api.smartrecruiters.com",
    path: new RegExp(`^/v1/companies/${SLUG}/postings/([0-9a-z-]+)$`, "i"),
    file: ([b, id]) => `smartrecruiters/${b}/${id}.json`,
  },
  {
    host: "apply.workable.com",
    path: new RegExp(`^/api/v1/widget/accounts/${SLUG}$`, "i"),
    file: ([b]) => `workable/${b}.json`,
  },
];

function fixtureFile({ host, path }: { host: string; path: string }): FixtureFile | null {
  const feed = FEEDS[`${host}${path}`];
  if (feed) return { kind: "payload", path: feed };
  const board = /^\/v1\/boards\/([a-z0-9_-]+)(\/jobs)?$/i.exec(path);
  if (host === "boards-api.greenhouse.io" && board?.[1]) {
    const slug = board[1].toLowerCase();
    const file = `greenhouse/${slug}.json`;
    if (board[2]) return { kind: "payload", path: file };
    return { kind: "board", path: file, name: slug.charAt(0).toUpperCase() + slug.slice(1) };
  }
  const recruitee = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (recruitee?.[1] && path === "/api/offers") return { kind: "payload", path: `recruitee/${recruitee[1]}.json` };
  for (const route of BOARDS) {
    if (route.host !== host) continue;
    const m = route.path.exec(path);
    if (m) return { kind: "payload", path: route.file(m.slice(1).map((p) => p.toLowerCase())) };
  }
  return null;
}
