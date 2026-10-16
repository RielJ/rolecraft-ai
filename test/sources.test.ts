import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createFixtureSources } from "@/server/adapters/sources/fixture";
import { createGreenhouseAdapter, greenhouseBoardFromUrl } from "@/server/adapters/sources/greenhouse";
import { createJobicyAdapter, jobicyRestrictions } from "@/server/adapters/sources/jobicy";
import { SourceError } from "@/server/adapters/sources/types";
import { createApp } from "@/server/http/app";
import { ApiErrorBody, SourceDto, SourceList } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

const fixtures = join(import.meta.dir, "fixtures/sources");

/** A fetch that serves `routes` by host and path and records every URL asked for. */
function harness(routes: Record<string, () => Response | Promise<Response>>) {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const route = routes[`${parsed.host}${parsed.pathname}`];
    return route ? await route() : new Response("not found", { status: 404 });
  };
  return { urls, http: createHttpClient({ fetch, sleep: async () => {} }) };
}

const file = (path: string) => async () => new Response(await Bun.file(join(fixtures, path)).text());
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("Greenhouse adapter", () => {
  test("reads the board slug from careers, embed and API links", () => {
    expect(greenhouseBoardFromUrl("https://boards.greenhouse.io/acme")).toBe("acme");
    expect(greenhouseBoardFromUrl("https://job-boards.greenhouse.io/Acme/jobs/4001?gh_src=x")).toBe("acme");
    expect(greenhouseBoardFromUrl("https://boards.greenhouse.io/embed/job_board?for=acme")).toBe("acme");
    expect(greenhouseBoardFromUrl("https://boards-api.greenhouse.io/v1/boards/acme/jobs")).toBe("acme");
    expect(greenhouseBoardFromUrl("https://jobs.lever.co/acme")).toBeNull();
    expect(greenhouseBoardFromUrl("not a url")).toBeNull();
  });

  test("maps the board payload: entity-escaped HTML to text, departments to tags, complete", async () => {
    const { http, urls } = harness({
      "boards-api.greenhouse.io/v1/boards/acme/jobs": file("greenhouse/acme.json"),
    });
    const result = await createGreenhouseAdapter(http).fetch({ board: "acme", keywords: [] });
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"]);
    expect(result.complete).toBe(true);
    expect(result.postings).toHaveLength(7);
    const first = result.postings[0];
    expect(first).toMatchObject({
      externalId: "4001",
      title: "Senior Frontend Engineer",
      company: "Acme",
      locationText: "Remote - Worldwide",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/4001",
      listingUrl: "https://boards.greenhouse.io/acme/jobs/4001",
    });
    expect(first?.description).toStartWith("Acme builds payroll software for small teams. We hire worldwide");
    expect(first?.description).not.toContain("<");
    expect(first?.postedAt?.toISOString()).toBe("2026-09-28T13:00:00.000Z");
    expect(first?.tags.length).toBeGreaterThan(0);
  });

  test("checks a board before it is saved: the company name, or a clear error on 404", async () => {
    const { http } = harness({ "boards-api.greenhouse.io/v1/boards/acme": json({ name: "Acme", content: "" }) });
    const adapter = createGreenhouseAdapter(http);
    expect(await adapter.board?.check("acme")).toEqual({ label: "Acme" });
    const error = await caught(async () => adapter.board?.check("nosuchco"));
    expect(error).toBeInstanceOf(SourceError);
    expect(error instanceof SourceError ? error.message : "").toContain(
      'Greenhouse said the board "nosuchco" does not exist',
    );
  });

  test("429 is rate_limited, 500 and bad JSON are failed or parse", async () => {
    const statuses = async (route: () => Response | Promise<Response>) => {
      const { http } = harness({ "boards-api.greenhouse.io/v1/boards/acme/jobs": route });
      const error = await caught(() => createGreenhouseAdapter(http).fetch({ board: "acme", keywords: [] }));
      return error instanceof SourceError ? error.kind : String(error);
    };
    expect(await statuses(json({}, 429))).toBe("rate_limited");
    expect(await statuses(json({}, 500))).toBe("failed");
    expect(await statuses(() => new Response("<html></html>"))).toBe("parse");
    expect(await statuses(json({ unexpected: true }))).toBe("parse");
  });
});

describe("Jobicy adapter", () => {
  test("fetches one window, incomplete, and maps pay, regions and tags", async () => {
    const { http, urls } = harness({
      "jobicy.com/api/v2/remote-jobs": file("jobicy/remote-jobs.json"),
    });
    const result = await createJobicyAdapter(http).fetch({ board: null, keywords: ["react"] });
    expect(urls).toEqual(["https://jobicy.com/api/v2/remote-jobs?count=100"]);
    // The adapter returns every posting; sync applies the keyword filter.
    expect(result).toMatchObject({ complete: false });
    expect(result.postings.map((p) => p.title)).toEqual(["React Developer", "Python Engineer", "Account Executive"]);
    expect(result.postings[0]).toMatchObject({
      externalId: "120001",
      company: "Globex",
      restrictions: [],
      tags: ["Programming"],
      pay: { min: 60000, max: 80000, currency: "USD", period: "year" },
    });
    expect(result.postings[0]?.postedAt?.toISOString()).toBe("2026-10-14T08:00:00.000Z");
    expect(result.postings[1]?.tags).toEqual(["Programming", "Data Science & Analytics"]);
  });

  test("jobGeo: Anywhere is no restriction; otherwise the listed regions", () => {
    expect(jobicyRestrictions("Anywhere")).toEqual([]);
    expect(jobicyRestrictions("USA, Canada")).toEqual(["USA", "Canada"]);
    expect(jobicyRestrictions("")).toBeNull();
  });
});

describe("fixture sources (HB_SOURCES=fixture)", () => {
  test("run the real adapters over files, and a board without a file does not exist", async () => {
    const sources = createFixtureSources({ dir: fixtures });
    const acme = await sources.greenhouse?.fetch({ board: "acme", keywords: [] });
    expect(acme?.postings).toHaveLength(7);
    expect(await sources.greenhouse?.board?.check("acme")).toEqual({ label: "Acme" });
    expect(await caught(async () => sources.greenhouse?.board?.check("nosuchco"))).toBeInstanceOf(SourceError);
    expect((await sources.jobicy?.fetch({ board: null, keywords: [] }))?.postings).toHaveLength(3);
  });
});

describe("sources API", () => {
  let app: ReturnType<typeof createApp>;
  let urls: string[];

  beforeEach(async () => {
    await resetDb();
    const h = harness({
      "boards-api.greenhouse.io/v1/boards/acme": json({ name: "Acme Corp" }),
      "boards-api.greenhouse.io/v1/boards/acme/jobs": json({ jobs: [] }),
    });
    urls = h.urls;
    app = createApp(await testDeps({ http: h.http }));
  });

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
  }

  async function error(res: Response) {
    const body = ApiErrorBody.parse(await res.json());
    return { status: res.status, code: body.error.code, message: body.error.message };
  }

  test("built-ins are always listed and on by default", async () => {
    const list = SourceList.parse(await (await call("GET", "/sources")).json());
    expect(list.sources).toMatchObject([
      { kind: "jobicy", label: "Jobicy", enabled: true, builtin: true, board: null },
    ]);
  });

  test("adding a company board checks it first and labels it with the company's name", async () => {
    const res = await call("POST", "/sources", { url: "https://boards.greenhouse.io/acme/jobs/4001" });
    expect(res.status).toBe(201);
    expect(SourceDto.parse(await res.json())).toMatchObject({
      kind: "greenhouse",
      board: "acme",
      label: "Acme Corp",
      enabled: true,
      builtin: false,
      lastStatus: null,
    });
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme"]);
  });

  test("a Greenhouse board that does not exist is rejected before saving", async () => {
    const res = await call("POST", "/sources", { url: "https://boards.greenhouse.io/nosuchco" });
    expect(await error(res)).toMatchObject({ status: 400, code: "invalid_input" });
    const [row] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE kind = 'greenhouse'`;
    expect(row?.n).toBe(0);
  });

  test("a link that is not a board we read is 400 without any request; a duplicate is 409", async () => {
    expect(await error(await call("POST", "/sources", { url: "https://example.com/careers" }))).toMatchObject({
      status: 400,
      code: "invalid_input",
    });
    expect(urls).toEqual([]);
    await call("POST", "/sources", { url: "https://boards.greenhouse.io/acme" });
    expect(await error(await call("POST", "/sources", { url: "https://job-boards.greenhouse.io/acme" }))).toEqual({
      status: 409,
      code: "source_exists",
      message: "Acme Corp on Greenhouse is already one of your sources.",
    });
  });

  test("a source can be turned off and given keywords; a built-in cannot be deleted, a company board can", async () => {
    const list = SourceList.parse(await (await call("GET", "/sources")).json());
    const jobicy = list.sources[0];
    if (!jobicy) throw new Error("no built-in");
    const patched = SourceDto.parse(
      await (
        await call("PATCH", `/sources/${jobicy.id}`, { enabled: false, keywords: ["react", "typescript"] })
      ).json(),
    );
    expect(patched).toMatchObject({ enabled: false, keywords: ["react", "typescript"] });
    expect(await error(await call("DELETE", `/sources/${jobicy.id}`))).toMatchObject({ status: 400 });

    const board = SourceDto.parse(
      await (await call("POST", "/sources", { url: "https://boards.greenhouse.io/acme" })).json(),
    );
    const after = SourceList.parse(await (await call("DELETE", `/sources/${board.id}`)).json());
    expect(after.sources.map((s) => s.kind)).toEqual(["jobicy"]);
  });

  test("the profile stores role families and exclude words, deduplicated", async () => {
    const res = await call("PUT", "/profile", {
      targeting: {
        roleFamilies: ["engineering", "design", "engineering"],
        excludeTitleWords: ["Intern", "intern", "Lead"],
      },
    });
    const body = z.object({ targeting: z.unknown() }).parse(await res.json());
    expect(body.targeting).toEqual({
      targetTitles: [],
      roleFamilies: ["engineering", "design"],
      excludeTitleWords: ["intern", "Lead"],
    });
    const bad = await call("PUT", "/profile", { targeting: { roleFamilies: ["wizardry"] } });
    expect(bad.status).toBe(400);
  });
});
