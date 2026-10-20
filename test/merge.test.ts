import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { derive, type JobFields } from "@/domain/posting";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { jobs } from "@/server/db/schema";
import { asSync } from "@/server/db/sync-session";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  ApiErrorBody,
  BoardItemDto,
  JobId,
  MatchDetail,
  MergeResult,
  RefreshDto,
  SavedJob,
  SourceDto,
  TaskDto,
} from "@/shared/api";
import type { SourceKind } from "@/shared/enums";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Likely duplicates and merge (decisions 10 and 46). Jobs are stored the way sync
 * stores them (the same `derive`), with listings on built-in boards; one test runs a real refresh
 * through the Greenhouse fixture to show sync after a merge.
 */

const BOTH_ON_BOARD = "Both are on your board. Close one instead.";

let deps: Deps;
let app: ReturnType<typeof createApp>;
let now: Date;
let routes: Map<string, () => Response>;

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
  routes = new Map();
  now = new Date("2026-10-16T08:00:00Z");
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

const detail = async (id: JobId) => ok(await call("GET", `/matches/${id}`), MatchDetail);
const merge = (id: JobId, into: JobId) => call("POST", `/jobs/${id}/merge`, { into });
const save = async (id: JobId) => (await ok(await call("POST", `/jobs/${id}/save`), SavedJob)).opportunityId;

let seen = 0;
/** A job as sync stores it, with one listing per board given (the first is primary). */
async function addJob(
  fields: Partial<JobFields> & { title: string; company: string; description: string },
  boards: readonly SourceKind[] = ["jobicy"],
): Promise<JobId> {
  seen++;
  await ensureBuiltinSources(deps);
  const derived = derive({
    locationText: "Remote",
    applyUrl: null,
    postedAt: null,
    expiresAt: null,
    pay: null,
    restrictions: null,
    ...fields,
  });
  const firstSeenAt = new Date(Date.parse("2026-10-01T00:00:00Z") + seen * 60_000);
  const [row] = await deps.db
    .insert(jobs)
    .values({ userId: deps.userId, origin: "source", ...derived, firstSeenAt, updatedAt: firstSeenAt })
    .returning({ id: jobs.id });
  if (!row) throw new Error("insert failed");
  for (const [i, kind] of boards.entries()) {
    await testSql()`
      INSERT INTO job_listings (source_id, external_id, user_id, job_id, listing_url, is_primary, first_seen_at, last_seen_at)
      SELECT id, ${`${kind}-${seen}`}, user_id, ${row.id}, ${`https://example.com/${kind}/${seen}`}, ${i === 0},
        ${firstSeenAt}, ${firstSeenAt}
      FROM sources WHERE kind = ${kind}`;
  }
  return row.id;
}

const SR = {
  title: "Sr. Frontend Engineer (Remote)",
  company: "Acme Inc",
  description: "Build our design system in React and TypeScript. You need 5+ years of experience.",
};
const SENIOR = {
  title: "Frontend Engineer, Senior",
  company: "Acme",
  description: "Own the checkout UI in Vue. Work hours overlap with Manila. 3+ years of experience.",
};

const Listing = z.object({ external_id: z.string(), job_id: z.string(), is_primary: z.boolean() });
async function listings() {
  return z
    .array(Listing)
    .parse(await testSql()`SELECT external_id, job_id, is_primary FROM job_listings ORDER BY external_id`);
}
async function jobIds(): Promise<string[]> {
  const rows = await testSql()<{ id: string }[]>`SELECT id FROM jobs ORDER BY id`;
  return rows.map((r) => r.id);
}

async function errorOf(res: Response, status: number) {
  return (await ok(res, ApiErrorBody, status)).error;
}

describe("suggestions", () => {
  test("'Sr. Frontend Engineer (Remote)' at 'Acme Inc' and 'Frontend Engineer, Senior' at 'Acme' are suggested, with the board and a diff", async () => {
    const a = await addJob(SR, ["remoteok"]);
    const b = await addJob(SENIOR, ["jobicy", "remoteok"]);

    const pane = await detail(a);
    expect(pane.facts.possibleDuplicates).toEqual([
      {
        jobId: b,
        title: "Frontend Engineer, Senior",
        company: "Acme",
        opportunityId: null,
        source: "Jobicy",
        diff: expect.any(Object),
        merge: { kind: "ready" },
      },
    ]);
    expect((await detail(b)).facts.possibleDuplicates.map((d) => [d.jobId, d.source])).toEqual([[a, "RemoteOK"]]);
  });

  test("closed jobs and postings that already auto-merged into one job are not suggested", async () => {
    // Two boards' listings of one posting are one job row: there is no pair to suggest.
    const a = await addJob(SR, ["jobicy", "remoteok", "remotive"]);
    const closed = await addJob(SENIOR);
    await testSql()`UPDATE jobs SET closed_at = now() WHERE id = ${closed}`;
    expect((await detail(a)).facts.possibleDuplicates).toEqual([]);
  });
});

describe("merge", () => {
  test("keeps the job with the opportunity, moves the other's listings to it as non-primary, and deletes the other", async () => {
    const a = await addJob(SR, ["jobicy"]);
    const b = await addJob(SENIOR, ["remoteok", "remotive"]);
    const opportunityId = await save(b);

    // Merging the board job into the match still keeps the board job.
    const merged = await ok(await merge(b, a), MergeResult);
    expect(merged).toEqual({ jobId: b, opportunityId });
    expect(await jobIds()).toEqual([b]);
    expect(await listings()).toEqual([
      { external_id: `jobicy-${seen - 1}`, job_id: b, is_primary: false },
      { external_id: `remoteok-${seen}`, job_id: b, is_primary: true },
      { external_id: `remotive-${seen}`, job_id: b, is_primary: false },
    ]);
    expect((await detail(b)).seenOn.map((s) => s.label)).toEqual(["RemoteOK", "Jobicy", "Remotive"]);
  });

  test("with no opportunity on either, the merge target is kept", async () => {
    const a = await addJob(SR, ["jobicy"]);
    const b = await addJob(SENIOR, ["remoteok"]);
    expect(await ok(await merge(a, b), MergeResult)).toEqual({ jobId: b, opportunityId: null });
    expect(await jobIds()).toEqual([b]);
    expect((await listings()).map((l) => [l.job_id, l.is_primary])).toEqual([
      [b, false],
      [b, true],
    ]);
  });

  test("the kept job keeps its opportunity, outputs, citations and history unchanged", async () => {
    const a = await addJob(SR, ["jobicy"]);
    const b = await addJob(SENIOR, ["remoteok"]);
    const opportunityId = await save(a);
    await ok(await call("POST", `/opportunities/${opportunityId}/status`, { status: "applied" }), BoardItemDto);
    await testSql()`UPDATE opportunities SET notes = 'Spoke to the hiring manager.' WHERE id = ${opportunityId}`;
    await testSql()`UPDATE outputs SET body = 'Dear Acme,' WHERE opportunity_id = ${opportunityId} AND kind = 'letter'`;
    await testSql()`INSERT INTO output_facts (output_id, fact_key, user_id, fact_text)
      SELECT id, 'F1', user_id, 'Led the design system rebuild.' FROM outputs
      WHERE opportunity_id = ${opportunityId} AND kind = 'letter'`;
    const snapshot = async () =>
      testSql()`SELECT
        (SELECT jsonb_agg(to_jsonb(o)) FROM opportunities o) AS opportunities,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM outputs o) AS outputs,
        (SELECT jsonb_agg(to_jsonb(f)) FROM output_facts f) AS citations`;
    const before = await snapshot();
    expect(before[0]?.citations).toHaveLength(1);
    expect(JSON.stringify(before[0]?.outputs)).toContain("Dear Acme,");
    const history = await testSql()<{ history: unknown[] }[]>`SELECT history FROM opportunities`;
    expect(history[0]?.history).toHaveLength(2);

    expect(await ok(await merge(a, b), MergeResult)).toEqual({ jobId: a, opportunityId });
    expect(await snapshot()).toEqual(before);
    expect(await jobIds()).toEqual([a]);
  });

  test("both on the board: Merge is disabled with the reason, and the endpoint answers 409 both_on_board", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    await save(a);
    await save(b);

    const [hint] = (await detail(a)).facts.possibleDuplicates;
    expect(hint?.merge).toEqual({ kind: "blocked", reason: BOTH_ON_BOARD });
    expect(await errorOf(await merge(a, b), 409)).toMatchObject({ code: "both_on_board", message: BOTH_ON_BOARD });
    expect((await jobIds()).sort()).toEqual([a, b].sort());
  });

  test("merge during a refresh answers 409 refresh_running and changes nothing", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    const [task] = await testSql()<{ id: string }[]>`
      INSERT INTO tasks (user_id, kind, input) VALUES (${deps.userId}, 'refresh', '{}') RETURNING id`;
    const before = await listings();

    expect(await errorOf(await merge(a, b), 409)).toMatchObject({
      code: "refresh_running",
      details: { taskId: task?.id },
    });
    expect((await jobIds()).sort()).toEqual([a, b].sort());
    expect(await listings()).toEqual(before);

    await testSql()`UPDATE tasks SET status = 'done' WHERE id = ${task?.id ?? ""}`;
    expect((await merge(a, b)).status).toBe(200);
  });

  test("a dismissed job is kept over a fresh one and stays dismissed; a board job is kept over a dismissed one", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    expect((await call("POST", `/jobs/${a}/dismiss`, { reason: null })).status).toBe(200);
    const kept = await ok(await merge(b, a), MergeResult);
    expect(kept.jobId).toBe(a);
    const [row] = await testSql()<
      { dismissed: boolean }[]
    >`SELECT dismissed_at IS NOT NULL AS dismissed FROM opportunities`;
    expect(row?.dismissed).toBe(true);

    const c = await addJob({ ...SENIOR, title: "Senior Frontend Engineer" });
    const opportunityId = await save(c);
    expect(await ok(await merge(a, c), MergeResult)).toEqual({ jobId: c, opportunityId });
    const opps = await testSql()<{ job_id: string; status: string }[]>`SELECT job_id, status FROM opportunities`;
    expect([...opps]).toEqual([{ job_id: c, status: "saved" }]);
  });

  test("merging a job into itself is a 400; an unknown job is a 404", async () => {
    const a = await addJob(SR);
    expect((await errorOf(await merge(a, a), 400)).code).toBe("invalid_input");
    expect((await errorOf(await merge(a, JobId.parse(crypto.randomUUID())), 404)).code).toBe("not_found");
  });
});

describe("merge and a refresh never interleave", () => {
  // Held transactions are released after each test, even a failed one, so the pool drains.
  const held: { release: () => void; done: Promise<void> }[] = [];
  afterEach(async () => {
    for (const h of held.splice(0)) {
      h.release();
      await h.done;
    }
  });

  /** An `asSync` transaction (one source's apply) that stays open until released. */
  async function holdSourceApply() {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const done = asSync(deps.db, async () => {
      entered.resolve();
      await released.promise;
    });
    await entered.promise;
    const hold = { release: released.resolve, done };
    held.push(hold);
    return hold;
  }

  /** Wait until some transaction is blocked on an advisory lock. */
  async function untilWaitingOnLock(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const [row] = await testSql()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (row?.n) return;
      await Bun.sleep(20);
    }
    throw new Error("the merge never waited for the source apply");
  }

  function track(res: Promise<Response>) {
    const state = { settled: false };
    const promise = res.finally(() => {
      state.settled = true;
    });
    return { state, promise };
  }

  const startRefreshTask = async () =>
    (
      await testSql()<{ id: string }[]>`
      INSERT INTO tasks (user_id, kind, input) VALUES (${deps.userId}, 'refresh', '{}') RETURNING id`
    )[0]?.id;

  test("a merge waits for an in-flight source apply and commits only after it ends", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    const apply = await holdSourceApply();
    const pending = track(merge(a, b));

    await untilWaitingOnLock();
    expect(pending.state.settled).toBe(false);
    expect((await jobIds()).sort()).toEqual([a, b].sort());

    apply.release();
    await apply.done;
    expect(await ok(await pending.promise, MergeResult)).toEqual({ jobId: b, opportunityId: null });
    expect(await jobIds()).toEqual([b]);
  });

  test("when the source apply ends with its refresh still running, the waiting merge answers 409 refresh_running", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    const taskId = await startRefreshTask();
    const apply = await holdSourceApply();
    const pending = track(merge(a, b));

    await untilWaitingOnLock();
    expect(pending.state.settled).toBe(false);
    apply.release();
    await apply.done;

    expect(await errorOf(await pending.promise, 409)).toMatchObject({ code: "refresh_running", details: { taskId } });
    expect((await jobIds()).sort()).toEqual([a, b].sort());
  });

  test("a refresh that starts while the merge waits is seen: the check runs after the lock, 409", async () => {
    const a = await addJob(SR);
    const b = await addJob(SENIOR);
    const apply = await holdSourceApply();
    const pending = track(merge(a, b));

    await untilWaitingOnLock();
    const taskId = await startRefreshTask();
    apply.release();
    await apply.done;

    expect(await errorOf(await pending.promise, 409)).toMatchObject({ code: "refresh_running", details: { taskId } });
    expect((await jobIds()).sort()).toEqual([a, b].sort());
  });
});

describe("sync after a merge", () => {
  const fixtures = join(import.meta.dir, "fixtures/sources");

  test("the next refresh keeps the moved listing on the kept job, never rewrites it and never recreates the other", async () => {
    const acme = z
      .object({ jobs: z.array(z.looseObject({ id: z.number(), title: z.string() })) })
      .parse(await Bun.file(join(fixtures, "greenhouse/acme.json")).json());
    routes.set("boards-api.greenhouse.io/v1/boards/acme", json({ name: "Acme" }));
    routes.set("boards-api.greenhouse.io/v1/boards/acme/jobs", json(acme));
    await ensureBuiltinSources(deps);
    await testSql()`UPDATE sources SET enabled = false`;
    await ok(await call("POST", "/sources", { url: "https://boards.greenhouse.io/acme" }), SourceDto, 201);
    const refresh = async () => {
      const task = await ok(await call("POST", "/refresh"), TaskDto, 202);
      await waitForTask(task.id);
      const latest = await ok(await call("GET", "/refresh"), RefreshDto);
      expect(latest.task?.status).toBe("done");
    };
    await refresh();
    const [synced] = await testSql()<{ id: JobId }[]>`SELECT id FROM jobs WHERE title = 'Senior Frontend Engineer'`;
    if (!synced) throw new Error("the fixture job did not sync");

    const pasted = await ok(
      await call("POST", "/jobs/from-paste", { ...SENIOR, company: "Acme Inc" }),
      AddJobResult,
      201,
    );
    const pane = await detail(synced.id);
    const hint = pane.facts.possibleDuplicates.find((d) => d.opportunityId === pasted.opportunityId);
    expect(hint).toMatchObject({ source: "pasted", merge: { kind: "ready" } });
    if (!hint) throw new Error("no hint");

    const merged = await ok(await merge(synced.id, hint.jobId), MergeResult);
    expect(merged).toEqual({ jobId: hint.jobId, opportunityId: pasted.opportunityId });

    const opportunity = async () => testSql()`SELECT md5(to_jsonb(o)::text) FROM opportunities o`;
    const description = async () =>
      (await testSql()<{ d: string }[]>`SELECT description AS d FROM jobs WHERE id = ${hint.jobId}`)[0]?.d;
    const [before, text] = [await opportunity(), await description()];
    now = new Date(now.getTime() + 3_600_000);
    await refresh();

    expect(await testSql()`SELECT id FROM jobs WHERE title = 'Senior Frontend Engineer'`).toHaveLength(0);
    const [moved] = await testSql()<{ job_id: string; is_primary: boolean }[]>`
      SELECT job_id, is_primary FROM job_listings WHERE external_id = '4001'`;
    expect(moved).toEqual({ job_id: hint.jobId, is_primary: false });
    expect(await opportunity()).toEqual(before);
    expect(await description()).toBe(text);
  });
});
