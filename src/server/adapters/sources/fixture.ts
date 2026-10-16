import { join } from "node:path";
import { createHttpClient, type FetchFn } from "../http";
import { createSourceAdapters } from "./index";
import type { SourceAdapters } from "./types";

/**
 * The real adapters reading fixture files instead of the network (`HB_SOURCES=fixture`), for
 * Playwright and local demos. Paths under `dir`:
 *   greenhouse/<board>.json   the board's `/jobs?content=true` payload (the board exists if the file does)
 *   jobicy/remote-jobs.json   the feed
 * Anything else answers 404.
 */
export function createFixtureSources({ dir }: { dir: string }): SourceAdapters {
  const fetch: FetchFn = async (input) => {
    const url = URL.parse(input);
    if (!url) return new Response("bad url", { status: 400 });
    const file = fixtureFile({ host: url.hostname, path: url.pathname });
    if (file === null) return new Response("not found", { status: 404 });
    const body = Bun.file(join(dir, file.path));
    if (!(await body.exists())) return new Response("not found", { status: 404 });
    const headers = { "Content-Type": "application/json" };
    if (file.kind === "board") return Response.json({ name: file.name }, { headers });
    return new Response(await body.text(), { headers });
  };
  return createSourceAdapters(createHttpClient({ fetch, sleep: async () => {} }));
}

type FixtureFile = { kind: "board"; path: string; name: string } | { kind: "payload"; path: string };

function fixtureFile({ host, path }: { host: string; path: string }): FixtureFile | null {
  if (host === "jobicy.com" && path === "/api/v2/remote-jobs") {
    return { kind: "payload", path: "jobicy/remote-jobs.json" };
  }
  const board = /^\/v1\/boards\/([a-z0-9_-]+)(\/jobs)?$/i.exec(path);
  if (host === "boards-api.greenhouse.io" && board?.[1]) {
    const slug = board[1].toLowerCase();
    const file = `greenhouse/${slug}.json`;
    if (board[2]) return { kind: "payload", path: file };
    return { kind: "board", path: file, name: slug.charAt(0).toUpperCase() + slug.slice(1) };
  }
  return null;
}
