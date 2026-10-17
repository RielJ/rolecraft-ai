import { beforeEach, describe, expect, test } from "bun:test";
import { derive } from "@/domain/posting";
import { jobs } from "@/server/db/schema";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddJobResult, BoardMetricsDto, type JobId, MatchList, RefreshDto, SavedJob } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Slice 12: the top bar's refresh age, the Excluded toggle's count, and the Board's metrics line
 * (decisions 11, 51, 52 and the count in 53).
 */

const START = new Date("2026-10-01T08:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let now = START;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  now = START;
  deps = await testDeps({ clock: { now: () => now } });
  app = createApp(deps);
});

const at = (ms: number) => new Date(START.getTime() + ms);

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

describe("refresh age", () => {
  test("null on a fresh database, then the newest refresh that finished without failing", async () => {
    expect(await ok(await call("GET", "/refresh"), RefreshDto)).toEqual({
      task: null,
      result: null,
      lastRefreshedAt: null,
      openJobs: 0,
    });

    const sql = testSql();
    const task = (kind: string, status: string, created: Date, finished: Date | null) =>
      sql`INSERT INTO tasks (user_id, kind, status, input, created_at, finished_at)
          VALUES (${deps.userId}, ${kind}, ${status}, '{}'::jsonb, ${created}, ${finished})`;
    await task("refresh", "done", at(-4 * DAY), at(-4 * DAY + MINUTE));
    await task("refresh", "done", at(-3 * DAY), at(-3 * DAY + 2 * MINUTE));
    // Newer, but a failed refresh did not refresh the feed, and a split is not a refresh.
    await task("refresh", "failed", at(-2 * DAY), at(-2 * DAY + MINUTE));
    await task("split", "done", at(-DAY), at(-DAY + MINUTE));
    // The newest refresh is still running: the top bar keeps the last finished one.
    await task("refresh", "running", at(0), null);

    const latest = await ok(await call("GET", "/refresh"), RefreshDto);
    expect(latest.task?.status).toBe("running");
    expect(latest.lastRefreshedAt).toBe(at(-3 * DAY + 2 * MINUTE).toISOString());
  });
});

let seen = 0;
/** A job as sync stores it, open and not yet saved or dismissed. */
async function addJob(title: string, description: string): Promise<JobId> {
  seen++;
  const derived = derive({
    title,
    description,
    company: "Acme",
    locationText: "Remote",
    applyUrl: null,
    postedAt: null,
    expiresAt: null,
    pay: null,
    restrictions: null,
  });
  const firstSeenAt = new Date(START.getTime() - DAY + seen * MINUTE);
  const [row] = await deps.db
    .insert(jobs)
    .values({ userId: deps.userId, origin: "source", ...derived, firstSeenAt, updatedAt: firstSeenAt })
    .returning({ id: jobs.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

describe("excluded count", () => {
  test("counts open, unsaved jobs that exclude the Philippines, whatever the filters", async () => {
    await addJob("Open Engineer", "Fully remote and open worldwide.");
    await addJob("Locked One", "US-only applicants, please.");
    await addJob("Locked Two", "US-only applicants, please.");
    const closed = await addJob("Locked Closed", "US-only applicants, please.");
    const saved = await addJob("Locked Saved", "US-only applicants, please.");
    await testSql()`UPDATE jobs SET closed_at = ${START} WHERE id = ${closed}`;
    await ok(await call("POST", `/jobs/${saved}/save`), SavedJob);

    const list = async (query = "") => ok(await call("GET", `/matches${query}`), MatchList);
    expect((await list()).counts).toMatchObject({ excluded: 2, excludedOpen: 2 });
    // Shown, or hidden by a search: the toggle's count stays the same.
    expect((await list("?excluded=true")).counts).toMatchObject({ excluded: 0, excludedOpen: 2 });
    expect((await list("?q=nothingmatchesthis")).counts).toMatchObject({ excludedOpen: 2 });
  });
});

describe("board metrics", () => {
  const metrics = async () => ok(await call("GET", "/board/metrics"), BoardMetricsDto);

  async function paste(title: string, url: string) {
    const added = await ok(
      await call("POST", "/jobs/from-paste", { url, title, company: "Acme Inc", description: "Remote, worldwide." }),
      AddJobResult,
      201,
    );
    return added.opportunityId;
  }
  const move = async (id: string, body: unknown) => {
    expect((await call("POST", `/opportunities/${id}/status`, body)).status).toBe(200);
  };
  const markReady = (id: string, when: Date) => testSql()`UPDATE opportunities SET ready_at = ${when} WHERE id = ${id}`;

  test("zero applications and no Ready times", async () => {
    expect(await metrics()).toEqual({
      windowDays: 30,
      applied: 0,
      interviewing: 0,
      rate: null,
      readyCount: 0,
      medianSavedToReadyMs: null,
    });
    // Saved only: still nothing applied.
    await paste("Saved Only", "https://jobs.lever.co/acme/0");
    expect(await metrics()).toMatchObject({ applied: 0, rate: null });
  });

  test("applied, reached Interviewing, the rate and the median Saved to Ready, from status history", async () => {
    // Applied 40 days before the read: outside the window, even after it reaches Interviewing.
    const old = await paste("Old", "https://jobs.lever.co/acme/1");
    await markReady(old, at(10 * MINUTE));
    now = at(DAY);
    await move(old, { status: "applied" });

    now = at(40 * DAY);
    const a = await paste("Alpha", "https://jobs.lever.co/acme/2");
    const b = await paste("Bravo", "https://jobs.lever.co/acme/3");
    await markReady(a, at(40 * DAY + 40 * MINUTE));
    await markReady(b, at(40 * DAY + 3 * 60 * MINUTE));
    now = at(41 * DAY);
    await move(a, { status: "applied" });
    await move(b, { status: "applied" });
    await move(old, { status: "interviewing" });
    now = at(42 * DAY);
    await move(a, { status: "interviewing" });
    await move(b, { status: "closed", outcome: "rejected" });

    expect(await metrics()).toEqual({
      windowDays: 30,
      applied: 2,
      interviewing: 1,
      rate: 0.5,
      readyCount: 2,
      medianSavedToReadyMs: (40 * MINUTE + 3 * 60 * MINUTE) / 2,
    });
  });
});

describe("top bar job count", () => {
  test("counts what Matches can show: open, untouched, and not excluded unless overridden", async () => {
    await addJob("Open Engineer", "Fully remote and open worldwide.");
    await addJob("Unclear Engineer", "Remote.");
    await addJob("Locked", "US-only applicants, please.");
    const overridden = await addJob("Locked Overridden", "US-only applicants, please.");
    const closed = await addJob("Open Closed", "Fully remote and open worldwide.");
    const saved = await addJob("Open Saved", "Fully remote and open worldwide.");
    const dismissed = await addJob("Open Dismissed", "Fully remote and open worldwide.");
    await testSql()`UPDATE jobs SET closed_at = ${START} WHERE id = ${closed}`;
    await ok(await call("POST", `/jobs/${saved}/save`), SavedJob);
    expect((await call("POST", `/jobs/${dismissed}/dismiss`, { reason: null })).status).toBeLessThan(300);
    expect((await call("POST", "/filtered/overrides", { jobId: overridden })).status).toBeLessThan(300);

    const { openJobs } = await ok(await call("GET", "/refresh"), RefreshDto);
    expect(openJobs).toBe(3);
  });
});
