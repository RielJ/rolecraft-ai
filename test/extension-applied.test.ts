import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ApiErrorBody, type OpportunityId } from "@/shared/api";
import {
  ClaimPairingResult,
  ClaimSessionResult,
  ConfirmAppliedResult,
  CreatePairingResult,
  CreateSessionResult,
} from "@/shared/extension";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Task 7 of docs/plans/chrome-extension.md: POST sessions/:id/confirm-applied. Only the user's
 * Yes calls it. It moves the opportunity to Applied the way the board does (history, snapshot,
 * frozen standard answers) and completes the session, in one transaction. A repeat for the same
 * session answers the already-applied result instead of an error.
 */

const APP_ORIGIN = "http://localhost";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT_ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const NOW = new Date("2026-10-16T08:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const APPLY_URL = "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc";
const DESCRIPTION = "Build and run the payments platform.";
const UNKNOWN_SESSION = "00000000-0000-4000-8000-000000000009";

let now: Date;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  now = NOW;
  deps = await testDeps({ clock: { now: () => now } });
  app = createApp(deps);
});

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

type Call = { method?: string; path: string; headers?: Record<string, string>; body?: unknown };

function call({ method = "GET", path, headers = {}, body }: Call) {
  const sent = new Headers(headers);
  if (body !== undefined && !sent.has("content-type")) sent.set("content-type", "application/json");
  return app.request(path, {
    method,
    headers: sent,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errorOf(res: Response) {
  return ApiErrorBody.parse(await res.json()).error;
}

function bearer(token: string, origin = EXT_ORIGIN): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin };
}

async function pair(origin = EXT_ORIGIN): Promise<string> {
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
    headers: { origin },
    body: { code },
  });
  expect(claimed.status).toBe(200);
  return ClaimPairingResult.parse(await claimed.json()).token;
}

/** A saved job with a notice must-answer row, and a standard notice answer on the profile. */
async function opportunity(): Promise<OpportunityId> {
  const sql = testSql();
  await sql`UPDATE users SET standard_answers = ${sql.json({ notice: "Two weeks" })} WHERE id = ${deps.userId}`;
  const [job] = await sql<{ id: string }[]>`
    INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, description, content_hash, description_key)
    VALUES (${deps.userId}, 'paste', 'Engineer', 'Acme', 'engineer', 'acme', ${APPLY_URL}, ${DESCRIPTION}, 'h', 'd')
    RETURNING id`;
  if (!job) throw new Error("no job");
  const [opp] = await sql<{ id: OpportunityId }[]>`
    INSERT INTO opportunities (user_id, job_id, status, status_changed_at, history)
    VALUES (${deps.userId}, ${job.id}, 'saved', ${NOW},
      ${sql.json([{ at: NOW.toISOString(), from: null, to: "saved" }])})
    RETURNING id`;
  if (!opp) throw new Error("no opportunity");
  await sql`
    INSERT INTO outputs (user_id, opportunity_id, kind, question, must_answer, position)
    VALUES (${deps.userId}, ${opp.id}, 'answer', 'What is your notice period?', 'notice', 0)`;
  return opp.id;
}

/** Apply in the SPA, then claim from the extension: the session confirm-applied acts on. */
async function claimedSession(opportunityId: OpportunityId, token: string, origin = EXT_ORIGIN): Promise<string> {
  const created = await call({
    method: "POST",
    path: "/api/extension-web/sessions",
    headers: { origin: APP_ORIGIN },
    body: { opportunityId },
  });
  expect(created.status).toBe(201);
  const { session } = CreateSessionResult.parse(await created.json());
  const claimed = await call({
    method: "POST",
    path: `/api/extension/sessions/${session.id}/claim`,
    headers: bearer(token, origin),
    body: { tabUrl: APPLY_URL },
  });
  expect(claimed.status).toBe(200);
  return ClaimSessionResult.parse(await claimed.json()).session.id;
}

function confirm(
  token: string,
  sessionId: string,
  origin = EXT_ORIGIN,
  body: unknown = { reason: "confirmation_url" },
) {
  return call({
    method: "POST",
    path: `/api/extension/sessions/${sessionId}/confirm-applied`,
    headers: bearer(token, origin),
    body,
  });
}

async function confirmed(res: Response): Promise<ConfirmAppliedResult> {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return ConfirmAppliedResult.parse(await res.json());
}

async function opportunityRow() {
  const [row] = await testSql()`SELECT status, status_changed_at, history, applied_snapshot FROM opportunities`;
  return row;
}

async function sessionRow() {
  const [row] = await testSql()`SELECT status, completed_at FROM application_sessions`;
  return row;
}

async function noticeBody(): Promise<string | null> {
  const [row] = await testSql()<{ body: string | null }[]>`SELECT body FROM outputs WHERE must_answer = 'notice'`;
  return row?.body ?? null;
}

describe("POST /api/extension/sessions/:id/confirm-applied", () => {
  test("moves the job to Applied with history and snapshot, freezes answers, completes the session", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    advance(10 * MINUTE);

    expect(await confirmed(await confirm(token, session))).toEqual({
      opportunityId: opp,
      status: "applied",
      changed: true,
    });
    expect(await opportunityRow()).toEqual({
      status: "applied",
      status_changed_at: now,
      history: [
        { at: NOW.toISOString(), from: null, to: "saved" },
        { at: now.toISOString(), from: "saved", to: "applied" },
      ],
      applied_snapshot: {
        title: "Engineer",
        company: "Acme",
        description: DESCRIPTION,
        applyUrl: APPLY_URL,
        at: now.toISOString(),
      },
    });
    expect(await noticeBody()).toBe("Two weeks");
    expect(await sessionRow()).toEqual({ status: "completed", completed_at: now });
  });

  test("a repeat confirm for the same session is the already-applied result, with no second history entry", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    await confirmed(await confirm(token, session));
    const after = await opportunityRow();
    advance(MINUTE);

    expect(await confirmed(await confirm(token, session))).toEqual({
      opportunityId: opp,
      status: "applied",
      changed: false,
    });
    expect(await opportunityRow()).toEqual(after);
    expect(await sessionRow()).toEqual({ status: "completed", completed_at: NOW });
  });

  test("two confirms at once: both succeed, one changes it, one history entry", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);

    const results = await Promise.all([confirm(token, session), confirm(token, session)]);
    const bodies = await Promise.all(results.map(confirmed));
    expect(bodies.map((b) => b.changed).sort()).toEqual([false, true]);
    expect(bodies.every((b) => b.opportunityId === opp && b.status === "applied")).toBe(true);
    const row = await opportunityRow();
    expect(row?.history).toHaveLength(2);
  });

  test("a job already past Applied stays where it is; the session still completes", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    const moved = await call({
      method: "POST",
      path: `/api/opportunities/${opp}/status`,
      body: { status: "interviewing" },
    });
    expect(moved.status).toBe(200);
    const before = await opportunityRow();

    expect(await confirmed(await confirm(token, session))).toEqual({
      opportunityId: opp,
      status: "interviewing",
      changed: false,
    });
    expect(await opportunityRow()).toEqual(before);
    expect((await sessionRow())?.status).toBe("completed");
  });

  test("after the user moves it back to Saved, replaying a completed session is session_expired", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    await confirmed(await confirm(token, session));
    const back = await call({ method: "POST", path: `/api/opportunities/${opp}/status`, body: { status: "saved" } });
    expect(back.status).toBe(200);

    const res = await confirm(token, session);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("session_expired");
    expect((await opportunityRow())?.status).toBe("saved");
  });

  test("a pending (unclaimed) session is session_expired and changes nothing", async () => {
    const token = await pair();
    const opp = await opportunity();
    const created = await call({
      method: "POST",
      path: "/api/extension-web/sessions",
      headers: { origin: APP_ORIGIN },
      body: { opportunityId: opp },
    });
    const { session } = CreateSessionResult.parse(await created.json());

    const res = await confirm(token, session.id);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("session_expired");
    expect((await opportunityRow())?.status).toBe("saved");
    expect((await sessionRow())?.status).toBe("pending");
  });

  test("a claimed session past its window is session_expired", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    advance(5 * HOUR);

    const res = await confirm(token, session);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("session_expired");
    expect((await opportunityRow())?.status).toBe("saved");
    expect((await sessionRow())?.status).toBe("expired");
  });

  test("another pairing gets 404, before and after completion", async () => {
    const token = await pair();
    const other = await pair(OTHER_EXT_ORIGIN);
    const opp = await opportunity();
    const session = await claimedSession(opp, token);

    const before = await confirm(other, session, OTHER_EXT_ORIGIN);
    expect(before.status).toBe(404);
    expect((await errorOf(before)).code).toBe("not_found");
    expect((await opportunityRow())?.status).toBe("saved");

    await confirmed(await confirm(token, session));
    const after = await confirm(other, session, OTHER_EXT_ORIGIN);
    expect(after.status).toBe(404);
  });

  test("an unknown session is 404", async () => {
    const token = await pair();
    const res = await confirm(token, UNKNOWN_SESSION);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });

  test("a dismissed job is 400 and the session stays claimed (one transaction)", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    await testSql()`UPDATE opportunities SET status = NULL, dismissed_at = ${NOW}`;

    const res = await confirm(token, session);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_input");
    expect(await sessionRow()).toEqual({ status: "claimed", completed_at: null });
  });

  test("the body must be { reason }; anything else is 400", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    for (const body of [{}, { reason: "clicked_submit" }, { reason: null, status: "offer" }]) {
      const res = await confirm(token, session, EXT_ORIGIN, body);
      expect(res.status).toBe(400);
    }
    expect((await opportunityRow())?.status).toBe("saved");
    expect(await confirmed(await confirm(token, session, EXT_ORIGIN, { reason: null }))).toMatchObject({
      changed: true,
    });
  });

  test("without a bearer token it is 401", async () => {
    const token = await pair();
    const opp = await opportunity();
    const session = await claimedSession(opp, token);
    const res = await call({
      method: "POST",
      path: `/api/extension/sessions/${session}/confirm-applied`,
      headers: { origin: EXT_ORIGIN },
      body: { reason: null },
    });
    expect(res.status).toBe(401);
    expect((await opportunityRow())?.status).toBe("saved");
  });
});
