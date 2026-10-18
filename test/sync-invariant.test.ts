import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AiProviderClient } from "@/server/adapters/ai/types";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { asSync } from "@/server/db/sync-session";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  type OpportunityId,
  type OutputId,
  ProfileDto,
  RefreshDto,
  SettingsDto,
  TaskDto,
  WorkspaceDto,
} from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Sync never writes user data (PLAN.md section 2, "What sync may write"). Three parts:
 *  (a) the grants of `hb_sync` are exactly the table in the plan, so a sloppy grant fails the build;
 *  (b) as `hb_sync`, every write outside that table fails with SQLSTATE 42501;
 *  (c) refresh runs through fixture sources in six scenarios, and every row of every table outside
 *      {jobs, job_listings, sources, ai_calls, tasks, role_drops} hashes the same before and after
 *      each one. That includes `eligibility_overrides` (slice 13), which sync can neither read nor write.
 *      The AI eligibility pass is on (slice 10), with an AI that decides every job it is asked
 *      about, so its `ai_calls` inserts and `jobs` updates run as `hb_sync` in these scenarios.
 * The table lists come from the catalog, so a new table is covered without editing this file.
 * Nothing here reaches the network: the HTTP client gets a fetch that serves fixture files.
 */

const SYNC_TABLES = ["jobs", "job_listings", "sources", "ai_calls", "tasks", "role_drops"];

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

async function publicTables(): Promise<string[]> {
  const rows = await testSql()<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  return rows.map((r) => r.name);
}

// ---------- (a) exact grants ----------

describe("(a) hb_sync has exactly the planned grants", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("table-level privileges", async () => {
    const rows = await testSql()<{ t: string; p: string }[]>`
      SELECT table_name AS t, privilege_type AS p FROM information_schema.table_privileges
      WHERE grantee = 'hb_sync' AND table_schema = 'public' ORDER BY 1, 2`;
    expect(rows.map((r) => `${r.t}:${r.p}`)).toEqual([
      "ai_calls:INSERT",
      "ai_calls:SELECT",
      "job_listings:DELETE",
      "job_listings:INSERT",
      "job_listings:SELECT",
      "job_listings:UPDATE",
      "jobs:DELETE",
      "jobs:INSERT",
      "jobs:SELECT",
      "jobs:UPDATE",
      "role_drops:DELETE",
      "role_drops:INSERT",
      "sources:SELECT",
    ]);
  });

  test("column-level privileges beyond the table-level ones", async () => {
    // column_privileges also lists every column of a table-level grant; keep only column-only grants.
    const rows = await testSql()<{ t: string; c: string; p: string }[]>`
      SELECT cp.table_name AS t, cp.column_name AS c, cp.privilege_type AS p
      FROM information_schema.column_privileges cp
      WHERE cp.grantee = 'hb_sync' AND cp.table_schema = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges tp
          WHERE tp.grantee = cp.grantee AND tp.table_schema = cp.table_schema
            AND tp.table_name = cp.table_name AND tp.privilege_type = cp.privilege_type)
      ORDER BY 1, 3, 2`;
    expect(rows.map((r) => `${r.t}.${r.c}:${r.p}`)).toEqual([
      "opportunities.job_id:SELECT",
      "role_drops.source_id:SELECT",
      "sources.last_count:UPDATE",
      "sources.last_dropped:UPDATE",
      "sources.last_error:UPDATE",
      "sources.last_ok_at:UPDATE",
      "sources.last_ok_count:UPDATE",
      "sources.last_run_at:UPDATE",
      "sources.last_status:UPDATE",
      "users.ai_eligibility_on_refresh:SELECT",
      "users.ai_provider:SELECT",
      "users.exclude_title_words:SELECT",
      "users.id:SELECT",
      "users.model_light:SELECT",
      "users.monthly_cap_usd:SELECT",
      "users.role_families:SELECT",
      "users.target_titles:SELECT",
    ]);
  });

  test("the role cannot log in, is not a superuser and belongs to no other role", async () => {
    const [role] = await testSql()<{ login: boolean; superuser: boolean; bypassrls: boolean; memberOf: number }[]>`
      SELECT rolcanlogin AS login, rolsuper AS superuser, rolbypassrls AS bypassrls,
        (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "memberOf"
      FROM pg_roles r WHERE rolname = 'hb_sync'`;
    expect(role).toEqual({ login: false, superuser: false, bypassrls: false, memberOf: 0 });
  });

  test("no sequence or routine grants beyond PUBLIC defaults", async () => {
    const sequences = await testSql()`
      SELECT object_name FROM information_schema.usage_privileges
      WHERE grantee = 'hb_sync' AND object_schema = 'public'`;
    expect(sequences).toHaveLength(0);
  });
});

// ---------- (b) every forbidden write fails with 42501 ----------

describe("(b) as hb_sync, writes outside the grants fail with 42501", () => {
  let deps: Deps;

  beforeAll(async () => {
    await resetDb();
    deps = await testDeps();
  });

  const run = (statement: string) => () => asSync(deps.db, (tx) => tx.execute(sql.raw(statement)));

  test("asSync switches to hb_sync for the transaction only, even when it throws", async () => {
    const inside = await asSync(deps.db, (tx) => tx.execute<{ who: string }>(sql`SELECT current_user AS who`));
    expect(inside[0]?.who).toBe("hb_sync");
    expect(await failure(() => asSync(deps.db, () => Promise.reject(new Error("boom"))))).toContain("no SQLSTATE");
    // Every pooled connection is back on the app role.
    const after = await Promise.all(
      Array.from({ length: 6 }, () => deps.db.execute<{ who: string }>(sql`SELECT current_user AS who`)),
    );
    expect(new Set(after.map((r) => r[0]?.who))).toEqual(new Set(["hanapbuhay"]));
  });

  test("the writes named in the plan", async () => {
    const statements = [
      "UPDATE opportunities SET notes = 'x'",
      "UPDATE outputs SET body = 'x'",
      "DELETE FROM facts",
      "UPDATE users SET full_name = 'x'",
      // Exchange rates (decision 67): Refresh fills them as the app role after sync, never as hb_sync.
      "UPDATE users SET fx_rates = '{}'::jsonb",
      "UPDATE users SET fx_fetch = NULL",
      "UPDATE tasks SET step = 'x'",
      "INSERT INTO eligibility_overrides DEFAULT VALUES",
      "DELETE FROM eligibility_overrides",
      "UPDATE role_drops SET title = 'x'",
      // The user's skill list (decision 66): Refresh reads it as the app role, never as hb_sync.
      "INSERT INTO user_skills (user_id, key, name, kind) SELECT id, 'x', 'x', 'added' FROM users",
      "UPDATE user_skills SET kind = 'hidden'",
      "DELETE FROM user_skills",
      // The stored CV file (decision 69): only the app role saves, serves or deletes it.
      "INSERT INTO cv_files (user_id, file_name, content_type, size, data) SELECT id, 'cv.pdf', 'application/pdf', 1, '\\x25'::bytea FROM users",
      "UPDATE cv_files SET file_name = 'x'",
      "DELETE FROM cv_files",
    ];
    const codes = await Promise.all(statements.map((s) => failure(run(s))));
    expect(Object.fromEntries(statements.map((s, i) => [s, codes[i]]))).toEqual(
      Object.fromEntries(statements.map((s) => [s, "42501"])),
    );
  });

  test("INSERT, UPDATE, DELETE and TRUNCATE on every table sync may not write", async () => {
    const columns = await testSql()<{ t: string; c: string }[]>`
      SELECT DISTINCT ON (table_name) table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND is_generated = 'NEVER' AND is_identity = 'NO'
        AND column_name NOT LIKE 'last\\_%'
      ORDER BY table_name, ordinal_position DESC`;
    const columnOf = new Map(columns.map((r) => [r.t, r.c]));
    const statements: string[] = [];
    for (const table of await publicTables()) {
      const writable = table === "jobs" || table === "job_listings";
      // Sync replaces role drops (insert and delete only); it may never update them.
      const replaceOnly = table === "role_drops";
      statements.push(`TRUNCATE "${table}"`);
      if (writable) continue;
      if (table !== "ai_calls" && !replaceOnly) statements.push(`INSERT INTO "${table}" DEFAULT VALUES`);
      statements.push(`UPDATE "${table}" SET "${columnOf.get(table)}" = "${columnOf.get(table)}" WHERE false`);
      if (!replaceOnly) statements.push(`DELETE FROM "${table}" WHERE false`);
    }
    statements.push("UPDATE sources SET label = label WHERE false", "UPDATE sources SET enabled = enabled WHERE false");
    const results: Record<string, string> = {};
    for (const s of statements) results[s] = await failure(run(s));
    expect(results).toEqual(Object.fromEntries(statements.map((s) => [s, "42501"])));
  });

  test("reads outside the grants fail too", async () => {
    expect(await failure(run("SELECT full_name FROM users"))).toBe("42501");
    expect(await failure(run("SELECT notes FROM opportunities"))).toBe("42501");
    expect(await failure(run("SELECT text FROM facts"))).toBe("42501");
    expect(await failure(run("SELECT job_id FROM eligibility_overrides"))).toBe("42501");
    expect(await failure(run("SELECT title FROM role_drops"))).toBe("42501");
    expect(await failure(run("SELECT name FROM user_skills"))).toBe("42501");
    // Not even the name or size of the stored CV file, let alone its bytes (decision 69).
    expect(await failure(run("SELECT data FROM cv_files"))).toBe("42501");
    expect(await failure(run("SELECT user_id, file_name, size FROM cv_files"))).toBe("42501");
  });

  test("the granted writes succeed", async () => {
    const allowed = [
      "UPDATE sources SET last_status = last_status, last_error = last_error WHERE false",
      "UPDATE jobs SET title = title WHERE false",
      // The skills stamp (decision 68) is covered by the table-level grant on jobs.
      "UPDATE jobs SET skills = skills, skills_stamp = skills_stamp WHERE false",
      "DELETE FROM job_listings WHERE false",
      "SELECT id, target_titles, role_families, exclude_title_words FROM users",
      "SELECT job_id FROM opportunities",
      "DELETE FROM role_drops WHERE source_id IS NULL",
    ];
    for (const s of allowed) expect(await failure(run(s))).toBe("succeeded");
  });
});

// ---------- (c) byte-identical user tables across six refresh scenarios ----------

const fixtures = join(import.meta.dir, "fixtures/sources");
const GreenhousePayload = z.object({ jobs: z.array(z.looseObject({ id: z.number(), content: z.string() })) });
type GreenhousePayload = z.infer<typeof GreenhousePayload>;

const GH_BOARD = "boards-api.greenhouse.io/v1/boards/acme";
const GH_JOBS = "boards-api.greenhouse.io/v1/boards/acme/jobs";
const JOBICY = "jobicy.com/api/v2/remote-jobs";

const OTHER_BUILTINS = [
  ["himalayas.app/jobs/api", "himalayas/jobs.json"],
  ["remoteok.com/api", "remoteok/api.json"],
  ["weworkremotely.com/remote-jobs.rss", "weworkremotely/remote-jobs.rss"],
  ["remotive.com/api/remote-jobs", "remotive/remote-jobs.json"],
] as const;

const PASTED_URL = "https://boards.greenhouse.io/acme/jobs/4005?utm_source=linkedin";

/** A posting the rules leave `unclear`, added in scenario 2 so the AI pass has a new job to read. */
const NEW_UNCLEAR = {
  ...{ absolute_url: "https://boards.greenhouse.io/acme/jobs/4999", internal_job_id: 3999, metadata: null },
  id: 4999,
  title: "Payments Engineer",
  location: { name: "Distributed" },
  updated_at: "2026-10-16T09:00:00-04:00",
  first_published: "2026-10-16T09:00:00-04:00",
  content: "&lt;p&gt;We hire people wherever they live and work async.&lt;/p&gt;",
  departments: [],
  offices: [],
};

/**
 * The test's AI: eligibility questions get "worldwide" with the description's first 40 characters
 * as the phrase, which is verbatim, so every job asked about gets written. Anything else goes to
 * the fake's default writer.
 */
function decidingAi(fallback: AiProviderClient): AiProviderClient {
  return {
    checkKey: (args) => fallback.checkKey(args),
    complete: async (request) => {
      const prompt = request.messages[0]?.content ?? "";
      if (!prompt.includes('{"verdict"')) return fallback.complete(request);
      const description = /^<<<\n([\s\S]*?)\n>>>$/m.exec(prompt)?.[1] ?? "";
      const phrase = description.slice(0, 40).trim();
      return {
        text: JSON.stringify({ verdict: "worldwide", phrase }),
        inputTokens: 500,
        outputTokens: 20,
        model: request.model,
      };
    },
  };
}

describe("(c) refresh never changes user tables", () => {
  let deps: Deps;
  let app: ReturnType<typeof createApp>;
  let now: Date;
  let routes: Map<string, () => Response>;
  let globalFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let base: GreenhousePayload;
  let jobicy: unknown;

  const fakeFetch: FetchFn = async (url) => {
    const parsed = new URL(url);
    const route = routes.get(`${parsed.host}${parsed.pathname}`);
    return route ? route() : new Response("not found", { status: 404 });
  };
  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(async () => {
    await resetDb();
    // Belt and braces: the real fetch must never run in these tests.
    globalFetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async (): Promise<Response> => Promise.reject(new Error("the real network was called")), {
        preconnect: () => {},
      }),
    );
    base = GreenhousePayload.parse(await Bun.file(join(fixtures, "greenhouse/acme.json")).json());
    jobicy = await Bun.file(join(fixtures, "jobicy/remote-jobs.json")).json();
    routes = new Map([
      [GH_BOARD, json({ name: "Acme", content: "" })],
      [GH_JOBS, json(base)],
      [JOBICY, json(jobicy)],
    ]);
    // The other built-ins run on every refresh too, from their fixtures.
    for (const [route, file] of OTHER_BUILTINS) {
      const body = await Bun.file(join(fixtures, file)).text();
      routes.set(route, () => new Response(body, { status: 200 }));
    }
    now = new Date("2026-10-16T08:00:00Z");
    const test = await testDeps({
      http: createHttpClient({ fetch: fakeFetch, sleep: async () => {} }),
      clock: { now: () => now },
    });
    const ai = decidingAi(test.fake);
    deps = { ...test, ai: { anthropic: ai, openai: ai } };
    app = createApp(deps);
  });

  afterEach(() => {
    globalFetch.mockRestore();
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

  async function refresh(at: Date): Promise<RefreshDto["result"]> {
    now = at;
    const task = await ok(await call("POST", "/refresh"), TaskDto, 202);
    await waitForTask(task.id);
    const done = await ok(await call("GET", `/tasks/${task.id}`), TaskDto);
    expect({ status: done.status, error: done.error }).toEqual({ status: "done", error: null });
    return (await ok(await call("GET", "/refresh"), RefreshDto)).result;
  }

  /** md5 of every row of every table sync may not write, per table. */
  async function userTableHashes(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const table of await publicTables()) {
      if (SYNC_TABLES.includes(table)) continue;
      // Refresh's last step fills exchange rates as the app role, after sync is done (decision 67),
      // so those two columns may change. hb_sync cannot write `users` at all (part b).
      const shape = table === "users" ? "(to_jsonb(t) - 'fx_rates' - 'fx_fetch')" : "t";
      const [row] = await testSql().unsafe<{ h: string; n: number }[]>(
        `SELECT md5(coalesce(string_agg(md5(${shape}::text), ',' ORDER BY md5(${shape}::text)), '')) AS h, count(*)::int AS n
         FROM "${table}" t`,
      );
      out[table] = `${row?.n} rows ${row?.h}`;
    }
    return out;
  }

  async function jobByTitle(title: string) {
    const [row] = await testSql()<{ id: string; closed: Date | null; description: string; origin: string }[]>`
      SELECT id, closed_at AS closed, description, origin FROM jobs WHERE title = ${title}`;
    return row ?? null;
  }

  /** Put a source job on the board the way saving does: a Saved opportunity and its three files. */
  async function putOnBoard(title: string): Promise<{ opportunityId: OpportunityId; resumeId: OutputId }> {
    const job = await jobByTitle(title);
    if (!job) throw new Error(`no job ${title}`);
    const [opp] = await testSql()<{ id: OpportunityId }[]>`
      INSERT INTO opportunities (user_id, job_id, status, status_changed_at, history)
      VALUES (${deps.userId}, ${job.id}, 'saved', ${now}, ${JSON.stringify([{ at: now.toISOString(), from: null, to: "saved" }])}::jsonb)
      RETURNING id`;
    if (!opp) throw new Error("no opportunity");
    const files = await testSql()<{ id: OutputId; kind: string }[]>`
      INSERT INTO outputs (user_id, opportunity_id, kind, position) VALUES
        (${deps.userId}, ${opp.id}, 'resume', 0), (${deps.userId}, ${opp.id}, 'letter', 1),
        (${deps.userId}, ${opp.id}, 'message', 2)
      RETURNING id, kind`;
    const resume = files.find((f) => f.kind === "resume");
    if (!resume) throw new Error("no resume");
    return { opportunityId: opp.id, resumeId: resume.id };
  }

  async function seedUserData(): Promise<void> {
    await ok(
      await call("PUT", "/profile", {
        contact: { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Manila", links: [] },
        standardAnswers: { salary: "PHP 150,000 a month", notice: "30 days" },
        targeting: { roleFamilies: ["engineering"], excludeTitleWords: ["intern"] },
      }),
      ProfileDto,
    );
    const cv = await ok(
      await call("PUT", "/profile/cv", {
        text: "- Built a payroll API in Go and Postgres\n- Led a team of 4 engineers at Lakbay Labs",
      }),
      ProfileDto,
    );
    await waitForSplits(cv);
    await ok(await call("POST", "/facts/confirm-all"), ProfileDto);
    // The AI eligibility pass is on for every refresh below.
    await ok(
      await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" }),
      SettingsDto,
    );
    await ok(await call("PATCH", "/settings", { eligibilityOnRefresh: true }), SettingsDto);

    // A pasted job whose apply URL a Greenhouse posting shares: sync attaches a listing, nothing more.
    const pasted = await ok(
      await call("POST", "/jobs/from-paste", {
        url: PASTED_URL,
        title: "Platform Engineer",
        company: "Acme",
        description: "Pasted from LinkedIn. Kubernetes platform team, remote.",
      }),
      AddJobResult,
      201,
    );
    const pastedWs = await ok(await call("GET", `/opportunities/${pasted.opportunityId}`), WorkspaceDto);
    const pastedResume = pastedWs.files.find((f) => f.kind === "resume");
    if (!pastedResume) throw new Error("no resume");
    await call("PATCH", `/outputs/${pastedResume.id}`, { body: "I built a payroll API in Go [FACT-1]." });

    await ensureBuiltinSources(deps);
    await ok(await call("POST", "/sources", { url: "https://boards.greenhouse.io/acme" }), z.unknown(), 201);
    const first = await refresh(now);
    // The fixtures' unclear jobs all went to the AI and were all written.
    expect(first?.aiPass).toEqual({ kind: "ran", checked: 2, decided: 2, unbacked: 0, left: 0, stopped: null });

    // Saved, with notes and a cited resume.
    const saved = await putOnBoard("Senior Frontend Engineer");
    await call("PATCH", `/opportunities/${saved.opportunityId}`, { notes: "Ask about the async culture." });
    await call("PATCH", `/outputs/${saved.resumeId}`, { body: "I led a team of 4 engineers [FACT-2]." });

    // Applied: frozen, with a snapshot and copied standard answers.
    const applied = await putOnBoard("Backend Engineer");
    await call("PATCH", `/outputs/${applied.resumeId}`, { body: "I built a payroll API in Go [FACT-1]." });
    await call("POST", `/opportunities/${applied.opportunityId}/status`, { status: "applied" });

    // Dismissed with a reason.
    const dismissed = await jobByTitle("UX Engineer");
    if (!dismissed) throw new Error("no UX Engineer");
    await testSql()`
      INSERT INTO opportunities (user_id, job_id, dismissed_at, dismiss_reason)
      VALUES (${deps.userId}, ${dismissed.id}, ${now}, 'wrong_stack')`;

    // An override to Matches (slice 13) on a job that stays for every scenario.
    const kept = await jobByTitle("Platform Engineer");
    if (!kept) throw new Error("no Platform Engineer");
    await testSql()`INSERT INTO eligibility_overrides (user_id, job_id) VALUES (${deps.userId}, ${kept.id})`;

    // A stored CV file (decision 69), so its row is in the hashes too.
    await testSql()`
      INSERT INTO cv_files (user_id, file_name, content_type, size, data)
      VALUES (${deps.userId}, 'cv.pdf', 'application/pdf', 5, ${Buffer.from("%PDF-")})`;
  }

  const hours = (h: number) => new Date(Date.parse("2026-10-16T08:00:00Z") + h * 3_600_000);
  const without = (...ids: number[]): GreenhousePayload => ({ jobs: base.jobs.filter((j) => !ids.includes(j.id)) });

  test("six scenarios leave every user table byte-identical", async () => {
    await seedUserData();
    const before = await userTableHashes();
    for (const table of ["users", "profile_items", "facts", "opportunities", "outputs", "output_facts"]) {
      expect(Object.keys(before)).toContain(table);
    }
    for (const table of SYNC_TABLES) expect(Object.keys(before)).not.toContain(table);
    expect(before.opportunities).toStartWith("4 rows");
    expect(before.output_facts).toStartWith("3 rows");
    expect(before.eligibility_overrides).toStartWith("1 rows");
    expect(before.cv_files).toStartWith("1 rows");
    // The role filter dropped Acme's designer at seeding, and sync wrote it as hb_sync.
    const dropped = await testSql()<{ title: string }[]>`SELECT title FROM role_drops ORDER BY title`;
    expect(dropped.map((d) => d.title)).toContain("Product Designer");

    // 1. Normal: the same postings again.
    await refresh(hours(1));
    expect(await userTableHashes()).toEqual(before);
    const builtins = await testSql()<{ kind: string; status: string }[]>`
      SELECT kind, last_status AS status FROM sources WHERE board IS NULL ORDER BY kind`;
    // Remotive ran at seeding and is inside its six-hour interval now.
    expect(builtins.map((r) => `${r.kind} ${r.status}`)).toEqual([
      "himalayas ok",
      "jobicy ok",
      "remoteok ok",
      "remotive skipped",
      "weworkremotely ok",
    ]);

    // 2. Postings gone from a complete board: the saved, dismissed and an untouched job close.
    //    A new posting the rules cannot place arrives too, and the AI pass decides it.
    routes.set(GH_JOBS, json({ jobs: [...without(4001, 4003, 4006).jobs, NEW_UNCLEAR] }));
    const second = await refresh(hours(2));
    expect(await userTableHashes()).toEqual(before);
    expect(second?.aiPass).toEqual({ kind: "ran", checked: 1, decided: 1, unbacked: 0, left: 0, stopped: null });
    const [decided] = await testSql()<{ eligibility: string; by: string }[]>`
      SELECT eligibility, eligibility_by AS by FROM jobs WHERE title = 'Payments Engineer'`;
    expect(decided).toEqual({ eligibility: "worldwide", by: "ai" });
    expect((await jobByTitle("Senior Frontend Engineer"))?.closed).not.toBeNull();
    expect((await jobByTitle("UX Engineer"))?.closed).not.toBeNull();
    expect((await jobByTitle("Staff Software Engineer"))?.closed).not.toBeNull();

    // 3. Adapters throw: Greenhouse answers 500, Jobicy 429.
    routes.set(GH_JOBS, json({ error: "down" }, 500));
    routes.set(JOBICY, json({ error: "slow down" }, 429));
    await refresh(hours(3));
    expect(await userTableHashes()).toEqual(before);
    const failed = await testSql()<{ kind: string; status: string }[]>`
      SELECT kind, last_status AS status FROM sources WHERE kind IN ('greenhouse', 'jobicy') ORDER BY kind`;
    expect(failed.map((r) => ({ kind: r.kind, status: r.status }))).toEqual([
      { kind: "greenhouse", status: "failed" },
      { kind: "jobicy", status: "rate_limited" },
    ]);

    // 4. Zero results after a healthy run.
    routes.set(GH_JOBS, json({ jobs: [], meta: { total: 0 } }));
    routes.set(JOBICY, json(jobicy));
    await refresh(hours(4));
    expect(await userTableHashes()).toEqual(before);
    const [empty] = await testSql()<{ status: string }[]>`
      SELECT last_status AS status FROM sources WHERE kind = 'greenhouse'`;
    expect(empty?.status).toBe("suspicious_empty");
    expect((await jobByTitle("Backend Engineer"))?.closed).toBeNull();

    // 5. Description changed on the applied job's posting.
    const changed = without(4001, 4003, 4006);
    changed.jobs = changed.jobs.map((j) =>
      j.id === 4002 ? { ...j, content: "&lt;p&gt;Now hiring for the ledger team instead.&lt;/p&gt;" } : j,
    );
    routes.set(GH_JOBS, json(changed));
    await refresh(hours(5));
    expect(await userTableHashes()).toEqual(before);
    expect((await jobByTitle("Backend Engineer"))?.description).toContain("ledger team");

    // 6. Clock moved 61 days: the untouched closed job is pruned; the saved and dismissed ones stay.
    await refresh(new Date(hours(5).getTime() + 61 * 86_400_000));
    expect(await userTableHashes()).toEqual(before);
    expect(await jobByTitle("Staff Software Engineer")).toBeNull();
    expect(await jobByTitle("Senior Frontend Engineer")).not.toBeNull();
    expect(await jobByTitle("UX Engineer")).not.toBeNull();
  });
});
