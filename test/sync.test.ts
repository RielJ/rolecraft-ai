import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ApiErrorBody, MatchList, RefreshDto, SourceDto, TaskDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Refresh behaviour per source (PLAN.md section 3.1 and slice 6 acceptance). The network is a
 * map of fixture payloads keyed by host and path; a test changes an entry to change what a board
 * says on the next run.
 */

const fixtures = join(import.meta.dir, "fixtures/sources");
const GhPayload = z.object({ jobs: z.array(z.looseObject({ id: z.number(), title: z.string() })) });
type GhPayload = z.infer<typeof GhPayload>;
const JobicyPayload = z.looseObject({ jobs: z.array(z.looseObject({ id: z.number() })) });
type JobicyPayload = z.infer<typeof JobicyPayload>;

const ghBoard = (board: string) => `boards-api.greenhouse.io/v1/boards/${board}`;
const ghJobs = (board: string) => `boards-api.greenhouse.io/v1/boards/${board}/jobs`;
const JOBICY = "jobicy.com/api/v2/remote-jobs";
const START = Date.parse("2026-10-16T08:00:00Z");
const hours = (h: number) => new Date(START + h * 3_600_000);
const days = (d: number) => new Date(START + d * 86_400_000);

let deps: Deps;
let app: ReturnType<typeof createApp>;
let now: Date;
let routes: Map<string, () => Response | Promise<Response>>;
let acme: GhPayload;
let roles: GhPayload;
let jobicy: JobicyPayload;

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: FetchFn = async (url) => {
  const parsed = new URL(url);
  const route = routes.get(`${parsed.host}${parsed.pathname}`);
  return route ? route() : new Response("not found", { status: 404 });
};

beforeEach(async () => {
  await resetDb();
  acme = GhPayload.parse(await Bun.file(join(fixtures, "greenhouse/acme.json")).json());
  roles = GhPayload.parse(await Bun.file(join(fixtures, "greenhouse/roles.json")).json());
  jobicy = JobicyPayload.parse(await Bun.file(join(fixtures, "jobicy/remote-jobs.json")).json());
  routes = new Map([
    [ghBoard("acme"), json({ name: "Acme" })],
    [ghJobs("acme"), json(acme)],
    [ghBoard("roles"), json({ name: "Roles Inc" })],
    [ghJobs("roles"), json(roles)],
    [JOBICY, json(jobicy)],
  ]);
  now = hours(0);
  deps = await testDeps({
    http: createHttpClient({ fetch: fakeFetch, sleep: async () => {} }),
    clock: { now: () => now },
  });
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

async function setFamilies(roleFamilies: string[], excludeTitleWords: string[] = []): Promise<void> {
  const res = await call("PUT", "/profile", { targeting: { roleFamilies, excludeTitleWords } });
  expect(res.status).toBe(200);
}

/** Turn every source off except the given kinds, so a test sees one board at a time. */
async function only(kind: "greenhouse" | "jobicy"): Promise<void> {
  await ensureBuiltinSources(deps);
  await testSql()`UPDATE sources SET enabled = (kind = ${kind})`;
}

async function addBoard(board: string): Promise<SourceDto> {
  return ok(await call("POST", "/sources", { url: `https://boards.greenhouse.io/${board}` }), SourceDto, 201);
}

async function refresh(at: Date): Promise<RefreshDto> {
  now = at;
  const task = await ok(await call("POST", "/refresh"), TaskDto, 202);
  await waitForTask(task.id);
  const latest = await ok(await call("GET", "/refresh"), RefreshDto);
  expect({ status: latest.task?.status, error: latest.task?.error }).toEqual({ status: "done", error: null });
  return latest;
}

async function job(title: string) {
  const [row] = await testSql()<{ id: string; closed: Date | null; description: string; origin: string }[]>`
    SELECT id, closed_at AS closed, description, origin FROM jobs WHERE title = ${title}`;
  return row ?? null;
}

async function source(kind: string) {
  const [row] = await testSql()<
    { status: string; count: number | null; dropped: number | null; okCount: number | null; error: string | null }[]
  >`SELECT last_status AS status, last_count AS count, last_dropped AS dropped, last_ok_count AS "okCount",
      last_error AS error FROM sources WHERE kind = ${kind}`;
  return row ?? null;
}

const without = (payload: GhPayload, ...ids: number[]): GhPayload => ({
  jobs: payload.jobs.filter((j) => !ids.includes(j.id)),
});

describe("refresh task", () => {
  test("a second POST /api/refresh while one runs is 409 refresh_running with the first task's id", async () => {
    await only("greenhouse");
    await addBoard("acme");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    routes.set(ghJobs("acme"), async () => {
      await gate;
      return json(acme)();
    });
    const first = await ok(await call("POST", "/refresh"), TaskDto, 202);
    const second = await call("POST", "/refresh");
    const body = ApiErrorBody.parse(await second.json());
    expect({ status: second.status, code: body.error.code, details: body.error.details }).toEqual({
      status: 409,
      code: "refresh_running",
      details: { taskId: first.id },
    });
    release();
    await waitForTask(first.id);
    const done = await ok(await call("GET", "/refresh"), RefreshDto);
    expect(done.task?.id).toBe(first.id);
    expect(done.result?.sources).toMatchObject([{ label: "Acme", status: "ok", fetched: 7, added: 7 }]);
  });

  test("a source run within its minimum interval is skipped and keeps its last run time", async () => {
    await only("jobicy");
    await refresh(hours(0));
    const result = await refresh(new Date(START + 59 * 60_000));
    expect(result.result?.sources).toMatchObject([{ label: "Jobicy", status: "skipped" }]);
    const [row] = await testSql()<{ run: Date }[]>`SELECT last_run_at AS run FROM sources WHERE kind = 'jobicy'`;
    expect(row?.run.toISOString()).toBe(hours(0).toISOString());
    expect((await refresh(hours(1))).result?.sources).toMatchObject([{ status: "ok" }]);
  });
});

describe("Greenhouse (complete source)", () => {
  beforeEach(async () => {
    await only("greenhouse");
    await addBoard("acme");
  });

  test("a posting missing from a successful run closes its job, and reopens when it returns", async () => {
    await refresh(hours(0));
    expect((await job("Backend Engineer"))?.closed).toBeNull();

    routes.set(ghJobs("acme"), json(without(acme, 4002)));
    const gone = await refresh(hours(1));
    expect((await job("Backend Engineer"))?.closed?.toISOString()).toBe(hours(1).toISOString());
    expect(gone.result?.sources).toMatchObject([{ status: "ok", closed: 1, reopened: 0 }]);

    routes.set(ghJobs("acme"), json(acme));
    const back = await refresh(hours(2));
    expect((await job("Backend Engineer"))?.closed).toBeNull();
    expect(back.result?.sources).toMatchObject([{ status: "ok", closed: 0, reopened: 1, added: 0 }]);
  });

  test("GET /api/matches lists open jobs with where each was seen, and drops closed ones", async () => {
    await refresh(hours(0));
    routes.set(ghJobs("acme"), json(without(acme, 4002)));
    await refresh(hours(1));
    const list = await ok(await call("GET", "/matches?excluded=true"), MatchList);
    expect(list.jobs).toHaveLength(6);
    expect(list.jobs.map((j) => j.title)).not.toContain("Backend Engineer");
    expect(list.jobs.find((j) => j.title === "Senior Frontend Engineer")).toMatchObject({
      company: "Acme",
      seenOn: [{ label: "Acme", listingUrl: "https://boards.greenhouse.io/acme/jobs/4001", via: null }],
    });
  });

  test("a thrown fetch closes nothing and records failed", async () => {
    await refresh(hours(0));
    routes.set(ghJobs("acme"), json({ error: "down" }, 500));
    const result = await refresh(hours(1));
    expect(result.result?.sources).toMatchObject([{ status: "failed", closed: 0 }]);
    expect(await source("greenhouse")).toMatchObject({ status: "failed", count: 7 });
    const [open] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE closed_at IS NULL`;
    expect(open?.n).toBe(7);
  });

  test("unreadable JSON is failed too, and closes nothing", async () => {
    await refresh(hours(0));
    routes.set(ghJobs("acme"), () => new Response("<html>maintenance</html>", { status: 200 }));
    expect((await refresh(hours(1))).result?.sources).toMatchObject([{ status: "failed" }]);
    const [open] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE closed_at IS NULL`;
    expect(open?.n).toBe(7);
  });

  test("zero postings after a healthy run is suspicious_empty and closes nothing", async () => {
    await refresh(hours(0));
    routes.set(ghJobs("acme"), json({ jobs: [] }));
    const result = await refresh(hours(1));
    expect(result.result?.sources).toMatchObject([{ status: "suspicious_empty", closed: 0 }]);
    expect(await source("greenhouse")).toMatchObject({ status: "suspicious_empty", okCount: 7 });
    const [open] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE closed_at IS NULL`;
    expect(open?.n).toBe(7);
  });

  test("a changed posting rewrites the job from its primary listing", async () => {
    await refresh(hours(0));
    routes.set(
      ghJobs("acme"),
      json({
        jobs: acme.jobs.map((j) =>
          j.id === 4002 ? { ...j, content: "&lt;p&gt;Now on the ledger team.&lt;/p&gt;" } : j,
        ),
      }),
    );
    const result = await refresh(hours(1));
    expect(result.result?.sources).toMatchObject([{ status: "ok", updated: 1, added: 0 }]);
    expect((await job("Backend Engineer"))?.description).toBe("Now on the ledger team.");
  });
});

describe("role filter at sync (section 3.7a)", () => {
  test("engineering picked: three of the four role-board postings are stored, one dropped", async () => {
    await setFamilies(["engineering"]);
    await only("greenhouse");
    await addBoard("roles");
    const result = await refresh(hours(0));
    expect(result.result?.sources).toMatchObject([{ status: "ok", fetched: 4, dropped: 1, added: 3 }]);
    const titles = await testSql()<{ title: string }[]>`SELECT title FROM jobs ORDER BY title`;
    expect(titles.map((t) => t.title)).toEqual(["Senior Frontend Engineer", "Technical Wizard", "UX Engineer"]);
    expect(await source("greenhouse")).toMatchObject({ status: "ok", count: 3, dropped: 1 });
    const list = z.object({ sources: z.array(SourceDto) }).parse(await (await call("GET", "/sources")).json());
    expect(list.sources.find((s) => s.kind === "greenhouse")).toMatchObject({ lastCount: 3, lastDropped: 1 });
  });

  test("a board where every posting is dropped is ok, not suspicious_empty", async () => {
    await setFamilies(["engineering"], ["senior", "ux", "wizard"]);
    await only("greenhouse");
    await addBoard("roles");
    await refresh(hours(0));
    expect(await source("greenhouse")).toMatchObject({ status: "ok", count: 0, dropped: 4 });
    // The next run with the same answer is still ok: the check uses the count before filtering.
    expect((await refresh(hours(1))).result?.sources).toMatchObject([{ status: "ok", dropped: 4 }]);
  });

  test("Jobicy keeps engineering postings and drops the sales one", async () => {
    await setFamilies(["engineering"]);
    await only("jobicy");
    const result = await refresh(hours(0));
    expect(result.result?.sources).toMatchObject([{ status: "ok", fetched: 3, dropped: 1, added: 2 }]);
  });
});

describe("Jobicy (incomplete source)", () => {
  beforeEach(async () => {
    await only("jobicy");
  });

  const withoutJob = (id: number): JobicyPayload => ({ ...jobicy, jobs: jobicy.jobs.filter((j) => j.id !== id) });

  test("a missing posting stays open, then closes 30 days after its last sighting", async () => {
    await refresh(days(0));
    routes.set(JOBICY, json(withoutJob(120001)));
    await refresh(days(1));
    expect((await job("React Developer"))?.closed).toBeNull();
    await refresh(days(29));
    expect((await job("React Developer"))?.closed).toBeNull();
    await refresh(days(31));
    expect((await job("React Developer"))?.closed?.toISOString()).toBe(days(31).toISOString());
    expect((await job("Python Engineer"))?.closed).toBeNull();
  });

  test("a source that keeps failing closes nothing, however long", async () => {
    await refresh(days(0));
    routes.set(JOBICY, json({ error: "slow down" }, 429));
    await refresh(days(40));
    expect(await source("jobicy")).toMatchObject({ status: "rate_limited" });
    expect((await job("React Developer"))?.closed).toBeNull();
    // The first good run after that closes what it no longer lists and was last seen long ago.
    routes.set(JOBICY, json(withoutJob(120001)));
    await refresh(days(41));
    expect((await job("React Developer"))?.closed?.toISOString()).toBe(days(41).toISOString());
    expect((await job("Python Engineer"))?.closed).toBeNull();
  });
});

describe("prune and attach", () => {
  test("a closed untouched job is deleted after 61 days; closed saved and dismissed jobs remain", async () => {
    await only("greenhouse");
    await addBoard("acme");
    await refresh(hours(0));
    const saved = await job("Senior Frontend Engineer");
    const dismissed = await job("UX Engineer");
    if (!saved || !dismissed) throw new Error("missing seed jobs");
    await testSql()`
      INSERT INTO opportunities (user_id, job_id, status, status_changed_at, history)
      VALUES (${deps.userId}, ${saved.id}, 'saved', ${now}, '[]'::jsonb)`;
    await testSql()`
      INSERT INTO opportunities (user_id, job_id, dismissed_at, dismiss_reason)
      VALUES (${deps.userId}, ${dismissed.id}, ${now}, 'wrong_stack')`;
    routes.set(ghJobs("acme"), json(without(acme, 4001, 4003, 4006)));
    await refresh(hours(1));

    const at59 = await refresh(new Date(hours(1).getTime() + 59 * 86_400_000));
    expect(at59.result?.pruned).toBe(0);
    const at61 = await refresh(new Date(hours(1).getTime() + 61 * 86_400_000));
    expect(at61.result?.pruned).toBe(1);
    expect(await job("Staff Software Engineer")).toBeNull();
    expect((await job("Senior Frontend Engineer"))?.closed).not.toBeNull();
    expect((await job("UX Engineer"))?.closed).not.toBeNull();
  });

  test("a posting with a pasted job's apply URL attaches a non-primary listing and leaves its text", async () => {
    const pasted = await ok(
      await call("POST", "/jobs/from-paste", {
        url: "https://boards.greenhouse.io/acme/jobs/4005?utm_source=linkedin",
        title: "Platform Engineer",
        company: "Acme",
        description: "Pasted from LinkedIn. Kubernetes platform team, remote.",
      }),
      AddJobResult,
      201,
    );
    await only("greenhouse");
    await addBoard("acme");
    const result = await refresh(hours(0));
    expect(result.result?.sources).toMatchObject([{ status: "ok", added: 6 }]);
    const rows = await testSql()<{ origin: string; description: string; primary: boolean; opp: string | null }[]>`
      SELECT j.origin, j.description, l.is_primary AS primary, o.id AS opp
      FROM jobs j JOIN job_listings l ON l.job_id = j.id LEFT JOIN opportunities o ON o.job_id = j.id
      WHERE j.title = 'Platform Engineer'`;
    expect([...rows]).toEqual([
      {
        origin: "paste",
        description: "Pasted from LinkedIn. Kubernetes platform team, remote.",
        primary: false,
        opp: pasted.opportunityId,
      },
    ]);
    // A later content change on the board still leaves the pasted text alone.
    routes.set(
      ghJobs("acme"),
      json({ jobs: acme.jobs.map((j) => (j.id === 4005 ? { ...j, content: "&lt;p&gt;Changed.&lt;/p&gt;" } : j)) }),
    );
    await refresh(hours(1));
    expect((await job("Platform Engineer"))?.description).toBe(
      "Pasted from LinkedIn. Kubernetes platform team, remote.",
    );
  });
});
