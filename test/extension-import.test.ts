import { beforeEach, describe, expect, test } from "bun:test";
import { applyUrlKey } from "@/domain/dedup";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddJobResult, ApiErrorBody, type OpportunityId } from "@/shared/api";
import { ClaimPairingResult, CreatePairingResult, LookupResult } from "@/shared/extension";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Task 7 of docs/plans/chrome-extension.md: the extension asks whether the visible page is a
 * known job (read-only, by apply URL key) and imports it through the paste path.
 */

const APP_ORIGIN = "http://localhost";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const NOW = new Date("2026-10-16T08:00:00Z");

const APPLY_URL = "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc";
// Same job: tracking params, a fragment, a trailing slash and an upper-case host do not change the key.
const APPLY_URL_VARIANT = "https://Boards.Greenhouse.io/acme/jobs/123/?utm_source=linkedin&gh_src=abc#apply";

let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps({ clock: { now: () => NOW } });
  app = createApp(deps);
});

type Call = { method?: string; path: string; headers?: Record<string, string>; body?: unknown };

function call({ method = "GET", path, headers = {}, body }: Call) {
  const sent = new Headers(headers);
  if (body !== undefined && !sent.has("content-type")) sent.set("content-type", "application/json");
  return app.request(path, {
    method,
    headers: sent,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function errorOf(res: Response) {
  return ApiErrorBody.parse(await res.json()).error;
}

async function pair(): Promise<string> {
  const created = await call({
    method: "POST",
    path: "/api/extension-web/pairings",
    headers: { origin: APP_ORIGIN },
    body: {},
  });
  expect(created.status).toBe(201);
  const { code } = CreatePairingResult.parse(await created.json());
  const claimed = await call({
    method: "POST",
    path: "/api/extension/pair/claim",
    headers: { origin: EXT_ORIGIN },
    body: { code },
  });
  expect(claimed.status).toBe(200);
  return ClaimPairingResult.parse(await claimed.json()).token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: EXT_ORIGIN };
}

function lookupPath(url: string): string {
  return `/api/extension/opportunities/by-url?${new URLSearchParams({ url }).toString()}`;
}

/** A job row, optionally with an opportunity in `status` (null: dismissed). */
async function job({
  title,
  applyUrl,
  opportunity,
}: {
  title: string;
  applyUrl: string;
  opportunity: "saved" | "applied" | "dismissed" | "none";
}): Promise<OpportunityId | null> {
  const sql = testSql();
  const key = applyUrlKey(applyUrl);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, apply_url_key, description, content_hash, description_key)
    VALUES (${deps.userId}, 'paste', ${title}, 'Acme', ${title.toLowerCase()}, 'acme', ${applyUrl}, ${key}, 'Build things.', ${title}, ${title})
    RETURNING id`;
  if (!row) throw new Error("no job");
  if (opportunity === "none") return null;
  const status = opportunity === "dismissed" ? null : opportunity;
  const [opp] = await sql<{ id: OpportunityId }[]>`
    INSERT INTO opportunities (user_id, job_id, status, status_changed_at, dismissed_at, dismiss_reason)
    VALUES (${deps.userId}, ${row.id}, ${status}, ${NOW},
      ${status === null ? NOW : null}, ${status === null ? "other" : null})
    RETURNING id`;
  if (!opp) throw new Error("no opportunity");
  return opp.id;
}

/** Row counts of every table the lookup could plausibly write to. */
async function counts() {
  const [row] = await testSql()`
    SELECT (SELECT count(*)::int FROM jobs) AS jobs,
           (SELECT count(*)::int FROM opportunities) AS opportunities,
           (SELECT count(*)::int FROM outputs) AS outputs,
           (SELECT count(*)::int FROM application_sessions) AS sessions,
           (SELECT count(*)::int FROM tasks) AS tasks`;
  return row;
}

describe("GET /api/extension/opportunities/by-url", () => {
  test("an unknown URL is none and creates no rows", async () => {
    const token = await pair();
    const before = await counts();
    const res = await call({ path: lookupPath("https://jobs.lever.co/acme/456"), headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(LookupResult.parse(await res.json())).toEqual({ kind: "none" });
    expect(await counts()).toEqual(before);
  });

  test("a job on the board is found by its apply URL key, and nothing is written", async () => {
    const token = await pair();
    const opp = await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "saved" });
    const before = await counts();
    const [jobBefore] = await testSql()`SELECT * FROM jobs`;
    const [oppBefore] = await testSql()`SELECT * FROM opportunities`;

    const res = await call({ path: lookupPath(APPLY_URL_VARIANT), headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(LookupResult.parse(await res.json())).toEqual({
      kind: "found",
      opportunityId: opp,
      title: "Engineer",
      company: "Acme",
      status: "saved",
    });
    expect(await counts()).toEqual(before);
    expect((await testSql()`SELECT * FROM jobs`)[0]).toEqual(jobBefore);
    expect((await testSql()`SELECT * FROM opportunities`)[0]).toEqual(oppBefore);
  });

  test("an applied job reports its status", async () => {
    const token = await pair();
    const opp = await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "applied" });
    const res = await call({ path: lookupPath(APPLY_URL), headers: bearer(token) });
    expect(LookupResult.parse(await res.json())).toMatchObject({
      kind: "found",
      opportunityId: opp,
      status: "applied",
    });
  });

  test("a known job that is not on the board has a null status", async () => {
    const token = await pair();
    await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "none" });
    const res = await call({ path: lookupPath(APPLY_URL), headers: bearer(token) });
    expect(LookupResult.parse(await res.json())).toEqual({
      kind: "found",
      opportunityId: null,
      title: "Engineer",
      company: "Acme",
      status: null,
    });
  });

  test("a dismissed job keeps its opportunity id with a null status", async () => {
    const token = await pair();
    const opp = await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "dismissed" });
    const res = await call({ path: lookupPath(APPLY_URL), headers: bearer(token) });
    expect(LookupResult.parse(await res.json())).toMatchObject({ kind: "found", opportunityId: opp, status: null });
  });

  test("several jobs on one URL (a generic careers page) is none: import matches on the title", async () => {
    const token = await pair();
    await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "saved" });
    await job({ title: "Designer", applyUrl: APPLY_URL, opportunity: "saved" });
    const res = await call({ path: lookupPath(APPLY_URL), headers: bearer(token) });
    expect(LookupResult.parse(await res.json())).toEqual({ kind: "none" });
  });

  test("javascript:, data:, ftp: and malformed URLs are 400 and create no rows", async () => {
    const token = await pair();
    const before = await counts();
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/job", "not a url", ""]) {
      const res = await call({ path: lookupPath(url), headers: bearer(token) });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_input");
    }
    const missing = await call({ path: "/api/extension/opportunities/by-url", headers: bearer(token) });
    expect(missing.status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  test("without a bearer token it is 401", async () => {
    await job({ title: "Engineer", applyUrl: APPLY_URL, opportunity: "saved" });
    const res = await call({ path: lookupPath(APPLY_URL), headers: { origin: EXT_ORIGIN } });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/extension/import", () => {
  const PAGE = {
    url: APPLY_URL,
    title: "Engineer",
    company: "Acme",
    description: "Build and run the payments platform.",
  };

  test("creates a pasted job on the board, then finds it again", async () => {
    const token = await pair();
    const res = await call({ method: "POST", path: "/api/extension/import", headers: bearer(token), body: PAGE });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = AddJobResult.parse(await res.json());
    expect(created.kind).toBe("created");

    const [row] = await testSql()`
      SELECT j.origin, j.title, j.company, j.apply_url, j.apply_url_key, o.id AS opportunity_id, o.status
      FROM jobs j JOIN opportunities o ON o.job_id = j.id`;
    expect(row).toEqual({
      origin: "paste",
      title: "Engineer",
      company: "Acme",
      apply_url: APPLY_URL,
      apply_url_key: APPLY_URL,
      opportunity_id: created.opportunityId,
      status: "saved",
    });
    // The three file rows every board job gets, as with a paste in the web app.
    const [files] = await testSql()`SELECT count(*)::int AS n FROM outputs WHERE kind <> 'answer'`;
    expect(files?.n).toBe(3);

    const again = await call({
      method: "POST",
      path: "/api/extension/import",
      headers: bearer(token),
      body: { ...PAGE, url: APPLY_URL_VARIANT },
    });
    expect(again.status).toBe(200);
    expect(AddJobResult.parse(await again.json())).toEqual({ kind: "existing", opportunityId: created.opportunityId });

    const found = await call({ path: lookupPath(APPLY_URL_VARIANT), headers: bearer(token) });
    expect(LookupResult.parse(await found.json())).toEqual({
      kind: "found",
      opportunityId: created.opportunityId,
      title: "Engineer",
      company: "Acme",
      status: "saved",
    });
  });

  test("the URL is required and must be http(s)", async () => {
    const token = await pair();
    const { url: _omit, ...noUrl } = PAGE;
    for (const body of [noUrl, { ...PAGE, url: "javascript:alert(1)" }, { ...PAGE, url: "ftp://example.com/x" }]) {
      const res = await call({ method: "POST", path: "/api/extension/import", headers: bearer(token), body });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_input");
    }
    const [row] = await testSql()`SELECT count(*)::int AS n FROM jobs`;
    expect(row?.n).toBe(0);
  });

  test("without a bearer token it is 401 and creates nothing", async () => {
    const res = await call({
      method: "POST",
      path: "/api/extension/import",
      headers: { origin: EXT_ORIGIN },
      body: PAGE,
    });
    expect(res.status).toBe(401);
    const [row] = await testSql()`SELECT count(*)::int AS n FROM jobs`;
    expect(row?.n).toBe(0);
  });
});
