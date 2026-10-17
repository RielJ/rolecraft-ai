import { describe, expect, test } from "bun:test";
import { createHttpClient, type FetchFn, MAX_BYTES } from "@/server/adapters/http";
import { createSourceAdapters, type SourceAdapter } from "@/server/adapters/sources";
import { GREENHOUSE_DETAIL_BUDGET } from "@/server/adapters/sources/greenhouse";
import { LEVER_MAX_PAGES, LEVER_PAGE_SIZE } from "@/server/adapters/sources/lever";

/*
 * Big company boards (Veeva on Lever, GitLab on Greenhouse) answer with more than the 2 MB cap in
 * one response. Lever is read in pages; Greenhouse falls back to its list without descriptions and
 * reads details only for new titles that pass the keywords. No network: a fake fetch answers.
 */

function adapters(fetch: FetchFn): ReturnType<typeof createSourceAdapters> {
  return createSourceAdapters(createHttpClient({ fetch, sleep: async () => {} }));
}

function pick(sources: ReturnType<typeof createSourceAdapters>, kind: "lever" | "greenhouse"): SourceAdapter {
  return sources[kind];
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const tooBig = () => new Response("x".repeat(MAX_BYTES + 1), { status: 200 });

function leverJob(i: number) {
  return {
    id: `job-${i}`,
    text: `Engineer ${i}`,
    categories: { location: "Remote" },
    createdAt: Date.parse("2026-10-01T00:00:00Z"),
    description: `<p>Posting ${i}.</p>`,
    hostedUrl: `https://jobs.lever.co/veeva/job-${i}`,
  };
}

describe("Lever reads a big board in pages", () => {
  test("pages with skip and limit until a short page; every posting comes back", async () => {
    const board = Array.from({ length: LEVER_PAGE_SIZE * 2 + 20 }, (_, i) => leverJob(i));
    const urls: string[] = [];
    const lever = pick(
      adapters(async (url) => {
        urls.push(url);
        const params = new URL(url).searchParams;
        const skip = Number(params.get("skip") ?? 0);
        const limit = Number(params.get("limit") ?? board.length);
        return json(board.slice(skip, skip + limit));
      }),
      "lever",
    );
    const result = await lever.fetch({ board: "veeva", keywords: [], known: new Set() });
    expect(result.postings.map((p) => p.externalId)).toEqual(board.map((j) => j.id));
    expect(result.complete).toBe(true);
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => new URL(u).searchParams.get("skip"))).toEqual([
      "0",
      `${LEVER_PAGE_SIZE}`,
      `${LEVER_PAGE_SIZE * 2}`,
    ]);
  });

  test("an exact multiple of the page size ends on the empty page after it", async () => {
    const board = Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => leverJob(i));
    const lever = pick(
      adapters(async (url) => {
        const skip = Number(new URL(url).searchParams.get("skip") ?? 0);
        return json(board.slice(skip, skip + LEVER_PAGE_SIZE));
      }),
      "lever",
    );
    const result = await lever.fetch({ board: "veeva", keywords: [], known: new Set() });
    expect(result.postings).toHaveLength(LEVER_PAGE_SIZE);
    expect(result.complete).toBe(true);
  });

  test("stops at the page cap and reports the board as incomplete, so nothing closes", async () => {
    let calls = 0;
    const lever = pick(
      adapters(async (url) => {
        calls++;
        const skip = Number(new URL(url).searchParams.get("skip") ?? 0);
        return json(Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => leverJob(skip + i)));
      }),
      "lever",
    );
    const result = await lever.fetch({ board: "veeva", keywords: [], known: new Set() });
    expect(calls).toBe(LEVER_MAX_PAGES);
    expect(result.complete).toBe(false);
  });
});

type GhListJob = { id: number; title: string };

function greenhouseBoard(jobs: GhListJob[]) {
  const details: number[] = [];
  const fetch: FetchFn = async (url) => {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean); // v1 boards gitlab jobs [id]
    if (parts.length === 4 && parsed.searchParams.get("content") === "true") return tooBig();
    const listed = jobs.map((j) => ({
      id: j.id,
      title: j.title,
      absolute_url: `https://job-boards.greenhouse.io/gitlab/jobs/${j.id}`,
      first_published: "2026-10-01T00:00:00Z",
      location: { name: "Remote" },
      departments: [{ name: "Engineering" }],
    }));
    if (parts.length === 4) return json({ jobs: listed });
    const id = Number(parts[4]);
    details.push(id);
    const job = listed.find((j) => j.id === id);
    return job
      ? json({ ...job, content: `&lt;p&gt;About ${job.title}.&lt;/p&gt;` })
      : new Response("", { status: 404 });
  };
  return { fetch, details };
}

describe("Greenhouse falls back when the board with descriptions is too large", () => {
  test("reads details only for new titles that pass the keywords; the rest come back unread", async () => {
    const board = greenhouseBoard([
      { id: 1, title: "Senior Backend Engineer" },
      { id: 2, title: "Account Executive" },
      { id: 3, title: "Staff Engineer" },
    ]);
    const gh = pick(adapters(board.fetch), "greenhouse");
    const result = await gh.fetch({ board: "gitlab", keywords: ["engineer"], known: new Set(["3"]) });
    expect(board.details).toEqual([1]);
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.description).toBe("About Senior Backend Engineer.");
    expect(result.postings[0]?.tags).toEqual(["Engineering"]);
    expect(result.unread.toSorted()).toEqual(["2", "3"]);
    expect(result.complete).toBe(true);
  });

  test("stops detail reads at the budget; postings past it stay open as unread", async () => {
    const jobs = Array.from({ length: GREENHOUSE_DETAIL_BUDGET + 7 }, (_, i) => ({
      id: i + 1,
      title: `Engineer ${i}`,
    }));
    const board = greenhouseBoard(jobs);
    const gh = pick(adapters(board.fetch), "greenhouse");
    const result = await gh.fetch({ board: "gitlab", keywords: [], known: new Set() });
    expect(board.details).toHaveLength(GREENHOUSE_DETAIL_BUDGET);
    expect(result.postings).toHaveLength(GREENHOUSE_DETAIL_BUDGET);
    expect(result.unread).toHaveLength(7);
    expect(result.complete).toBe(true);
  });

  test("a detail that fails is left unread instead of failing the board", async () => {
    const board = greenhouseBoard([{ id: 1, title: "Engineer" }]);
    const gh = pick(
      adapters(async (url, init) =>
        url.endsWith("/jobs/1") ? new Response("", { status: 404 }) : board.fetch(url, init),
      ),
      "greenhouse",
    );
    const result = await gh.fetch({ board: "gitlab", keywords: [], known: new Set() });
    expect(result.postings).toHaveLength(0);
    expect(result.unread).toEqual(["1"]);
    expect(result.complete).toBe(true);
  });
});
