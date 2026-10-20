import { beforeAll, expect, test } from "bun:test";
import { compileSkills } from "@/domain/features";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { rereadSkills } from "@/server/services/sync";
import { loadSkillDictionary } from "@/server/services/user-skills";
import { CUSTOM_SKILLS, variedTexts } from "../fixtures/skill-texts";
import { resetDb, testDeps, testSql } from "../setup";

/*
 * The budgets of decision 68, over 2,000 open jobs of about 8 KB and the 20 fixture skills of the
 * user's own: adding one more skill takes at most 300 ms end to end (the PUT, including the profile
 * it returns), and the re-read step of a Refresh where nothing changed takes at most 100 ms.
 *
 * The text is `variedTexts`, so each job's `search` tsvector is real-sized: with text that repeats,
 * the GIN index is tiny and the cost of updates that are not HOT does not show. With fillfactor
 * 100 this test fails (add about 420-450 ms); with migration 0014's 50 it passes.
 */

const JOBS = 2000;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await resetDb();
  deps = await testDeps();
  app = createApp(deps);
  const rows = variedTexts({ count: JOBS, bytes: 8192 }).map((description, i) => ({
    user_id: deps.userId,
    origin: "paste",
    title: `Engineer ${i}`,
    company: "Acme",
    title_key: `engineer ${i}`,
    company_key: "acme",
    description,
    content_hash: String(i),
    description_key: String(i),
  }));
  for (let i = 0; i < rows.length; i += 500) await testSql()`INSERT INTO jobs ${testSql()(rows.slice(i, i + 500))}`;
  await testSql()`
    INSERT INTO user_skills (user_id, key, name, kind, created_at)
    SELECT ${deps.userId}, lower(name), name, 'added', now() + n * interval '1 second'
    FROM unnest(${CUSTOM_SKILLS}::text[]) WITH ORDINALITY AS s(name, n)`;
  // Seeding 16 MB is setup, not a budget: it takes about 4 s, and over 5 s (Bun's default hook
  // timeout) on a busy machine. The budgets below are timed inside the tests and stay strict.
}, 60_000);

const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - started) };
};

const put = (name: string, state: "added" | "none") =>
  timed(async () => {
    const res = await app.request("/api/profile/skills", {
      method: "PUT",
      body: JSON.stringify({ name, state }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

test("adding a skill takes at most 300 ms; a re-read with nothing changed at most 100 ms", async () => {
  const skills = await loadSkillDictionary(deps);
  expect(skills.custom).toEqual(CUSTOM_SKILLS);
  // Unstamped rows, as after the migration: the first re-read reads them all.
  const first = await timed(() => rereadSkills({ deps, skills }));
  expect(first.value).toBe(JOBS);
  const unchanged = await timed(() => rereadSkills({ deps, skills }));
  expect(unchanged.value).toBe(0);

  // Warm-up: a live jobs table has been updated before. Right after a bulk insert, half-full pages
  // (fillfactor 50, decision 68) hold no room for a new version of every row, so a third of the
  // first all-row update moves off-page and writes GIN entries. One add and remove of a skill in
  // every text settles the pages; the dev database is past this point.
  const warmAdd = await put("Asia", "added");
  const warmRemove = await put("Asia", "none");

  // The worst case: "payroll" is in every text, so all 2,000 jobs are candidates and all
  // gain it. "Zigbee" is in none, so no job is a candidate and only the stamps move.
  const addCommon = await put("payroll", "added");
  const [held] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE 'payroll' = ANY(skills)`;
  const addRare = await put("Zigbee", "added");
  const [stamped] = await testSql()<{ n: number }[]>`SELECT count(DISTINCT skills_stamp)::int AS n FROM jobs`;
  expect(stamped?.n).toBe(1);
  const removeCommon = await put("payroll", "none");
  const after = await timed(async () => rereadSkills({ deps, skills: await loadSkillDictionary(deps) }));
  expect(after.value).toBe(0);

  const [size] = await testSql()<{ search: number; fillfactor: string[] | null }[]>`
    SELECT avg(pg_column_size(search))::int AS search,
      (SELECT reloptions FROM pg_class WHERE oid = 'jobs'::regclass) AS fillfactor
    FROM jobs`;
  console.log(
    JSON.stringify({
      msg: "skills budget",
      tsvectorBytes: size?.search,
      reloptions: size?.fillfactor,
      jobs: JOBS,
      custom: CUSTOM_SKILLS.length,
      firstReadMs: first.ms,
      warmAddMs: warmAdd.ms,
      warmRemoveMs: warmRemove.ms,
      unchangedReadMs: unchanged.ms,
      addCommonMs: addCommon.ms,
      jobsGainingIt: held?.n,
      addRareMs: addRare.ms,
      removeCommonMs: removeCommon.ms,
      rereadAfterMs: after.ms,
    }),
  );
  expect(held?.n).toBe(JOBS);
  expect(addCommon.ms).toBeLessThanOrEqual(300);
  expect(addRare.ms).toBeLessThanOrEqual(300);
  expect(unchanged.ms).toBeLessThanOrEqual(100);
  expect(after.ms).toBeLessThanOrEqual(100);
  // The dictionary the budget ran with is the one a Refresh compiles.
  expect(skills.names).toEqual(compileSkills(CUSTOM_SKILLS).names);
}, 60_000);

test("jobs leaves half of each page free, so skill and stamp updates stay HOT (migration 0014)", async () => {
  const [row] = await testSql()<{ reloptions: string[] | null }[]>`
    SELECT reloptions FROM pg_class WHERE oid = 'jobs'::regclass`;
  expect(row?.reloptions).toContain("fillfactor=50");
  // HOT needs the updated columns out of every index; an index on either would undo the fillfactor.
  const indexed = await testSql()<{ name: string }[]>`
    SELECT a.attname AS name FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'jobs'::regclass AND a.attname IN ('skills', 'skills_stamp')`;
  expect(indexed.map((r) => r.name)).toEqual([]);
});
