import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { asSync } from "@/server/db/sync-session";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import { ApiErrorBody, FilteredList, JobId, MatchList, RefreshDto, SourceDto, TaskDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Slice 13: filtered-out postings on the Board (decision 53). Role drops are written by sync and
 * replaced per source; excluded jobs can be moved to Matches through a table sync cannot write;
 * the Board's list groups both by reason, newest 50 per group, with a search over all of them.
 */

const fixtures = join(import.meta.dir, "fixtures/sources");
const GhPayload = z.object({ jobs: z.array(z.looseObject({ id: z.number(), title: z.string() })) });
type GhPayload = z.infer<typeof GhPayload>;

const ghBoard = (board: string) => `boards-api.greenhouse.io/v1/boards/${board}`;
const ghJobs = (board: string) => `boards-api.greenhouse.io/v1/boards/${board}/jobs`;
const START = Date.parse("2026-10-16T08:00:00Z");
const hours = (h: number) => new Date(START + h * 3_600_000);
const days = (d: number) => new Date(START + d * 86_400_000);

let deps: Deps;
let app: ReturnType<typeof createApp>;
let now: Date;
let routes: Map<string, () => Response>;
let acme: GhPayload;
let roles: GhPayload;

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
  routes = new Map([
    [ghBoard("acme"), json({ name: "Acme" })],
    [ghJobs("acme"), json(acme)],
    [ghBoard("roles"), json({ name: "Roles Inc" })],
    [ghJobs("roles"), json(roles)],
  ]);
  now = hours(0);
  deps = await testDeps({
    http: createHttpClient({ fetch: fakeFetch, sleep: async () => {} }),
    clock: { now: () => now },
  });
  app = createApp(deps);
  // Company boards only: the built-ins are off, so each test sees the boards it adds.
  await ensureBuiltinSources(deps);
  await testSql()`UPDATE sources SET enabled = false`;
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

async function setTargeting(roleFamilies: string[], excludeTitleWords: string[] = []): Promise<void> {
  const res = await call("PUT", "/profile", { targeting: { roleFamilies, excludeTitleWords } });
  expect(res.status).toBe(200);
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

async function drops() {
  const rows = await testSql()<{ board: string; title: string; reason: string; url: string }[]>`
    SELECT s.board, d.title, d.reason, d.url FROM role_drops d JOIN sources s ON s.id = d.source_id
    ORDER BY s.board, d.title`;
  return rows.map((r) => ({ ...r }));
}

const filtered = async (q?: string) =>
  ok(await call("GET", q === undefined ? "/filtered" : `/filtered?q=${encodeURIComponent(q)}`), FilteredList);

const matches = async () => ok(await call("GET", "/matches"), MatchList);

const sqlState = (error: unknown): string | null => {
  for (let e: unknown = error; typeof e === "object" && e !== null; e = "cause" in e ? e.cause : null) {
    if ("code" in e && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return null;
};

/** Await inside a helper: Bun's `expect(...).rejects` hangs on postgres.js queries. */
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return sqlState(error) ?? `no SQLSTATE: ${String(error)}`;
  }
  return "succeeded";
}

// ---------- role drops at sync ----------

describe("role drops at sync", () => {
  test("sync stores what the role filter dropped, with the word or family that dropped it", async () => {
    await setTargeting(["engineering"], ["wizard"]);
    await addBoard("roles");
    const result = await refresh(hours(0));
    expect(result.result?.sources).toMatchObject([{ status: "ok", fetched: 4, dropped: 2 }]);
    expect(await drops()).toEqual([
      {
        board: "roles",
        title: "Product Designer",
        reason: "Role: Design",
        url: "https://boards.greenhouse.io/roles/jobs/5002",
      },
      {
        board: "roles",
        title: "Technical Wizard",
        reason: "Title: wizard",
        url: "https://boards.greenhouse.io/roles/jobs/5004",
      },
    ]);
  });

  test("a source run replaces that source's drops and leaves other sources' drops alone", async () => {
    await setTargeting(["engineering"]);
    await addBoard("roles");
    await addBoard("acme");
    await refresh(hours(0));
    expect((await drops()).map((d) => `${d.board} ${d.title}`)).toEqual([
      "acme Product Designer",
      "roles Product Designer",
    ]);

    // Roles no longer lists its designer; Acme is down. Roles' drops go; Acme's stay as they were.
    routes.set(ghJobs("roles"), json({ jobs: roles.jobs.filter((j) => j.id !== 5002) }));
    routes.set(ghJobs("acme"), json({ error: "down" }, 500));
    const second = await refresh(hours(1));
    expect(second.result?.sources.map((s) => s.status).sort()).toEqual(["failed", "ok"]);
    expect((await drops()).map((d) => `${d.board} ${d.title}`)).toEqual(["acme Product Designer"]);

    // Roles lists two new out-of-family titles: exactly those are its drops now.
    routes.set(
      ghJobs("roles"),
      json({
        jobs: [
          ...roles.jobs,
          {
            ...roles.jobs[1],
            id: 5005,
            title: "Account Executive",
            absolute_url: "https://boards.greenhouse.io/roles/jobs/5005",
          },
        ],
      }),
    );
    await refresh(hours(2));
    expect((await drops()).map((d) => `${d.board} ${d.title} (${d.reason})`)).toEqual([
      "acme Product Designer (Role: Design)",
      "roles Account Executive (Role: Sales)",
      "roles Product Designer (Role: Design)",
    ]);
  });

  test("removing a source removes its drops", async () => {
    await setTargeting(["engineering"]);
    const board = await addBoard("roles");
    await refresh(hours(0));
    expect(await drops()).toHaveLength(1);
    expect((await call("DELETE", `/sources/${board.id}`)).status).toBe(200);
    expect(await drops()).toHaveLength(0);
  });
});

// ---------- the sync role and the override table ----------

describe("eligibility_overrides is out of the sync role's reach", () => {
  test("as hb_sync, every read and write of eligibility_overrides fails with 42501", async () => {
    const run = (statement: string) => () => asSync(deps.db, (tx) => tx.execute(sql.raw(statement)));
    const statements = [
      "SELECT job_id FROM eligibility_overrides",
      "INSERT INTO eligibility_overrides DEFAULT VALUES",
      "UPDATE eligibility_overrides SET created_at = created_at WHERE false",
      "DELETE FROM eligibility_overrides WHERE false",
      "TRUNCATE eligibility_overrides",
    ];
    const results: Record<string, string> = {};
    for (const s of statements) results[s] = await failure(run(s));
    expect(results).toEqual(Object.fromEntries(statements.map((s) => [s, "42501"])));
  });

  test("as hb_sync, role_drops can be inserted and deleted by source, but not updated or read", async () => {
    const run = (statement: string) => () => asSync(deps.db, (tx) => tx.execute(sql.raw(statement)));
    expect(await failure(run("DELETE FROM role_drops WHERE source_id IS NULL"))).toBe("succeeded");
    expect(await failure(run("UPDATE role_drops SET title = title WHERE false"))).toBe("42501");
    expect(await failure(run("SELECT title FROM role_drops"))).toBe("42501");
    expect(await failure(run("TRUNCATE role_drops"))).toBe("42501");
  });
});

// ---------- the override ----------

/** Acme's Backend Engineer, rewritten to say it hires in the United States only. */
const usOnly = (payload: GhPayload, note = ""): GhPayload => ({
  jobs: payload.jobs.map((j) =>
    j.id === 4002
      ? { ...j, content: `&lt;p&gt;Join the payments team. Must be located in the United States.${note}&lt;/p&gt;` }
      : j,
  ),
});

describe("Show in Matches", () => {
  async function excludedBackend(): Promise<JobId> {
    await setTargeting(["engineering"]);
    routes.set(ghJobs("acme"), json(usOnly(acme)));
    await addBoard("acme");
    await refresh(hours(0));
    const [row] = await testSql()<{ id: string; eligibility: string }[]>`
      SELECT id, eligibility FROM jobs WHERE title = 'Backend Engineer'`;
    expect(row?.eligibility).toBe("excluded");
    return JobId.parse(row?.id);
  }

  test("an overridden job leaves Filtered out, shows in Matches, and stays there after a Refresh", async () => {
    const jobId = await excludedBackend();
    const before = await filtered();
    expect(before.groups.filter((g) => g.kind === "excluded").map((g) => [g.reason, g.count])).toEqual([
      ["US only", 1],
    ]);
    const list = await matches();
    expect(list.jobs.map((j) => j.id)).not.toContain(jobId);
    expect(list.counts.excludedOpen).toBe(1);

    const res = await call("POST", "/filtered/overrides", { jobId });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { jobId } });
    // Twice is fine.
    expect((await call("POST", "/filtered/overrides", { jobId })).status).toBe(200);

    const after = await filtered();
    expect(after.groups.some((g) => g.kind === "excluded")).toBe(false);
    const shown = await matches();
    expect(shown.jobs.find((j) => j.id === jobId)).toMatchObject({ title: "Backend Engineer", level: "possible" });
    expect(shown.counts).toMatchObject({ excludedOpen: 0, excluded: 0 });
    const detail = await ok(await call("GET", `/matches/${jobId}`), z.looseObject({ reasons: z.array(z.unknown()) }));
    expect(detail.reasons).toContainEqual({
      sign: "negative",
      text: "The posting limits where it hires, and you moved it to Matches, so it is Possible at best",
    });

    // The posting changes, so sync rewrites the job and re-runs the eligibility rules: still excluded.
    routes.set(ghJobs("acme"), json(usOnly(acme, " Benefits included.")));
    const second = await refresh(hours(1));
    expect(second.result?.sources).toMatchObject([{ status: "ok", updated: 1 }]);
    const [row] = await testSql()<{ eligibility: string; description: string }[]>`
      SELECT eligibility, description FROM jobs WHERE id = ${jobId}`;
    expect(row).toMatchObject({ eligibility: "excluded", description: expect.stringContaining("Benefits") });
    expect((await matches()).jobs.map((j) => j.id)).toContain(jobId);
    expect((await filtered()).groups.some((g) => g.kind === "excluded")).toBe(false);
  });

  test("the override does not count as touched: the job is still pruned 60 days after it closes", async () => {
    const jobId = await excludedBackend();
    expect((await call("POST", "/filtered/overrides", { jobId })).status).toBe(200);
    routes.set(ghJobs("acme"), json({ jobs: usOnly(acme).jobs.filter((j) => j.id !== 4002) }));
    await refresh(hours(1));
    const [closed] = await testSql()<
      { closed: Date | null }[]
    >`SELECT closed_at AS closed FROM jobs WHERE id = ${jobId}`;
    expect(closed?.closed).not.toBeNull();

    const result = await refresh(days(62));
    expect(result.result?.pruned).toBeGreaterThanOrEqual(1);
    expect(await testSql()`SELECT 1 FROM jobs WHERE id = ${jobId}`).toHaveLength(0);
    expect(await testSql()`SELECT 1 FROM eligibility_overrides`).toHaveLength(0);
  });

  test("only an excluded job of this user can be overridden", async () => {
    await excludedBackend();
    const [open] = await testSql()<{ id: string }[]>`SELECT id FROM jobs WHERE title = 'Senior Frontend Engineer'`;
    const notExcluded = await call("POST", "/filtered/overrides", { jobId: open?.id });
    expect({ status: notExcluded.status, code: ApiErrorBody.parse(await notExcluded.json()).error.code }).toEqual({
      status: 400,
      code: "invalid_input",
    });
    const missing = await call("POST", "/filtered/overrides", { jobId: crypto.randomUUID() });
    expect(missing.status).toBe(404);
    expect((await call("POST", "/filtered/overrides", { jobId: "nope" })).status).toBe(400);
  });
});

// ---------- the Board list ----------

describe("GET /api/filtered", () => {
  async function seed(): Promise<void> {
    const source = await addBoard("acme");
    const minute = 60_000;
    // 60 US-only jobs, 3 UK-only, 2 that exclude the Philippines, one AI verdict with another reason.
    const excluded: { title: string; phrase: string; at: Date }[] = [
      ...Array.from({ length: 60 }, (_, i) => ({
        title: `US Role ${String(i).padStart(2, "0")}`,
        phrase: i % 2 === 0 ? "This role is US-only." : "You must be authorized to work in the United States.",
        at: new Date(START - (60 - i) * minute),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        title: `UK Role ${i}`,
        phrase: "Candidates must be based in the UK.",
        at: new Date(START - i * minute),
      })),
      { title: "No PH One", phrase: "Open to all of Asia except the Philippines.", at: new Date(START) },
      { title: "No PH Two", phrase: "We cannot hire in the Philippines.", at: new Date(START) },
      { title: "Odd One", phrase: "Applicants need a security clearance.", at: new Date(START) },
    ];
    for (const job of excluded) {
      const key = job.title.toLowerCase();
      await testSql()`
        INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, content_hash,
          description_key, eligibility, eligibility_phrase, first_seen_at)
        VALUES (${deps.userId}, 'source', ${job.title}, 'Globex', ${key}, 'globex', ${job.phrase}, ${key}, ${key},
          'excluded', ${job.phrase}, ${job.at})`;
    }
    // Not filtered out: closed, on the board, dismissed, or not excluded.
    await testSql()`
      INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, content_hash,
        description_key, eligibility, eligibility_phrase, first_seen_at, closed_at)
      VALUES (${deps.userId}, 'source', 'Closed US Role', 'Globex', 'closed', 'globex', 'x', 'c1', 'c1', 'excluded',
          'US only', ${hours(0)}, ${hours(0)}),
        (${deps.userId}, 'source', 'Worldwide Role', 'Globex', 'ww', 'globex', 'x', 'c2', 'c2', 'worldwide',
          'Worldwide', ${hours(0)}, null),
        (${deps.userId}, 'source', 'Dismissed US Role', 'Globex', 'dis', 'globex', 'x', 'c3', 'c3', 'excluded',
          'US only', ${hours(0)}, null)`;
    await testSql()`
      INSERT INTO opportunities (user_id, job_id, dismissed_at)
      SELECT ${deps.userId}, id, now() FROM jobs WHERE title = 'Dismissed US Role'`;
    // 55 drops for "Title: sales" and 2 for "Role: Design".
    const rows = [
      ...Array.from({ length: 55 }, (_, i) => ({
        id: `s${i}`,
        title: `Sales Rep ${String(i).padStart(2, "0")}`,
        company: i === 3 ? "Initech" : "Hooli",
        reason: "Title: sales",
        at: new Date(START - (55 - i) * minute),
      })),
      { id: "d1", title: "Product Designer", company: "Hooli", reason: "Role: Design", at: new Date(START) },
      { id: "d2", title: "Brand Designer", company: "Hooli", reason: "Role: Design", at: new Date(START - minute) },
    ];
    for (const r of rows) {
      await testSql()`
        INSERT INTO role_drops (source_id, external_id, user_id, title, company, url, reason, seen_at)
        VALUES (${source.id}, ${r.id}, ${deps.userId}, ${r.title}, ${r.company},
          ${`https://boards.greenhouse.io/acme/jobs/${r.id}`}, ${r.reason}, ${r.at})`;
    }
  }

  test("groups by reason with counts, newest 50 per group", async () => {
    await seed();
    const list = await filtered();
    expect(list.total).toBe(66 + 57);
    expect(list.groups.map((g) => [g.kind, g.reason, g.count, g.items.length])).toEqual([
      ["excluded", "US only", 60, 50],
      ["excluded", "UK only", 3, 3],
      ["excluded", "Philippines excluded", 2, 2],
      ["excluded", "Security clearance", 1, 1],
      ["role_drop", "Title: sales", 55, 50],
      ["role_drop", "Role: Design", 2, 2],
    ]);
    const us = list.groups[0];
    expect(us?.items[0]).toMatchObject({ kind: "excluded", title: "US Role 59", company: "Globex" });
    expect(us?.items.at(-1)).toMatchObject({ title: "US Role 10" });
    const sales = list.groups[4];
    expect(sales?.items[0]).toMatchObject({
      kind: "role_drop",
      title: "Sales Rep 54",
      url: "https://boards.greenhouse.io/acme/jobs/s54",
      source: "Acme",
    });
    expect(sales?.items.at(-1)).toMatchObject({ title: "Sales Rep 05" });
  });

  test("the search spans every item, past the newest 50, by title or company", async () => {
    await seed();
    const old = await filtered("us role 03");
    expect(old.groups.map((g) => [g.reason, g.count, g.items.map((i) => i.title)])).toEqual([
      ["US only", 1, ["US Role 03"]],
    ]);
    expect(old.total).toBe(123);

    const byCompany = await filtered("initech");
    expect(byCompany.groups.map((g) => [g.reason, g.items.map((i) => i.title)])).toEqual([
      ["Title: sales", ["Sales Rep 03"]],
    ]);
    // LIKE wildcards are matched literally.
    expect((await filtered("%")).groups).toEqual([]);
    expect((await filtered("")).groups).toHaveLength(6);
  });

  test("stays one bounded query per kind with thousands of rows", async () => {
    const source = await addBoard("acme");
    await testSql()`
      INSERT INTO role_drops (source_id, external_id, user_id, title, company, url, reason, seen_at)
      SELECT ${source.id}, 'x' || g, ${deps.userId}, 'Sales Rep ' || g, 'Hooli', 'https://example.com/' || g,
        'Title: sales', ${hours(0)}::timestamptz - g * interval '1 minute'
      FROM generate_series(1, 5000) g`;
    await testSql()`
      INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, content_hash,
        description_key, eligibility, eligibility_phrase, first_seen_at)
      SELECT ${deps.userId}, 'source', 'US Role ' || g, 'Globex', 'us' || g, 'globex', 'x', 'h' || g, 'h' || g,
        'excluded', 'US only', ${hours(0)}::timestamptz - g * interval '1 minute'
      FROM generate_series(1, 5000) g`;
    const started = performance.now();
    const list = await filtered();
    const ms = performance.now() - started;
    expect(list.total).toBe(10_000);
    expect(list.groups.map((g) => [g.reason, g.count, g.items.length])).toEqual([
      ["US only", 5000, 50],
      ["Title: sales", 5000, 50],
    ]);
    expect(ms).toBeLessThan(2000);
  });
});
