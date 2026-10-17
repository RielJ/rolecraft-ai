import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createSourceAdapters, type SourceAdapter, SourceError } from "@/server/adapters/sources";
import { ashbyBoardFromUrl } from "@/server/adapters/sources/ashby";
import { createFixtureSources } from "@/server/adapters/sources/fixture";
import { leverBoardFromUrl } from "@/server/adapters/sources/lever";
import { recruiteeBoardFromUrl } from "@/server/adapters/sources/recruitee";
import { remotiveRestrictions } from "@/server/adapters/sources/remotive";
import { SMARTRECRUITERS_DETAIL_BUDGET, smartRecruitersBoardFromUrl } from "@/server/adapters/sources/smartrecruiters";
import { splitWwrTitle } from "@/server/adapters/sources/weworkremotely";
import { workableBoardFromUrl } from "@/server/adapters/sources/workable";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import { MatchDetail, RefreshDto, SourceDto, TaskDto } from "@/shared/api";
import type { SourceKind } from "@/shared/enums";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Slice 8: the nine new adapters, each over a fixture shaped like the source's documented public
 * format, plus the sync behaviour they add. Nothing here reaches the network: fixture files are
 * served by `createFixtureSources`, and the sync tests route a fake fetch by host and path.
 */

const fixtures = join(import.meta.dir, "fixtures/sources");
const fixtureSources = createFixtureSources({ dir: fixtures });
const read = (path: string) => Bun.file(join(fixtures, path)).text();
const none = new Set<string>();

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function adapter(kind: SourceKind, sources = fixtureSources): SourceAdapter {
  const found = sources[kind];
  if (!found) throw new Error(`no ${kind} adapter`);
  return found;
}

/** Adapters whose every request answers `body` (status 200), recording each URL. */
function answering(body: string): { sources: ReturnType<typeof createSourceAdapters>; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => {
    urls.push(url);
    return new Response(body, { status: 200 });
  };
  return { sources: createSourceAdapters(createHttpClient({ fetch, sleep: async () => {} })), urls };
}

// ---------- each adapter parses its fixture ----------

describe("each adapter parses its fixture into postings", () => {
  test("himalayas: a window of the newest jobs; empty locationRestrictions is worldwide; annual pay", async () => {
    const result = await adapter("himalayas").fetch({ board: null, keywords: [], known: none });
    expect(result.complete).toBe(false);
    expect(result.postings.map((p) => p.title)).toEqual([
      "Senior Go Engineer",
      "Mobile Developer (React Native)",
      "Content Marketing Manager",
    ]);
    expect(result.postings[0]).toMatchObject({
      externalId: "https://himalayas.app/companies/globex/jobs/senior-go-engineer",
      company: "Globex",
      applyUrl: "https://jobs.lever.co/globex/7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c",
      listingUrl: "https://himalayas.app/companies/globex/jobs/senior-go-engineer",
      postedAt: new Date("2026-10-14T08:00:00Z"),
      pay: { min: 90000, max: 130000, currency: "USD", period: "year" },
      restrictions: [],
      locationText: "Worldwide",
    });
    expect(result.postings[0]?.description).toContain("- Go and Postgres");
    expect(result.postings[1]).toMatchObject({ restrictions: ["Philippines", "Singapore"], pay: null });
  });

  test("remoteok: skips the legal notice; salary 0 means none; the listing is the RemoteOK page", async () => {
    const result = await adapter("remoteok").fetch({ board: null, keywords: [], known: none });
    expect(result.complete).toBe(false);
    expect(result.postings).toHaveLength(3);
    expect(result.postings[0]).toMatchObject({
      externalId: "1093001",
      title: "Senior TypeScript Engineer",
      company: "Pied Piper",
      listingUrl: "https://remoteok.com/remote-jobs/remote-senior-typescript-engineer-pied-piper-1093001",
      pay: { min: 100000, max: 140000, currency: "USD", period: "year" },
      tags: ["typescript", "node", "engineer"],
    });
    expect(result.postings[1]?.pay).toBeNull();
    expect(result.postings[2]?.pay).toMatchObject({ min: 50000, max: null });
  });

  test("weworkremotely: RSS items; 'Company: Title' splits; the WWR page is both listing and apply link", async () => {
    const result = await adapter("weworkremotely").fetch({ board: null, keywords: [], known: none });
    expect(result.complete).toBe(false);
    const link = "https://weworkremotely.com/remote-jobs/hooli-senior-rails-developer";
    expect(result.postings[0]).toMatchObject({
      externalId: link,
      title: "Senior Rails Developer",
      company: "Hooli",
      applyUrl: link,
      listingUrl: link,
      locationText: "Anywhere in the World",
      postedAt: new Date("2026-10-14T08:00:00Z"),
      expiresAt: new Date("2026-11-13T08:00:00Z"),
      tags: ["Back-End Programming", "Full-Time"],
    });
    expect(result.postings[0]?.description).toContain("Hooli is hiring a senior Rails developer.");
    expect(result.postings[1]?.title).toBe("Full-Stack Engineer & Team Lead");
    expect(splitWwrTitle("No company here")).toEqual({ company: "Unknown company", title: "No company here" });
  });

  test("remotive: one request; Worldwide is no restriction; the salary text is read as pay", async () => {
    const { sources, urls } = answering(await read("remotive/remote-jobs.json"));
    const result = await adapter("remotive", sources).fetch({ board: null, keywords: [], known: none });
    expect(urls).toEqual(["https://remotive.com/api/remote-jobs?limit=100"]);
    expect(result.complete).toBe(false);
    expect(result.postings[0]).toMatchObject({
      externalId: "2001001",
      company: "Vandelay Industries",
      listingUrl: "https://remotive.com/remote-jobs/software-dev/senior-python-developer-2001001",
      postedAt: new Date("2026-10-14T08:00:00Z"),
      restrictions: [],
      pay: { min: 90000, max: 120000, currency: "USD", period: "year" },
    });
    expect(result.postings[1]?.restrictions).toEqual(["Philippines", "Vietnam"]);
    expect(remotiveRestrictions("")).toBeNull();
  });

  test("lever: the whole board; workplaceType and salaryRange; the company is the board's name", async () => {
    const lever = adapter("lever");
    const result = await lever.fetch({ board: "globex", keywords: [], known: none });
    expect(result.complete).toBe(true);
    expect(result.postings).toHaveLength(3);
    expect(result.postings[0]).toMatchObject({
      externalId: "7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c",
      title: "Senior Go Engineer",
      company: "Globex",
      applyUrl: "https://jobs.lever.co/globex/7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c",
      locationText: "Remote",
      postedAt: new Date("2026-10-14T08:00:00Z"),
      pay: { min: 95000, max: 135000, currency: "USD", period: "year" },
    });
    expect(result.postings[0]?.description).toContain("Requirements");
    expect(result.postings[1]?.locationText).toBe("Manila (Hybrid)");
    expect(await lever.board?.check("globex")).toEqual({ label: "Globex" });
    expect(leverBoardFromUrl("https://jobs.lever.co/globex/7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c")).toBe("globex");
    expect(leverBoardFromUrl("https://jobs.eu.lever.co/globex")).toBeNull();
  });

  test("ashby: unlisted jobs are skipped; Salary compensation becomes pay", async () => {
    const ashby = adapter("ashby");
    const result = await ashby.fetch({ board: "umbrella", keywords: [], known: none });
    expect(result.complete).toBe(true);
    expect(result.postings.map((p) => p.title)).toEqual([
      "Senior Frontend Engineer, Design Systems",
      "Security Engineer",
    ]);
    expect(result.postings[0]).toMatchObject({
      company: "Umbrella",
      locationText: "Remote - APAC; Manila",
      pay: { min: 80000, max: 110000, currency: "USD", period: "year" },
    });
    expect(result.postings[1]?.pay).toBeNull();
    expect(await ashby.board?.check("umbrella")).toEqual({ label: "Umbrella" });
    expect(ashbyBoardFromUrl("https://jobs.ashbyhq.com/Umbrella/2c1f0e9d")).toBe("umbrella");
  });

  test("smartrecruiters: the list plus one detail request per new posting", async () => {
    const sr = adapter("smartrecruiters");
    const result = await sr.fetch({ board: "wayne", keywords: [], known: none });
    expect(result).toMatchObject({ complete: true, unread: [] });
    expect(result.postings[0]).toMatchObject({
      externalId: "744000091234501",
      title: "Senior Java Developer",
      company: "Wayne Enterprises",
      listingUrl: "https://jobs.smartrecruiters.com/WayneEnterprises/744000091234501-senior-java-developer",
      locationText: "Manila, Metro Manila, Philippines (Remote)",
    });
    expect(result.postings[0]?.description).toContain("PHP 180,000 a month");
    expect(await sr.board?.check("wayne")).toEqual({ label: "Wayne Enterprises" });
    expect(smartRecruitersBoardFromUrl("https://jobs.smartrecruiters.com/WayneEnterprises")).toBe("wayneenterprises");
  });

  test("recruitee: offers with salary and a remote flag", async () => {
    const recruitee = adapter("recruitee");
    const result = await recruitee.fetch({ board: "stark", keywords: [], known: none });
    expect(result.complete).toBe(true);
    expect(result.postings[0]).toMatchObject({
      externalId: "1840001",
      title: "Senior Backend Engineer (Elixir)",
      company: "Stark Industries",
      applyUrl: "https://stark.recruitee.com/o/senior-backend-engineer-elixir",
      postedAt: new Date("2026-10-14T08:00:00Z"),
      expiresAt: new Date("2026-11-30T23:59:00Z"),
      pay: { min: 4000, max: 5500, currency: "EUR", period: "month" },
      locationText: "Remote",
    });
    expect(result.postings[0]?.description).toContain("Elixir and Phoenix");
    expect(await recruitee.board?.check("stark")).toEqual({ label: "Stark Industries" });
    expect(recruiteeBoardFromUrl("https://stark.recruitee.com/o/office-manager")).toBe("stark");
  });

  test("workable: the widget account with details; telecommuting is remote", async () => {
    const workable = adapter("workable");
    const result = await workable.fetch({ board: "tyrell", keywords: [], known: none });
    expect(result.complete).toBe(true);
    expect(result.postings[0]).toMatchObject({
      externalId: "A1B2C3D4E5",
      title: "Platform Engineer (Kubernetes)",
      company: "Tyrell Corporation",
      applyUrl: "https://apply.workable.com/j/A1B2C3D4E5",
      locationText: "Manila, Metro Manila, Philippines (Remote)",
    });
    expect(await workable.board?.check("tyrell")).toEqual({ label: "Tyrell Corporation" });
    expect(workableBoardFromUrl("https://apply.workable.com/tyrell/")).toBe("tyrell");
    expect(workableBoardFromUrl("https://apply.workable.com/j/A1B2C3D4E5")).toBeNull();
  });

  test("a company board that does not exist is rejected by check", async () => {
    for (const kind of ["lever", "ashby", "recruitee", "workable", "smartrecruiters"] as const) {
      const error = await caught(async () => adapter(kind).board?.check("nosuchco"));
      expect({ kind, error }).toMatchObject({ kind, error: expect.any(SourceError) });
    }
  });
});

// ---------- a changed envelope is a parse error ----------

describe("a changed envelope throws SourceError { kind: 'parse' }", () => {
  const cases: { kind: SourceKind; board: string | null; body: string }[] = [
    { kind: "himalayas", board: null, body: JSON.stringify({ data: [{ title: "x" }] }) },
    { kind: "remoteok", board: null, body: JSON.stringify({ jobs: [] }) },
    { kind: "weworkremotely", board: null, body: "<html><body>Maintenance</body></html>" },
    { kind: "remotive", board: null, body: JSON.stringify({ results: [] }) },
    { kind: "lever", board: "globex", body: JSON.stringify({ postings: [] }) },
    { kind: "ashby", board: "umbrella", body: JSON.stringify([]) },
    { kind: "smartrecruiters", board: "wayne", body: JSON.stringify({ postings: [] }) },
    { kind: "recruitee", board: "stark", body: JSON.stringify({ jobs: [] }) },
    { kind: "workable", board: "tyrell", body: JSON.stringify({ results: [] }) },
  ];
  for (const { kind, board, body } of cases) {
    test(kind, async () => {
      const { sources } = answering(body);
      const error = await caught(() => adapter(kind, sources).fetch({ board, keywords: [], known: none }));
      expect(error).toBeInstanceOf(SourceError);
      expect(error).toMatchObject({ kind: "parse" });
    });
  }

  test("remoteok: jobs without the leading notice are a changed envelope too", async () => {
    const [, ...jobs] = JSON.parse(await read("remoteok/api.json"));
    const { sources } = answering(JSON.stringify(jobs));
    expect(
      await caught(() => adapter("remoteok", sources).fetch({ board: null, keywords: [], known: none })),
    ).toMatchObject({ kind: "parse" });
  });

  test("smartrecruiters: a detail in a new shape is a parse error", async () => {
    const list = await read("smartrecruiters/wayne.json");
    const fetch: FetchFn = async (url) =>
      new Response(new URL(url).pathname.endsWith("/postings") ? list : JSON.stringify({ id: "1" }), { status: 200 });
    const sources = createSourceAdapters(createHttpClient({ fetch, sleep: async () => {} }));
    expect(
      await caught(() => adapter("smartrecruiters", sources).fetch({ board: "wayne", keywords: [], known: none })),
    ).toMatchObject({ kind: "parse" });
  });
});

// ---------- SmartRecruiters detail budget ----------

/** A SmartRecruiters board of `n` postings, counting detail requests. */
function srBoard(n: number) {
  const ids = Array.from({ length: n }, (_, i) => String(900_000_000 + i));
  const details: string[] = [];
  const fetch: FetchFn = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/postings")) {
      const offset = Number(searchParams.get("offset") ?? 0);
      const limit = Number(searchParams.get("limit") ?? 100);
      const content = ids.slice(offset, offset + limit).map((id) => ({
        id,
        name: `Software Engineer ${id}`,
        company: { name: "Wayne Enterprises" },
        releasedDate: "2026-10-14T08:00:00.000Z",
      }));
      return Response.json({ offset, limit, totalFound: ids.length, content });
    }
    const id = pathname.split("/").at(-1) ?? "";
    details.push(id);
    return Response.json({
      id,
      name: `Software Engineer ${id}`,
      company: { name: "Wayne Enterprises" },
      releasedDate: "2026-10-14T08:00:00.000Z",
      postingUrl: `https://jobs.smartrecruiters.com/wayne/${id}`,
      jobAd: { sections: { jobDescription: { title: "Job Description", text: `<p>Posting ${id}.</p>` } } },
    });
  };
  return { ids, details, fetch };
}

describe("SmartRecruiters detail budget", () => {
  test("stops detail fetches at the budget; known and over-budget postings come back unread", async () => {
    const board = srBoard(SMARTRECRUITERS_DETAIL_BUDGET + 15);
    const sources = createSourceAdapters(createHttpClient({ fetch: board.fetch, sleep: async () => {} }));
    const known = new Set(board.ids.slice(0, 5));
    const result = await adapter("smartrecruiters", sources).fetch({ board: "wayne", keywords: [], known });
    expect(board.details).toHaveLength(SMARTRECRUITERS_DETAIL_BUDGET);
    expect(board.details.some((id) => known.has(id))).toBe(false);
    expect(result.postings).toHaveLength(SMARTRECRUITERS_DETAIL_BUDGET);
    expect(result.unread).toEqual([...board.ids.slice(0, 5), ...board.ids.slice(5 + SMARTRECRUITERS_DETAIL_BUDGET)]);
    expect(result.complete).toBe(true);
  });
});

// ---------- sync with the new sources ----------

const START = Date.parse("2026-10-16T08:00:00Z");
const minutes = (m: number) => new Date(START + m * 60_000);
const days = (d: number) => new Date(START + d * 86_400_000);

describe("sync with the new sources", () => {
  let deps: Deps;
  let app: ReturnType<typeof createApp>;
  let now: Date;
  let routes: Map<string, () => Response | Promise<Response>>;
  let hosts: string[];

  const text = (body: string) => () => new Response(body, { status: 200 });

  beforeEach(async () => {
    await resetDb();
    hosts = [];
    routes = new Map<string, () => Response | Promise<Response>>([
      ["himalayas.app/jobs/api", text(await read("himalayas/jobs.json"))],
      ["remoteok.com/api", text(await read("remoteok/api.json"))],
      ["weworkremotely.com/remote-jobs.rss", text(await read("weworkremotely/remote-jobs.rss"))],
      ["remotive.com/api/remote-jobs", text(await read("remotive/remote-jobs.json"))],
      ["api.lever.co/v0/postings/globex", text(await read("lever/globex.json"))],
    ]);
    const fetch: FetchFn = async (url) => {
      const parsed = new URL(url);
      hosts.push(parsed.host);
      const route = routes.get(`${parsed.host}${parsed.pathname}`);
      return route ? route() : new Response("not found", { status: 404 });
    };
    now = minutes(0);
    deps = await testDeps({ http: createHttpClient({ fetch, sleep: async () => {} }), clock: { now: () => now } });
    app = createApp(deps);
  });

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
  }

  async function ok<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
    const body: unknown = await res.json();
    expect({ status: res.status, body }).toMatchObject({ status });
    return schema.parse(body);
  }

  /** Turn every built-in off except `kinds`. Company boards added later are on. */
  async function only(...kinds: SourceKind[]): Promise<void> {
    await ensureBuiltinSources(deps);
    await testSql()`UPDATE sources SET enabled = (kind = ANY(${kinds}))`;
  }

  async function refresh(at: Date): Promise<RefreshDto> {
    now = at;
    const task = await ok(await call("POST", "/refresh"), TaskDto, 202);
    await waitForTask(task.id);
    const latest = await ok(await call("GET", "/refresh"), RefreshDto);
    expect({ status: latest.task?.status, error: latest.task?.error }).toEqual({ status: "done", error: null });
    return latest;
  }

  async function jobs(title: string) {
    return testSql()<{ id: string; closed: Date | null; listings: number }[]>`
      SELECT j.id, j.closed_at AS closed, (SELECT count(*)::int FROM job_listings l WHERE l.job_id = j.id) AS listings
      FROM jobs j WHERE j.title = ${title}`;
  }

  test("seeding the five built-ins is idempotent and keeps each row's settings", async () => {
    await ensureBuiltinSources(deps);
    await testSql()`UPDATE sources SET enabled = false, keywords = ${["go"]} WHERE kind = 'remoteok'`;
    await ensureBuiltinSources(deps);
    const rows = await testSql()<{ kind: string; label: string; enabled: boolean; keywords: string[] | null }[]>`
      SELECT kind, label, enabled, keywords FROM sources ORDER BY kind`;
    expect([...rows]).toEqual([
      { kind: "himalayas", label: "Himalayas", enabled: true, keywords: null },
      { kind: "jobicy", label: "Jobicy", enabled: true, keywords: null },
      { kind: "remoteok", label: "RemoteOK", enabled: false, keywords: ["go"] },
      { kind: "remotive", label: "Remotive", enabled: true, keywords: null },
      { kind: "weworkremotely", label: "We Work Remotely", enabled: true, keywords: null },
    ]);
  });

  test("Remotive within 6 hours of its last run is skipped and makes no request", async () => {
    await only("remotive");
    const first = await refresh(minutes(0));
    expect(first.result?.sources).toMatchObject([{ label: "Remotive", status: "ok", added: 3 }]);
    expect(hosts).toEqual(["remotive.com"]);

    hosts = [];
    const early = await refresh(minutes(359));
    expect(early.result?.sources).toMatchObject([{ label: "Remotive", status: "skipped" }]);
    expect(hosts).toEqual([]);

    const later = await refresh(minutes(360));
    expect(later.result?.sources).toMatchObject([{ label: "Remotive", status: "ok" }]);
    expect(hosts).toEqual(["remotive.com"]);
  });

  test("per-source keywords override target titles on a built-in board", async () => {
    await only("remoteok");
    // The profile's titles would keep only the TypeScript job; the source's own keywords win.
    const profile = await call("PUT", "/profile", { targeting: { targetTitles: ["TypeScript"] } });
    expect(profile.status).toBe(200);
    const [remoteok] = await testSql()<{ id: string }[]>`SELECT id FROM sources WHERE kind = 'remoteok'`;
    const patched = await ok(await call("PATCH", `/sources/${remoteok?.id}`, { keywords: ["devops"] }), SourceDto);
    expect(patched.keywords).toEqual(["devops"]);
    await refresh(minutes(0));
    const titles = await testSql()<{ title: string }[]>`SELECT title FROM jobs ORDER BY title`;
    expect(titles.map((t) => t.title)).toEqual(["DevOps Engineer"]);
  });

  test("Himalayas and Lever with the same apply URL: one job, two listings, open while either lists it", async () => {
    await only("himalayas");
    await ok(await call("POST", "/sources", { url: "https://jobs.lever.co/globex" }), SourceDto, 201);
    await refresh(minutes(0));
    const [merged] = await jobs("Senior Go Engineer");
    expect(await jobs("Senior Go Engineer")).toHaveLength(1);
    expect(merged).toMatchObject({ listings: 2, closed: null });

    // Lever (complete) drops it; Himalayas still lists it: open.
    const lever = JSON.parse(await read("lever/globex.json")) as { id: string }[];
    routes.set(
      "api.lever.co/v0/postings/globex",
      text(JSON.stringify(lever.filter((j) => j.id !== "7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c"))),
    );
    await refresh(minutes(60));
    expect((await jobs("Senior Go Engineer"))[0]?.closed).toBeNull();
    const listings = await testSql()<{ kind: string; missing: boolean }[]>`
      SELECT s.kind, l.missing_since IS NOT NULL AS missing FROM job_listings l JOIN sources s ON s.id = l.source_id
      WHERE l.job_id = ${merged?.id ?? null} ORDER BY s.kind`;
    expect([...listings]).toEqual([
      { kind: "himalayas", missing: false },
      { kind: "lever", missing: true },
    ]);

    // Back on Lever, gone from Himalayas (incomplete, so absence alone is no signal): open.
    routes.set("api.lever.co/v0/postings/globex", text(await read("lever/globex.json")));
    const himalayas = JSON.parse(await read("himalayas/jobs.json")) as { jobs: { title: string }[] };
    const withoutGo = { ...himalayas, jobs: himalayas.jobs.filter((j) => j.title !== "Senior Go Engineer") };
    routes.set("himalayas.app/jobs/api", text(JSON.stringify(withoutGo)));
    await refresh(minutes(120));
    expect((await jobs("Senior Go Engineer"))[0]?.closed).toBeNull();

    // Gone from both: Lever's listing goes missing now, but Himalayas' only after 30 days unseen.
    routes.set(
      "api.lever.co/v0/postings/globex",
      text(JSON.stringify(lever.filter((j) => j.id !== "7f3c2a10-5b1e-4c8e-9a51-1d2e3f4a5b6c"))),
    );
    await refresh(minutes(180));
    expect((await jobs("Senior Go Engineer"))[0]?.closed).toBeNull();
    await refresh(days(31));
    expect((await jobs("Senior Go Engineer"))[0]?.closed).not.toBeNull();
  });

  test("SmartRecruiters reads the budget's worth of new postings per run, then the rest; none closes", async () => {
    const board = srBoard(SMARTRECRUITERS_DETAIL_BUDGET + 10);
    const api = "https://api.smartrecruiters.com/v1/companies/wayne/postings";
    routes.set("api.smartrecruiters.com/v1/companies/wayne/postings", () =>
      board.fetch(`${api}?limit=100&offset=0`, {}),
    );
    for (const id of board.ids) {
      routes.set(`api.smartrecruiters.com/v1/companies/wayne/postings/${id}`, () => board.fetch(`${api}/${id}`, {}));
    }
    await only();
    await ok(await call("POST", "/sources", { url: "https://jobs.smartrecruiters.com/Wayne" }), SourceDto, 201);

    const first = await refresh(minutes(0));
    expect(first.result?.sources).toMatchObject([{ status: "ok", added: SMARTRECRUITERS_DETAIL_BUDGET }]);
    expect(board.details).toHaveLength(SMARTRECRUITERS_DETAIL_BUDGET);

    const second = await refresh(minutes(60));
    expect(second.result?.sources).toMatchObject([{ status: "ok", added: 10, closed: 0 }]);
    expect(board.details).toHaveLength(SMARTRECRUITERS_DETAIL_BUDGET + 10);
    const [count] = await testSql()<{ open: number }[]>`SELECT count(*)::int AS open FROM jobs WHERE closed_at IS NULL`;
    expect(count?.open).toBe(SMARTRECRUITERS_DETAIL_BUDGET + 10);
  });

  test("RemoteOK, WWR and Remotive jobs show 'via <source>' with the listing link; others do not", async () => {
    await only("remoteok", "weworkremotely", "remotive", "himalayas");
    await refresh(minutes(0));
    const detail = async (title: string) => {
      const [row] = await testSql()<{ id: string }[]>`SELECT id FROM jobs WHERE title = ${title}`;
      return ok(await call("GET", `/matches/${row?.id}`), MatchDetail);
    };
    expect((await detail("Senior TypeScript Engineer")).seenOn).toEqual([
      {
        label: "RemoteOK",
        via: "RemoteOK",
        listingUrl: "https://remoteok.com/remote-jobs/remote-senior-typescript-engineer-pied-piper-1093001",
      },
    ]);
    expect((await detail("Senior Rails Developer")).seenOn).toEqual([
      {
        label: "We Work Remotely",
        via: "We Work Remotely",
        listingUrl: "https://weworkremotely.com/remote-jobs/hooli-senior-rails-developer",
      },
    ]);
    expect((await detail("Senior Python Developer")).seenOn).toEqual([
      {
        label: "Remotive",
        via: "Remotive",
        listingUrl: "https://remotive.com/remote-jobs/software-dev/senior-python-developer-2001001",
      },
    ]);
    expect((await detail("Senior Go Engineer")).seenOn).toEqual([
      { label: "Himalayas", via: null, listingUrl: "https://himalayas.app/companies/globex/jobs/senior-go-engineer" },
    ]);
  });
});
