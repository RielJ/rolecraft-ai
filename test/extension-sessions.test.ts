import { beforeEach, describe, expect, test } from "bun:test";
import { applyUrlKey } from "@/domain/dedup";
import { createApp } from "@/server/http/app";
import { AppError, type Deps } from "@/server/services/context";
import { completeSession, requireClaimedSession } from "@/server/services/extension-sessions";
import { ApiErrorBody, type OpportunityId } from "@/shared/api";
import {
  ActiveSessionResponse,
  APPLICATION_SESSION_TTL_MS,
  type ApplicationSessionDto,
  ApplicationSessionId,
  ClaimPairingResult,
  ClaimSessionResult,
  CreatePairingResult,
  CreateSessionResult,
  PairingId,
  UrlMismatchDetails,
} from "@/shared/extension";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Task 4 of docs/plans/chrome-extension.md: the workspace Apply handoff. The SPA creates a
 * short-lived session; the paired extension finds it with GET sessions/active and claims it for
 * a tab whose URL key matches (or after the user confirms a mismatch).
 */

const APP_ORIGIN = "http://localhost";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT_ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const NOW = new Date("2026-10-16T08:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLAIMED_TTL_MS = 4 * HOUR;

// The stored apply URL carries tracking params on purpose: the server must hand it back as is.
const APPLY_URL_A = "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc&utm_source=hb";
const APPLY_URL_B = "https://jobs.lever.co/acme/456";
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

async function opportunity({ title, applyUrl }: { title: string; applyUrl: string | null }): Promise<OpportunityId> {
  const sql = testSql();
  const [job] = await sql<{ id: string }[]>`
    INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, description, content_hash, description_key)
    VALUES (${deps.userId}, 'paste', ${title}, 'Acme', ${title.toLowerCase()}, 'acme', ${applyUrl}, 'Build things.', ${title}, ${title})
    RETURNING id`;
  if (!job) throw new Error("no job");
  const [opp] = await sql<{ id: OpportunityId }[]>`
    INSERT INTO opportunities (user_id, job_id, status, status_changed_at)
    VALUES (${deps.userId}, ${job.id}, 'saved', ${NOW}) RETURNING id`;
  if (!opp) throw new Error("no opportunity");
  return opp.id;
}

/** Pair through the Task 3 routes: the SPA makes a code, the extension claims it. */
async function pair(origin = EXT_ORIGIN): Promise<ClaimPairingResult> {
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
  return ClaimPairingResult.parse(await claimed.json());
}

function bearer(token: string, origin = EXT_ORIGIN): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin };
}

/**
 * The URL-shaped strings a session response may carry: the stored apply URL, byte for byte, and
 * its dedup key. Anything else (say, the apply URL with a session param added) fails.
 */
function onlyStoredUrls(raw: unknown, applyUrl: string): void {
  const allowed = new Set([applyUrl]);
  const key = applyUrlKey(applyUrl);
  if (key !== null) allowed.add(key);
  expect(new Set(urlsIn(raw))).toEqual(allowed);
}

/** Every string in a response body that looks like a URL. */
function urlsIn(value: unknown): string[] {
  if (typeof value === "string") return /^[a-z][a-z0-9+.-]*:/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(urlsIn);
  return [];
}

/** Apply: the URL the server hands back must be the stored one, byte for byte, and the only URL. */
async function apply(opportunityId: OpportunityId, applyUrl: string): Promise<ApplicationSessionDto> {
  const res = await call({
    method: "POST",
    path: "/api/extension-web/sessions",
    headers: { origin: APP_ORIGIN },
    body: { opportunityId },
  });
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const raw: unknown = await res.json();
  onlyStoredUrls(raw, applyUrl);
  return CreateSessionResult.parse(raw).session;
}

async function active(token: string) {
  const res = await call({ path: "/api/extension/sessions/active", headers: bearer(token) });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const raw: unknown = await res.json();
  const parsed = ActiveSessionResponse.parse(raw);
  if (parsed.kind === "active") onlyStoredUrls(raw, parsed.session.applyUrl);
  return parsed;
}

function claim(
  token: string,
  sessionId: string,
  body: { tabUrl: string; confirmMismatch?: boolean },
  origin = EXT_ORIGIN,
) {
  return call({
    method: "POST",
    path: `/api/extension/sessions/${sessionId}/claim`,
    headers: bearer(token, origin),
    body,
  });
}

async function claimed(res: Response, applyUrl: string): Promise<ApplicationSessionDto> {
  expect(res.status).toBe(200);
  const raw: unknown = await res.json();
  onlyStoredUrls(raw, applyUrl);
  return ClaimSessionResult.parse(raw).session;
}

type SessionRow = {
  id: string;
  status: string;
  apply_url: string;
  apply_url_key: string;
  expires_at: Date;
  claimed_by_pairing_id: string | null;
  claimed_at: Date | null;
};

async function rows(): Promise<SessionRow[]> {
  return [
    ...(await testSql()<SessionRow[]>`
      SELECT id, status, apply_url, apply_url_key, expires_at, claimed_by_pairing_id, claimed_at
      FROM application_sessions ORDER BY created_at, id`),
  ];
}

describe("POST /api/extension-web/sessions (Apply)", () => {
  test("creates a pending session with the stored apply URL unchanged and a 15-minute window", async () => {
    const opp = await opportunity({ title: "Engineer", applyUrl: APPLY_URL_A });
    const session = await apply(opp, APPLY_URL_A);

    expect(session).toMatchObject({
      opportunityId: opp,
      status: "pending",
      applyUrl: APPLY_URL_A,
      applyUrlKey: "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc",
      title: "Engineer",
      company: "Acme",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + APPLICATION_SESSION_TTL_MS).toISOString(),
      claimedAt: null,
    });
    expect(await rows()).toEqual([
      {
        id: session.id,
        status: "pending",
        apply_url: APPLY_URL_A,
        apply_url_key: "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc",
        expires_at: new Date(NOW.getTime() + APPLICATION_SESSION_TTL_MS),
        claimed_by_pairing_id: null,
        claimed_at: null,
      },
    ]);
  });

  test("a job without an apply link is 400; an unknown opportunity is 404", async () => {
    const noLink = await opportunity({ title: "No link", applyUrl: null });
    const bad = await opportunity({ title: "Bad link", applyUrl: "mailto:jobs@acme.example" });
    for (const opportunityId of [noLink, bad]) {
      const res = await call({
        method: "POST",
        path: "/api/extension-web/sessions",
        headers: { origin: APP_ORIGIN },
        body: { opportunityId },
      });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_input");
    }

    const res = await call({
      method: "POST",
      path: "/api/extension-web/sessions",
      headers: { origin: APP_ORIGIN },
      body: { opportunityId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
    expect(await rows()).toEqual([]);
  });

  test("a non-JSON or foreign-origin request creates nothing", async () => {
    const opp = await opportunity({ title: "Engineer", applyUrl: APPLY_URL_A });
    const plain = await app.request("/api/extension-web/sessions", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ opportunityId: opp }),
    });
    expect(plain.status).toBe(403);
    const foreign = await call({
      method: "POST",
      path: "/api/extension-web/sessions",
      headers: { origin: "https://evil.example" },
      body: { opportunityId: opp },
    });
    expect(foreign.status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  test("Apply A then B within a minute: B is active, A is expired", async () => {
    const { token } = await pair();
    const a = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(30_000);
    const b = await apply(await opportunity({ title: "B", applyUrl: APPLY_URL_B }), APPLY_URL_B);

    const found = await active(token);
    expect(found).toMatchObject({ kind: "active", session: { id: b.id, status: "pending", title: "B" } });
    expect((await rows()).map((r) => [r.id, r.status])).toEqual([
      [a.id, "expired"],
      [b.id, "pending"],
    ]);

    const late = await claim(token, a.id, { tabUrl: APPLY_URL_A });
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("session_expired");
  });

  test("a new Apply supersedes a claimed session too", async () => {
    const { token } = await pair();
    const a = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    await claimed(await claim(token, a.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(30_000);
    const b = await apply(await opportunity({ title: "B", applyUrl: APPLY_URL_B }), APPLY_URL_B);

    expect((await rows()).map((r) => [r.id, r.status])).toEqual([
      [a.id, "expired"],
      [b.id, "pending"],
    ]);
    const again = await claim(token, a.id, { tabUrl: APPLY_URL_A });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("session_expired");
  });
});

describe("GET /api/extension/sessions/active", () => {
  test("none before any Apply", async () => {
    const { token } = await pair();
    expect(await active(token)).toEqual({ kind: "none" });
  });

  test("an unclaimed session past its 15 minutes expires lazily", async () => {
    const { token } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(APPLICATION_SESSION_TTL_MS - 1000);
    expect(await active(token)).toMatchObject({ kind: "active", session: { id: s.id } });
    advance(2000);
    expect(await active(token)).toEqual({ kind: "none" });
    expect((await rows()).map((r) => r.status)).toEqual(["expired"]);
  });
});

describe("POST /api/extension/sessions/:id/claim", () => {
  test("a tab whose URL key matches claims the session for this pairing", async () => {
    const { token, pairingId } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(MINUTE);

    // Tracking params, hash and a trailing slash do not change the key.
    const tabUrl = "https://BOARDS.greenhouse.io/acme/jobs/123/?utm_medium=x&gh_src=abc#apply";
    const session = await claimed(await claim(token, s.id, { tabUrl }), APPLY_URL_A);
    expect(session).toMatchObject({
      id: s.id,
      status: "claimed",
      applyUrl: APPLY_URL_A,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CLAIMED_TTL_MS).toISOString(),
    });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "claimed", claimed_by_pairing_id: pairingId, claimed_at: now });
    expect(await active(token)).toMatchObject({ kind: "active", session: { id: s.id, status: "claimed" } });
  });

  test("a mismatched tab URL is 409 url_mismatch until the user confirms", async () => {
    const { token } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    const tabUrl = "https://boards.greenhouse.io/acme/jobs/999";

    const refused = await claim(token, s.id, { tabUrl });
    expect(refused.status).toBe(409);
    const error = await errorOf(refused);
    expect(error.code).toBe("url_mismatch");
    expect(UrlMismatchDetails.parse(error.details)).toEqual({
      sessionUrlKey: "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc",
      tabUrlKey: "https://boards.greenhouse.io/acme/jobs/999",
    });
    expect((await rows()).map((r) => r.status)).toEqual(["pending"]);

    const unconfirmed = await claim(token, s.id, { tabUrl, confirmMismatch: false });
    expect(unconfirmed.status).toBe(409);

    const session = await claimed(await claim(token, s.id, { tabUrl, confirmMismatch: true }), APPLY_URL_A);
    expect(session.status).toBe("claimed");
  });

  test("claiming an expired session is 409 session_expired", async () => {
    const { token } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(APPLICATION_SESSION_TTL_MS + 1000);
    const res = await claim(token, s.id, { tabUrl: APPLY_URL_A });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("session_expired");
    expect(await rows()).toMatchObject([{ status: "expired", claimed_at: null, claimed_by_pairing_id: null }]);
  });

  test("claim at 14 minutes works, holds at 3 hours, and expires 4 hours after the claim", async () => {
    const { token } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(14 * MINUTE);
    const claimedAt = now;
    await claimed(await claim(token, s.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);

    advance(3 * HOUR);
    expect(await active(token)).toMatchObject({ kind: "active", session: { id: s.id, status: "claimed" } });

    now = new Date(claimedAt.getTime() + CLAIMED_TTL_MS + 1000);
    expect(await active(token)).toEqual({ kind: "none" });
    expect((await rows()).map((r) => r.status)).toEqual(["expired"]);
    const res = await claim(token, s.id, { tabUrl: APPLY_URL_A });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("session_expired");
  });

  test("re-claim by the same pairing is idempotent and does not extend the expiry", async () => {
    const { token } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    const first = await claimed(await claim(token, s.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);
    advance(HOUR);
    const second = await claimed(await claim(token, s.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);
    expect(second).toEqual(first);
  });

  test("another pairing cannot claim a session this pairing holds", async () => {
    const mine = await pair();
    const other = await pair(OTHER_EXT_ORIGIN);
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    await claimed(await claim(mine.token, s.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);

    const res = await claim(other.token, s.id, { tabUrl: APPLY_URL_A, confirmMismatch: true }, OTHER_EXT_ORIGIN);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
    expect(await rows()).toMatchObject([{ status: "claimed", claimed_by_pairing_id: mine.pairingId }]);
  });

  test("an unknown session is 404; a non-http tab URL is 400", async () => {
    const { token } = await pair();
    const unknown = await claim(token, UNKNOWN_SESSION, { tabUrl: APPLY_URL_A });
    expect(unknown.status).toBe(404);

    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    const bad = await claim(token, s.id, { tabUrl: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    const missing = await call({
      method: "POST",
      path: `/api/extension/sessions/${s.id}/claim`,
      headers: bearer(token),
      body: {},
    });
    expect(missing.status).toBe(400);
    expect((await rows()).map((r) => r.status)).toEqual(["pending"]);
  });
});

/** The AppError code a call fails with. Await inside: Bun's `.rejects` hangs on postgres.js queries. */
async function appErrorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`;
  }
  return "succeeded";
}

/** Apply and claim through HTTP; ids as the services take them. */
async function claimedSession() {
  const mine = await pair();
  const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
  advance(MINUTE);
  const claimedAt = now;
  await claimed(await claim(mine.token, s.id, { tabUrl: APPLY_URL_A }), APPLY_URL_A);
  return {
    id: ApplicationSessionId.parse(s.id),
    pairingId: PairingId.parse(mine.pairingId),
    opportunityId: s.opportunityId,
    claimedAt,
  };
}

describe("requireClaimedSession (for Tasks 6 and 7)", () => {
  test("returns the session claimed by this pairing", async () => {
    const { id, pairingId, opportunityId, claimedAt } = await claimedSession();
    advance(HOUR);
    expect(await requireClaimedSession(deps, { id, pairingId })).toEqual({
      id,
      opportunityId,
      applyUrl: APPLY_URL_A,
      applyUrlKey: "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc",
      claimedAt,
      expiresAt: new Date(claimedAt.getTime() + CLAIMED_TTL_MS),
    });
  });

  test("an unknown session, or one another pairing holds, is not_found", async () => {
    const { id } = await claimedSession();
    const other = await pair(OTHER_EXT_ORIGIN);
    const otherId = PairingId.parse(other.pairingId);
    expect(await appErrorCode(() => requireClaimedSession(deps, { id, pairingId: otherId }))).toBe("not_found");
    const unknown = ApplicationSessionId.parse(UNKNOWN_SESSION);
    expect(await appErrorCode(() => requireClaimedSession(deps, { id: unknown, pairingId: otherId }))).toBe(
      "not_found",
    );
  });

  test("a pending session is session_expired: it must be claimed first", async () => {
    const { pairingId } = await pair();
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    const id = ApplicationSessionId.parse(s.id);
    expect(await appErrorCode(() => requireClaimedSession(deps, { id, pairingId: PairingId.parse(pairingId) }))).toBe(
      "session_expired",
    );
  });

  test("past the claimed window it expires lazily and is session_expired", async () => {
    const { id, pairingId, claimedAt } = await claimedSession();
    now = new Date(claimedAt.getTime() + CLAIMED_TTL_MS + 1000);
    expect(await appErrorCode(() => requireClaimedSession(deps, { id, pairingId }))).toBe("session_expired");
    expect((await rows()).map((r) => r.status)).toEqual(["expired"]);
  });

  test("a session superseded by a new Apply is session_expired", async () => {
    const { id, pairingId } = await claimedSession();
    await apply(await opportunity({ title: "B", applyUrl: APPLY_URL_B }), APPLY_URL_B);
    expect(await appErrorCode(() => requireClaimedSession(deps, { id, pairingId }))).toBe("session_expired");
  });
});

describe("completeSession (for Task 7)", () => {
  test("inside a transaction, completes a claimed session once", async () => {
    const { id, pairingId, claimedAt } = await claimedSession();
    advance(MINUTE);
    const completedAt = now;

    expect(await deps.db.transaction((tx) => completeSession(tx, { id, now: completedAt }))).toBe(true);
    const [row] = await testSql()<{ status: string; claimed_at: Date; completed_at: Date | null }[]>`
      SELECT status, claimed_at, completed_at FROM application_sessions WHERE id = ${id}`;
    expect(row).toEqual({ status: "completed", claimed_at: claimedAt, completed_at: completedAt });

    advance(MINUTE);
    expect(await completeSession(deps.db, { id, now })).toBe(false);
    const [again] = await testSql()<{ completed_at: Date }[]>`
      SELECT completed_at FROM application_sessions WHERE id = ${id}`;
    expect(again?.completed_at).toEqual(completedAt);

    expect(await appErrorCode(() => requireClaimedSession(deps, { id, pairingId }))).toBe("session_expired");
    const { token } = await pair();
    expect(await active(token)).toEqual({ kind: "none" });
  });

  test("a pending or expired session is left as it is", async () => {
    const s = await apply(await opportunity({ title: "A", applyUrl: APPLY_URL_A }), APPLY_URL_A);
    const id = ApplicationSessionId.parse(s.id);
    expect(await completeSession(deps.db, { id, now })).toBe(false);
    expect((await rows()).map((r) => r.status)).toEqual(["pending"]);

    advance(APPLICATION_SESSION_TTL_MS + 1000);
    const { token } = await pair();
    expect(await active(token)).toEqual({ kind: "none" });
    expect(await completeSession(deps.db, { id, now })).toBe(false);
    expect((await rows()).map((r) => r.status)).toEqual(["expired"]);
  });
});
