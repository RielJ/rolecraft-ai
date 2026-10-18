import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type postgres from "postgres";
import { applicationPreferences, applicationSessions, extensionPairings, outputs } from "@/server/db/schema";
import type { Deps } from "@/server/services/context";
import type { OpportunityId, UserId } from "@/shared/api";
import { APPLICATION_SESSION_STATUSES, PREFILL_CATEGORY_KEYS } from "@/shared/extension";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Task 2 of docs/plans/chrome-extension.md: migration 0008 adds extension_pairings,
 * application_sessions, application_preferences and outputs.reviewed_at. These tests pin the
 * constraints the services rely on, and that sync (hb_sync) gets no grant on the new tables.
 */

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

const NOW = new Date("2026-10-16T08:00:00Z");
const LATER = new Date("2026-10-16T08:15:00Z");
const ORIGIN = `chrome-extension://${"a".repeat(32)}`;

let deps: Deps;
let userId: UserId;

async function opportunity(title: string): Promise<OpportunityId> {
  const [job] = await testSql()<{ id: string }[]>`
    INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, content_hash, description_key)
    VALUES (${userId}, 'paste', ${title}, 'Acme', ${title.toLowerCase()}, 'acme', 'Build things.', ${title}, ${title})
    RETURNING id`;
  if (!job) throw new Error("no job");
  const [opp] = await testSql()<{ id: OpportunityId }[]>`
    INSERT INTO opportunities (user_id, job_id, status, status_changed_at)
    VALUES (${userId}, ${job.id}, 'saved', ${NOW}) RETURNING id`;
  if (!opp) throw new Error("no opportunity");
  return opp.id;
}

beforeEach(async () => {
  await resetDb();
  deps = await testDeps();
  userId = deps.userId;
});

describe("outputs.reviewed_at", () => {
  test("is a nullable timestamptz that defaults to null", async () => {
    const [col] = await testSql()<{ type: string; nullable: string; def: string | null }[]>`
      SELECT data_type AS type, is_nullable AS nullable, column_default AS def FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'outputs' AND column_name = 'reviewed_at'`;
    expect(col).toEqual({ type: "timestamp with time zone", nullable: "YES", def: null });

    const opp = await opportunity("Engineer");
    const [row] = await deps.db
      .insert(outputs)
      .values({ userId, opportunityId: opp, kind: "resume" })
      .returning({ reviewedAt: outputs.reviewedAt });
    expect(row?.reviewedAt).toBeNull();
  });
});

describe("extension_pairings", () => {
  test("a waiting pairing has no origin or token; claiming sets both", async () => {
    const [waiting] = await deps.db
      .insert(extensionPairings)
      .values({ userId, codeHash: "code-1", codeExpiresAt: LATER })
      .returning();
    expect(waiting).toMatchObject({ extensionOrigin: null, tokenHash: null, claimedAt: null, revokedAt: null });
    if (!waiting) throw new Error("no pairing");

    const [claimed] = await deps.db
      .update(extensionPairings)
      .set({ extensionOrigin: ORIGIN, tokenHash: "token-1", claimedAt: NOW })
      .where(eq(extensionPairings.id, waiting.id))
      .returning();
    expect(claimed).toMatchObject({ extensionOrigin: ORIGIN, tokenHash: "token-1" });
  });

  test("claim fields come together, origins are chrome-extension ids, hashes are unique", async () => {
    const insert = (cols: string, values: string) => () =>
      testSql().unsafe(
        `INSERT INTO extension_pairings (user_id, code_hash, code_expires_at, ${cols}) VALUES ($1, $2, now(), ${values})`,
        [userId, crypto.randomUUID()],
      );
    expect(await failure(insert("token_hash", "'t'"))).toBe("23514");
    expect(await failure(insert("claimed_at, token_hash", "now(), 't'"))).toBe("23514");
    expect(await failure(insert("last_used_at", "now()"))).toBe("23514");
    expect(
      await failure(insert("extension_origin, token_hash, claimed_at", "'https://evil.example', 't', now()")),
    ).toBe("23514");
    expect(await failure(insert("extension_origin, token_hash, claimed_at", `'${ORIGIN}', 't1', now()`))).toBe(
      "succeeded",
    );
    expect(await failure(insert("extension_origin, token_hash, claimed_at", `'${ORIGIN}', 't1', now()`))).toBe("23505");
    expect(
      await failure(
        () =>
          testSql()`INSERT INTO extension_pairings (user_id, code_hash, code_expires_at) VALUES
          (${userId}, 'same', now()), (${userId}, 'same', now())`,
      ),
    ).toBe("23505");
  });
});

describe("application_sessions", () => {
  test("accepts every shared status and nothing else", async () => {
    const opp = await opportunity("Engineer");
    const results: Record<string, string> = {};
    for (const status of [...APPLICATION_SESSION_STATUSES, "applied"]) {
      results[status] = await failure(() =>
        testSql().begin(async (tx) => {
          await tx`
            INSERT INTO application_sessions
              (user_id, opportunity_id, apply_url, apply_url_key, status, expires_at, claimed_at, completed_at)
            VALUES (${userId}, ${opp}, 'https://jobs.example/1', 'jobs.example/1', ${status}, ${LATER},
              ${status === "pending" ? null : NOW}, ${status === "completed" ? NOW : null})`;
          throw new Error("rollback");
        }),
      );
    }
    expect(results).toEqual({
      pending: "no SQLSTATE: Error: rollback",
      claimed: "no SQLSTATE: Error: rollback",
      completed: "no SQLSTATE: Error: rollback",
      expired: "no SQLSTATE: Error: rollback",
      applied: "23514",
    });
  });

  test("timestamps agree with the status", async () => {
    const opp = await opportunity("Engineer");
    const insert = (status: string, claimed: Date | null, completed: Date | null) => () =>
      testSql()`
        INSERT INTO application_sessions
          (user_id, opportunity_id, apply_url, apply_url_key, status, expires_at, claimed_at, completed_at)
        VALUES (${userId}, ${opp}, 'https://jobs.example/1', 'jobs.example/1', ${status}, ${LATER}, ${claimed}, ${completed})`;
    expect(await failure(insert("pending", NOW, null))).toBe("23514");
    expect(await failure(insert("claimed", null, null))).toBe("23514");
    expect(await failure(insert("completed", NOW, null))).toBe("23514");
    expect(await failure(insert("expired", null, NOW))).toBe("23514");
  });

  test("one live (pending or claimed) session per user; expired and completed ones pile up", async () => {
    const a = await opportunity("A");
    const b = await opportunity("B");
    const base = { userId, applyUrl: "https://jobs.example/a", applyUrlKey: "jobs.example/a", expiresAt: LATER };
    const [first] = await deps.db
      .insert(applicationSessions)
      .values({ ...base, opportunityId: a })
      .returning();
    expect(first?.status).toBe("pending");
    if (!first) throw new Error("no session");

    expect(
      await failure(() =>
        deps.db.insert(applicationSessions).values({ ...base, opportunityId: b, status: "claimed", claimedAt: NOW }),
      ),
    ).toBe("23505");

    // What Task 4 does in one transaction: expire the earlier session, then insert.
    await deps.db.transaction(async (tx) => {
      await tx.update(applicationSessions).set({ status: "expired" }).where(eq(applicationSessions.id, first.id));
      await tx.insert(applicationSessions).values({ ...base, opportunityId: b });
    });
    await deps.db.insert(applicationSessions).values({ ...base, opportunityId: a, status: "expired" });
    const rows = await testSql()<{ status: string }[]>`SELECT status FROM application_sessions ORDER BY status`;
    expect(rows.map((r) => r.status)).toEqual(["expired", "expired", "pending"]);
  });

  test("deleting the opportunity deletes its sessions; deleting the pairing keeps the session", async () => {
    const opp = await opportunity("Engineer");
    const [pairing] = await deps.db
      .insert(extensionPairings)
      .values({ userId, codeHash: "c", codeExpiresAt: LATER, extensionOrigin: ORIGIN, tokenHash: "t", claimedAt: NOW })
      .returning();
    if (!pairing) throw new Error("no pairing");
    await deps.db.insert(applicationSessions).values({
      userId,
      opportunityId: opp,
      applyUrl: "https://jobs.example/1",
      applyUrlKey: "jobs.example/1",
      expiresAt: LATER,
      status: "claimed",
      claimedAt: NOW,
      claimedByPairingId: pairing.id,
    });
    await deps.db.delete(extensionPairings).where(eq(extensionPairings.id, pairing.id));
    const [kept] = await testSql()<
      { by: string | null }[]
    >`SELECT claimed_by_pairing_id AS by FROM application_sessions`;
    expect(kept).toEqual({ by: null });

    await testSql()`DELETE FROM opportunities WHERE id = ${opp}`;
    expect(await testSql()`SELECT 1 FROM application_sessions`).toHaveLength(0);
  });
});

describe("application_preferences", () => {
  const text = (value: string) => ({ valueType: "text" as const, value });

  test("category CHECK matches PREFILL_CATEGORY_KEYS exactly; salary is rejected", async () => {
    for (const category of PREFILL_CATEGORY_KEYS) {
      await deps.db
        .insert(applicationPreferences)
        .values({ userId, category, typedValue: text("x"), displayText: "x" });
    }
    const insert = (category: string) => () =>
      testSql()`
        INSERT INTO application_preferences (user_id, category, typed_value, display_text)
        VALUES (${userId}, ${category}, '{"valueType":"text","value":"x"}'::jsonb, 'x')`;
    expect(await failure(insert("salary"))).toBe("23514");
    expect(await failure(insert("compensation"))).toBe("23514");
    expect(await testSql()`SELECT 1 FROM application_preferences`).toHaveLength(PREFILL_CATEGORY_KEYS.length);
  });

  test("typed_value needs a known valueType and display_text cannot be blank", async () => {
    const insert = (typed: postgres.JSONValue, display: string) => () =>
      testSql()`
        INSERT INTO application_preferences (user_id, category, typed_value, display_text)
        VALUES (${userId}, 'email', ${testSql().json(typed)}, ${display})`;
    expect(await failure(insert({ valueType: "number", value: 1 }, "1"))).toBe("23514");
    expect(await failure(insert("bare string", "x"))).toBe("23514");
    expect(await failure(insert({ valueType: "text", value: "a@b.c" }, "  "))).toBe("23514");
    expect(await failure(insert({ valueType: "text", value: "a@b.c" }, "a@b.c"))).toBe("succeeded");
    const [stored] = await testSql()<
      { t: string }[]
    >`SELECT jsonb_typeof(typed_value) AS t FROM application_preferences`;
    expect(stored).toEqual({ t: "object" });
  });

  test("one global and one per-job answer per category", async () => {
    const a = await opportunity("A");
    const b = await opportunity("B");
    const pref = (opportunityId: OpportunityId | null) => () =>
      deps.db
        .insert(applicationPreferences)
        .values({ userId, opportunityId, category: "notice_period", typedValue: text("30 days"), displayText: "30" });
    expect(await failure(pref(null))).toBe("succeeded");
    expect(await failure(pref(null))).toBe("23505");
    expect(await failure(pref(a))).toBe("succeeded");
    expect(await failure(pref(a))).toBe("23505");
    expect(await failure(pref(b))).toBe("succeeded");

    // Upsert targets for Task 6.
    await deps.db
      .insert(applicationPreferences)
      .values({ userId, category: "notice_period", typedValue: text("60 days"), displayText: "60" })
      .onConflictDoUpdate({
        target: [applicationPreferences.userId, applicationPreferences.category],
        targetWhere: sql`opportunity_id IS NULL`,
        set: { displayText: "60" },
      });
    await deps.db
      .insert(applicationPreferences)
      .values({ userId, opportunityId: a, category: "notice_period", typedValue: text("1"), displayText: "1" })
      .onConflictDoUpdate({
        target: [applicationPreferences.userId, applicationPreferences.opportunityId, applicationPreferences.category],
        targetWhere: sql`opportunity_id IS NOT NULL`,
        set: { displayText: "1" },
      });
    const rows = await testSql()<{ job: string | null; display: string }[]>`
      SELECT opportunity_id AS job, display_text AS display FROM application_preferences ORDER BY display_text`;
    expect(rows.map((r) => [r.job === null ? "global" : r.job === a ? "a" : "b", r.display])).toEqual([
      ["a", "1"],
      ["b", "30"],
      ["global", "60"],
    ]);

    await testSql()`DELETE FROM opportunities WHERE id = ${a}`;
    expect(await testSql()`SELECT 1 FROM application_preferences`).toHaveLength(2);
  });
});

test("sync (hb_sync) has no privilege on the new tables or on outputs.reviewed_at", async () => {
  const rows = await testSql()<{ t: string; p: string }[]>`
    SELECT table_name AS t, privilege_type AS p FROM information_schema.column_privileges
    WHERE grantee = 'hb_sync' AND table_schema = 'public'
      AND (table_name IN ('extension_pairings', 'application_sessions', 'application_preferences')
        OR (table_name = 'outputs' AND column_name = 'reviewed_at'))`;
  expect(rows.map((r) => `${r.t}:${r.p}`)).toEqual([]);
});
