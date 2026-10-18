import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { compileSkills, type SkillDictionary } from "@/domain/features";
import { derive, type JobFields } from "@/domain/posting";
import { jobListings, jobs, sources } from "@/server/db/schema";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import {
  ApiErrorBody,
  BoardItemDto,
  HiddenCompanies,
  type JobId,
  MatchDetail,
  MatchList,
  ProfileDto,
  SavedJob,
  WorkspaceDto,
} from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Matches (PLAN.md slice 7): levels and the "Role unclear" tag are computed on every read, search
 * ranks within a level, the excluded and pay filters, and save, dismiss and undo.
 */

let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps();
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

const list = async (query = "") => ok(await call("GET", `/matches${query}`), MatchList);
const detail = async (id: JobId) => ok(await call("GET", `/matches/${id}`), MatchDetail);
const titles = (l: MatchList) => l.jobs.map((j) => j.title);
const levelOf = async (title: string, query = "") => (await list(query)).jobs.find((j) => j.title === title)?.level;

const WORLDWIDE = "This role is fully remote and open worldwide.";

let seen = 0;
/** A job as sync stores it: normalized by the same `derive`, origin `source`. */
async function addJob(
  fields: Partial<JobFields> & { title: string; description: string },
  dict?: SkillDictionary,
): Promise<JobId> {
  seen++;
  const derived = derive(
    {
      company: "Acme",
      locationText: "Remote",
      applyUrl: null,
      postedAt: null,
      expiresAt: null,
      pay: null,
      restrictions: null,
      ...fields,
    },
    dict,
  );
  const firstSeenAt = new Date(Date.parse("2026-10-01T00:00:00Z") + seen * 60_000);
  const [row] = await deps.db
    .insert(jobs)
    .values({ userId: deps.userId, origin: "source", ...derived, firstSeenAt, updatedAt: firstSeenAt })
    .returning({ id: jobs.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

async function targeting(t: { targetTitles?: string[]; roleFamilies?: string[]; excludeTitleWords?: string[] }) {
  await ok(
    await call("PUT", "/profile", {
      targeting: { targetTitles: [], roleFamilies: [], excludeTitleWords: [], ...t },
    }),
    ProfileDto,
  );
}

/** Paste a CV (rule split, no AI key), and return the profile once its facts are in. */
async function pasteCv(text: string): Promise<ProfileDto> {
  await ok(await call("PUT", "/profile/cv", { text }), ProfileDto);
  const profile = await ok(await call("GET", "/profile"), ProfileDto);
  await waitForSplits(profile);
  return ok(await call("GET", "/profile"), ProfileDto);
}

async function confirm(profile: ProfileDto, text: string): Promise<ProfileDto> {
  const fact = profile.facts.find((f) => f.text.includes(text));
  if (!fact) throw new Error(`no fact like ${text}`);
  return ok(await call("POST", `/facts/${fact.id}/confirm`), ProfileDto);
}

describe("levels are computed on read", () => {
  test("confirming a fact with a new skill changes a job's level on the next request", async () => {
    await targeting({ targetTitles: ["Backend Engineer"] });
    await addJob({ title: "Backend Engineer", description: `We use PostgreSQL and Go. ${WORLDWIDE}` });
    const profile = await pasteCv("- Built a billing service with Postgres\n- Ran Go services in production");

    // Pending facts count for nothing.
    expect(profile.skillsFound).toEqual([]);
    expect(await levelOf("Backend Engineer")).toBe("possible");
    const [stored] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%level%'`;
    expect(stored?.n).toBe(0);

    // "Postgres" in a confirmed fact is the job's "PostgreSQL": 1 of 2 skills, still Possible.
    const one = await confirm(profile, "Postgres");
    expect(one.skillsFound).toEqual(["PostgreSQL"]);
    expect(await levelOf("Backend Engineer")).toBe("possible");

    // A second confirmed skill: 2 of 2, Strong at once, with no refresh.
    const two = await confirm(one, "Go services");
    expect(two.skillsFound).toEqual(["Go", "PostgreSQL"]);
    expect(await levelOf("Backend Engineer")).toBe("strong");
  });

  test("within a level, jobs whose skills your facts cover best come first", async () => {
    await targeting({ targetTitles: ["Backend Engineer"] });
    // All three are Possible: the title fits, but none reaches 60% coverage, and none is under 30%.
    await addJob({
      title: "Backend Engineer, Two of five",
      description: `Go, PostgreSQL, Rust, Elixir, Kafka. ${WORLDWIDE}`,
    });
    await addJob({ title: "Backend Engineer, No skills named", description: `Build things with us. ${WORLDWIDE}` });
    await addJob({ title: "Backend Engineer, One of three", description: `Go, Rust, Elixir. ${WORLDWIDE}` });
    const profile = await pasteCv("- Ran Go and Postgres services in production");
    await confirm(profile, "Go and Postgres");
    const shown = await list();
    expect(shown.jobs.map((j) => [j.title, j.level])).toEqual([
      ["Backend Engineer, Two of five", "possible"],
      ["Backend Engineer, One of three", "possible"],
      ["Backend Engineer, No skills named", "possible"],
    ]);
  });

  test("a pending fact's skill does not count; Flutter in a confirmed fact matches a Flutter job", async () => {
    await targeting({ targetTitles: ["Mobile Developer"] });
    const id = await addJob({ title: "Mobile Developer", description: `Flutter, Dart and Firebase. ${WORLDWIDE}` });
    const profile = await pasteCv("- Shipped three Flutter apps\n- Wrote Dart packages");
    const confirmed = await confirm(profile, "Flutter");
    expect(confirmed.skillsFound).toEqual(["Flutter"]);
    const pane = await detail(id);
    expect(pane.reasons.map((r) => r.text)).toContain("In your facts: Flutter");
    // The Dart fact is still pending, so Dart is missing (Firebase is in no fact).
    expect(pane.reasons.map((r) => r.text)).toContain("Not in your facts: Dart, Firebase");
  });

  test("added skills count, hidden ones do not, and a removed skill of your own leaves the job at once", async () => {
    await targeting({ targetTitles: ["Backend Engineer"] });
    const id = await addJob(
      { title: "Backend Engineer", description: `Go, PostgreSQL and Hasura. ${WORLDWIDE}` },
      compileSkills(["Hasura"]),
    );
    const profile = await pasteCv("- Ran Go services in production");
    await confirm(profile, "Go services");
    const setSkill = (name: string, state: string) => call("PUT", "/profile/skills", { name, state });
    const reasons = async () => (await detail(id)).reasons.map((r) => r.text);

    // The job was read for Hasura, but Hasura is not on your list yet, so Matches does not know it.
    expect(await reasons()).toContain("Not in your facts: PostgreSQL");
    await ok(await setSkill("Hasura", "added"), ProfileDto);
    await ok(await setSkill("postgres", "added"), ProfileDto);
    expect(await reasons()).toContain("In your facts: Go, PostgreSQL, Hasura");
    expect(await levelOf("Backend Engineer")).toBe("strong");

    // Hidden: found in facts, but left out of matching.
    await ok(await setSkill("Go", "hidden"), ProfileDto);
    expect(await reasons()).toContain("Not in your facts: Go");

    // Removing Hasura from your list drops it from the job's skills before any refresh.
    await ok(await setSkill("Hasura", "none"), ProfileDto);
    const after = await reasons();
    expect(after).toContain("In your facts: PostgreSQL");
    expect(after.join("\n")).not.toContain("Hasura");
    const [stored] = await testSql()<{ skills: string[] }[]>`SELECT skills FROM jobs WHERE id = ${id}`;
    expect(stored?.skills).toEqual(["Go", "PostgreSQL", "Hasura"]);
  });

  test("the reading pane carries the level, every reason and the job's facts", async () => {
    await targeting({ targetTitles: ["Frontend Engineer"] });
    const id = await addJob({
      title: "Senior Frontend Engineer",
      description: "React and TypeScript. US-only applicants. Pay: $5,000 per month.",
    });
    const pane = await detail(id);
    expect(pane).toMatchObject({
      title: "Senior Frontend Engineer",
      level: "weak",
      roleUnclear: null,
      opportunityId: null,
      facts: { eligibility: { verdict: "excluded" }, pay: { posted: "$5,000 per month" } },
    });
    expect(pane.reasons).toContainEqual({ sign: "negative", text: "Does not hire from the Philippines" });
  });
});

describe("seniority, years and minimum pay from Profile", () => {
  test("a saved seniority or years value changes a job's level on the next request", async () => {
    await targeting({ targetTitles: ["Backend Engineer"] });
    await addJob({
      title: "Senior Backend Engineer",
      description: `Go and PostgreSQL. 8+ years of experience. ${WORLDWIDE}`,
    });
    await pasteCv("- Ran Go services on PostgreSQL");
    await ok(await call("POST", "/facts/confirm-all"), ProfileDto);
    const level = () => levelOf("Senior Backend Engineer");
    const save = async (t: { seniority?: string | null; yearsExperience?: number | null }) =>
      ok(await call("PUT", "/profile", { targeting: t }), ProfileDto);

    // Neither set: nothing to hold it back.
    expect(await level()).toBe("strong");

    // 8+ asked, 3 years saved: a years negative.
    await save({ yearsExperience: 3 });
    expect(await level()).toBe("possible");
    await save({ yearsExperience: 7 });
    expect(await level()).toBe("strong");

    // Junior against a senior role is two steps: a seniority negative.
    await save({ seniority: "junior" });
    expect(await level()).toBe("possible");
    await save({ seniority: "senior" });
    expect(await level()).toBe("strong");
  });

  test("the saved minimum pay is the pay filter until the page changes or clears it", async () => {
    await ok(await call("PATCH", "/settings", { viewCurrency: "PHP", fxRates: { USD: 58 } }), z.unknown());
    await addJob({ title: "Low USD", description: `Pay: $500 per month. ${WORLDWIDE}` });
    await addJob({ title: "High USD", description: `Pay: $3,000 per month. ${WORLDWIDE}` });
    await addJob({ title: "No pay", description: WORLDWIDE });
    await addJob({ title: "Euro, no rate", description: `Pay: €100 per month. ${WORLDWIDE}` });

    await ok(
      await call("PUT", "/profile", { targeting: { minPay: { amount: 24_000, currency: "USD", period: "year" } } }),
      ProfileDto,
    );
    // $24,000 a year = $2,000 a month = ₱116,000.
    const saved = await list();
    expect(saved.payFilter).toEqual({ atLeast: 116_000, from: "profile", missingRate: null });
    expect(titles(saved).sort()).toEqual(["Euro, no rate", "High USD", "No pay"]);
    expect(saved.counts.belowPay).toBe(1);

    // The page changes it, or turns it off with 0.
    const changed = await list("?payAtLeast=200000");
    expect(changed.payFilter).toEqual({ atLeast: 200_000, from: "page", missingRate: null });
    expect(titles(changed).sort()).toEqual(["Euro, no rate", "No pay"]);
    const off = await list("?payAtLeast=0");
    expect(off.payFilter.atLeast).toBeNull();
    expect(off.jobs).toHaveLength(4);

    // A saved minimum in a currency with no rate cannot filter, and says why.
    await ok(
      await call("PUT", "/profile", { targeting: { minPay: { amount: 100, currency: "EUR", period: "month" } } }),
      ProfileDto,
    );
    const noRate = await list();
    expect(noRate.payFilter).toEqual({ atLeast: null, from: null, missingRate: "EUR" });
    expect(noRate.jobs).toHaveLength(4);
  });
});

describe("role unclear", () => {
  test("unsure jobs carry the chip and its reason; unpicking a family changes tags on the next request", async () => {
    await targeting({ targetTitles: ["Engineer"], roleFamilies: ["engineering"] });
    await addJob({ title: "Technical Wizard", description: WORLDWIDE });
    await addJob({ title: "Product Designer", description: WORLDWIDE });
    await addJob({ title: "Backend Engineer", description: WORLDWIDE });

    const before = await list();
    expect(before.jobs.find((j) => j.title === "Technical Wizard")?.roleUnclear).toBe("no role family in the title");
    expect(before.jobs.find((j) => j.title === "Backend Engineer")?.roleUnclear).toBeNull();
    // Kept at read time when it now reads as a sure miss: tagged, not hidden.
    expect(before.jobs.find((j) => j.title === "Product Designer")?.roleUnclear).toBe(
      "design is not one of your role families",
    );

    // Pick design too: the designer is now in-family; drop engineering: the engineer is tagged.
    await targeting({ targetTitles: ["Engineer"], roleFamilies: ["design"] });
    const after = await list();
    expect(after.jobs.find((j) => j.title === "Product Designer")?.roleUnclear).toBeNull();
    expect(after.jobs.find((j) => j.title === "Backend Engineer")?.roleUnclear).toBe(
      "engineering is not one of your role families",
    );

    // The chip filter hides them; shown by default.
    const hidden = await list("?unsure=false");
    expect(titles(hidden)).toEqual(["Product Designer"]);
    expect(hidden.counts.unsure).toBe(2);
  });

  test("an unsure role caps the level at Possible", async () => {
    await targeting({ targetTitles: ["UX Engineer"], roleFamilies: ["engineering"] });
    await addJob({ title: "UX Engineer", description: WORLDWIDE });
    const [job] = (await list()).jobs;
    expect(job?.roleUnclear).toBeTruthy();
    expect(job?.level).toBe("possible");
  });
});

describe("search and filters", () => {
  test('search "react native" returns full-text hits ranked within match level', async () => {
    await targeting({ targetTitles: ["Mobile Engineer"] });
    const profile = await pasteCv("- Built two React Native apps");
    await confirm(profile, "React Native");
    const passing = await addJob({ title: "Mobile Engineer", description: `React Native once. ${WORLDWIDE}` });
    const titled = await addJob({
      title: "React Native Mobile Engineer",
      description: `React Native, React Native and more React Native. ${WORLDWIDE}`,
    });
    // The best text hit of all, but Weak: level comes first, rank only orders within it.
    const weak = await addJob({
      title: "React Native Accountant",
      description: `React Native React Native React Native React Native. ${WORLDWIDE}`,
    });
    await addJob({ title: "Mobile Engineer, iOS", description: `Swift only. ${WORLDWIDE}` });

    const result = await list(`?q=${encodeURIComponent("react native")}`);
    expect(result.jobs.map((j) => [j.id, j.level])).toEqual([
      [titled, "strong"],
      [passing, "strong"],
      [weak, "weak"],
    ]);
    expect(result.counts.search).toBe(1);
  });

  test("excluded jobs appear only when asked for", async () => {
    await addJob({ title: "Open Engineer", description: WORLDWIDE });
    await addJob({ title: "Locked Engineer", description: "US-only applicants, please." });
    const normal = await list();
    expect(titles(normal)).toEqual(["Open Engineer"]);
    expect(normal.counts).toMatchObject({ open: 2, excluded: 1 });
    expect(titles(await list("?excluded=true")).sort()).toEqual(["Locked Engineer", "Open Engineer"]);
  });

  test("the pay filter never hides jobs with no pay or no FX rate", async () => {
    await ok(await call("PATCH", "/settings", { viewCurrency: "PHP", fxRates: { USD: 58 } }), z.unknown());
    await addJob({ title: "Low USD", description: `Pay: $500 per month. ${WORLDWIDE}` });
    await addJob({ title: "High USD", description: `Pay: $3,000 per month. ${WORLDWIDE}` });
    await addJob({ title: "No pay", description: WORLDWIDE });
    await addJob({ title: "Euro, no rate", description: `Pay: €100 per month. ${WORLDWIDE}` });
    await addJob({ title: "No period", description: `Pay: $10. ${WORLDWIDE}` });

    const filtered = await list("?payAtLeast=100000");
    expect(titles(filtered).sort()).toEqual(["Euro, no rate", "High USD", "No pay", "No period"]);
    expect(filtered.counts.belowPay).toBe(1);
    expect(filtered.jobs.find((j) => j.title === "High USD")?.pay).toBe("₱174,000 a month");
  });

  test("bad filters are a 400 in the app's error shape", async () => {
    const body = await ok(await call("GET", "/matches?payAtLeast=-5"), ApiErrorBody, 400);
    expect(body.error.code).toBe("invalid_input");
  });
});

/** A source row as Sources saves it: a job site has no board, a company board has one. */
async function addSource(kind: "remotive" | "remoteok" | "greenhouse", label: string) {
  const [row] = await deps.db
    .insert(sources)
    .values({ userId: deps.userId, kind, board: kind === "greenhouse" ? label.toLowerCase() : null, label })
    .returning({ id: sources.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

/** A job seen on these sources, the first one primary. */
async function addListed(title: string, company: string, sourceIds: readonly (typeof sources.$inferSelect.id)[]) {
  const id = await addJob({ title, company, description: WORLDWIDE });
  const at = new Date("2026-10-01T00:00:00Z");
  for (const [i, sourceId] of sourceIds.entries()) {
    await deps.db.insert(jobListings).values({
      sourceId,
      externalId: `${title}-${i}`,
      userId: deps.userId,
      jobId: id,
      listingUrl: `https://example.com/${encodeURIComponent(title)}`,
      isPrimary: i === 0,
      firstSeenAt: at,
      lastSeenAt: at,
    });
  }
  return id;
}

describe("company and source filters", () => {
  test("the Company filter matches every spelling of a company and counts each choice", async () => {
    await addJob({ title: "Engineer A", company: "Acme Inc.", description: WORLDWIDE });
    await addJob({ title: "Engineer B", company: "Acme", description: WORLDWIDE });
    await addJob({ title: "Engineer C", company: "Acme", description: WORLDWIDE });
    await addJob({ title: "Designer", company: "Globex", description: WORLDWIDE });

    const all = await list();
    expect(all.facets.companies).toEqual([
      { key: "acme", name: "Acme", count: 3, hidden: false },
      { key: "globex", name: "Globex", count: 1, hidden: false },
    ]);

    const acme = await list("?company=acme");
    expect(titles(acme).sort()).toEqual(["Engineer A", "Engineer B", "Engineer C"]);
    expect(acme.counts.picked).toBe(1);
    // The company counts ignore the company pick, so the other choices keep their numbers.
    expect(acme.facets.companies.map((c) => c.count)).toEqual([3, 1]);

    const both = await list("?company=Acme%20Inc.&company=globex");
    expect(both.jobs).toHaveLength(4);
  });

  test("the Source filter splits company boards, job sites and jobs you added", async () => {
    const remotive = await addSource("remotive", "Remotive");
    const remoteok = await addSource("remoteok", "RemoteOK");
    const board = await addSource("greenhouse", "Acme");
    await addListed("Site job", "Globex", [remotive]);
    await addListed("Two sites", "Initech", [remoteok, remotive]);
    await addListed("Board job", "Acme", [board]);
    await addListed("Board and site", "Acme", [board, remoteok]);
    await addJob({ title: "Pasted job", company: "Hooli", description: WORLDWIDE });
    await deps.db.update(jobs).set({ origin: "paste" }).where(eq(jobs.title, "Pasted job"));

    const all = await list();
    expect(all.facets.sources.groups).toEqual({ boards: 2, sites: 3, added: 1 });
    expect(all.facets.sources.sites).toEqual([
      { id: remoteok, label: "RemoteOK", count: 2 },
      { id: remotive, label: "Remotive", count: 2 },
    ]);

    expect(titles(await list("?source=boards")).sort()).toEqual(["Board and site", "Board job"]);
    expect(titles(await list("?source=sites")).sort()).toEqual(["Board and site", "Site job", "Two sites"]);
    expect(titles(await list("?source=added"))).toEqual(["Pasted job"]);
    expect(titles(await list(`?source=${remotive}`)).sort()).toEqual(["Site job", "Two sites"]);

    // Picking a company narrows the source counts, and the other way round.
    const acme = await list("?company=acme");
    expect(acme.facets.sources.groups).toEqual({ boards: 2, sites: 1, added: 0 });
    const sites = await list("?source=sites");
    expect(sites.facets.companies.map((c) => [c.name, c.count])).toEqual([
      ["Acme", 1],
      ["Globex", 1],
      ["Initech", 1],
    ]);
  });

  test("under a picked company, the excluded count is that company's", async () => {
    await addJob({ title: "Acme open", company: "Acme", description: WORLDWIDE });
    await addJob({ title: "Acme US only", company: "Acme", description: "Remote, US only." });
    await addJob({ title: "Globex US only", company: "Globex", description: "Remote, US only." });
    await addJob({ title: "Initech US only", company: "Initech", description: "Remote, US only." });

    expect((await list()).counts).toMatchObject({ excluded: 3, excludedOpen: 3, picked: 0 });
    const acme = await list("?company=acme");
    expect(titles(acme)).toEqual(["Acme open"]);
    expect(acme.counts).toMatchObject({ excluded: 1, excludedOpen: 1, picked: 2 });
  });

  test("a bad source is a 400", async () => {
    const body = await ok(await call("GET", "/matches?source=linkedin"), ApiErrorBody, 400);
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("hidden companies", () => {
  test("hiding a company hides every spelling of it until it is shown again", async () => {
    await addJob({ title: "Engineer A", company: "Acme Inc.", description: WORLDWIDE });
    await addJob({ title: "Engineer B", company: "Acme", description: WORLDWIDE });
    await addJob({ title: "Designer", company: "Globex", description: WORLDWIDE });

    const hidden = await ok(await call("POST", "/hidden-companies", { company: "Acme Inc." }), HiddenCompanies);
    expect(hidden).toEqual([{ key: "acme", name: "Acme Inc." }]);

    const after = await list();
    expect(titles(after)).toEqual(["Designer"]);
    expect(after.counts.hiddenCompany).toBe(2);
    expect(after.hiddenCompanies).toEqual([{ key: "acme", name: "Acme Inc." }]);
    // Still offered in the Company filter, marked hidden, and picking it shows its jobs.
    expect(after.facets.companies.find((c) => c.key === "acme")).toMatchObject({ count: 2, hidden: true });
    expect(titles(await list("?company=acme")).sort()).toEqual(["Engineer A", "Engineer B"]);

    // Hiding twice keeps one row.
    await ok(await call("POST", "/hidden-companies", { company: "ACME" }), HiddenCompanies);
    expect((await list()).hiddenCompanies).toHaveLength(1);

    expect(await ok(await call("DELETE", "/hidden-companies", { company: "acme" }), HiddenCompanies)).toEqual([]);
    expect((await list()).jobs).toHaveLength(3);
  });

  test("a company name with no letters or digits is refused", async () => {
    const body = await ok(await call("POST", "/hidden-companies", { company: "!!!" }), ApiErrorBody, 400);
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("save, dismiss and undo", () => {
  test("save puts the job on the board and out of Matches; undo puts it back", async () => {
    const id = await addJob({ title: "Backend Engineer", description: WORLDWIDE });
    const saved = await ok(await call("POST", `/jobs/${id}/save`), SavedJob);
    expect(titles(await list())).toEqual([]);
    const board = await ok(await call("GET", "/board"), z.array(BoardItemDto));
    expect(board).toMatchObject([{ opportunityId: saved.opportunityId, status: "saved", title: "Backend Engineer" }]);
    const ws = await ok(await call("GET", `/opportunities/${saved.opportunityId}`), WorkspaceDto);
    expect(ws.files.map((f) => f.kind)).toEqual(["resume", "letter", "message"]);

    // Saving twice returns the same opportunity.
    expect(await ok(await call("POST", `/jobs/${id}/save`), SavedJob)).toEqual(saved);

    await ok(await call("POST", `/jobs/${id}/undo`, { action: "save" }), z.unknown());
    expect(titles(await list())).toEqual(["Backend Engineer"]);
    expect(await ok(await call("GET", "/board"), z.array(BoardItemDto))).toEqual([]);
    const [outputs] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM outputs`;
    expect(outputs?.n).toBe(0);
  });

  test("a save with work on it is not undone", async () => {
    const id = await addJob({ title: "Backend Engineer", description: WORLDWIDE });
    const { opportunityId } = await ok(await call("POST", `/jobs/${id}/save`), SavedJob);
    await ok(await call("PATCH", `/opportunities/${opportunityId}`, { notes: "Call Ana" }), z.unknown());
    const body = await ok(await call("POST", `/jobs/${id}/undo`, { action: "save" }), ApiErrorBody, 409);
    expect(body.error.code).toBe("has_work");
    expect(await ok(await call("GET", "/board"), z.array(BoardItemDto))).toHaveLength(1);
  });

  test("dismiss hides the job and stores the reason; undo brings it back", async () => {
    const id = await addJob({ title: "Backend Engineer", description: WORLDWIDE });
    await ok(await call("POST", `/jobs/${id}/dismiss`, { reason: "wrong_stack" }), z.unknown());
    expect(titles(await list())).toEqual([]);
    const [row] = await testSql()<{ status: string | null; reason: string | null }[]>`
      SELECT status, dismiss_reason AS reason FROM opportunities`;
    expect(row).toEqual({ status: null, reason: "wrong_stack" });

    await ok(await call("POST", `/jobs/${id}/undo`, { action: "dismiss" }), z.unknown());
    expect(titles(await list())).toEqual(["Backend Engineer"]);
    // A second undo finds nothing to undo.
    await ok(await call("POST", `/jobs/${id}/undo`, { action: "dismiss" }), z.unknown());
  });

  test("dismiss without a reason; a job on the board cannot be dismissed", async () => {
    const a = await addJob({ title: "A Engineer", description: WORLDWIDE });
    await ok(await call("POST", `/jobs/${a}/dismiss`, { reason: null }), z.unknown());
    const b = await addJob({ title: "B Engineer", description: WORLDWIDE });
    await ok(await call("POST", `/jobs/${b}/save`), SavedJob);
    const body = await ok(await call("POST", `/jobs/${b}/dismiss`, { reason: "pay" }), ApiErrorBody, 409);
    expect(body.error.code).toBe("on_board");
  });

  test("saving a dismissed job puts it on the board with its files", async () => {
    const id = await addJob({ title: "Backend Engineer", description: WORLDWIDE });
    await ok(await call("POST", `/jobs/${id}/dismiss`, { reason: "other" }), z.unknown());
    const { opportunityId } = await ok(await call("POST", `/jobs/${id}/save`), SavedJob);
    const [row] = await testSql()<{ status: string; dismissed: boolean; reason: string | null }[]>`
      SELECT status, dismissed_at IS NOT NULL AS dismissed, dismiss_reason AS reason FROM opportunities`;
    expect(row).toEqual({ status: "saved", dismissed: false, reason: null });
    const ws = await ok(await call("GET", `/opportunities/${opportunityId}`), WorkspaceDto);
    expect(ws.files).toHaveLength(3);
  });

  test("an unknown job is a 404", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("POST", `/jobs/${missing}/save`)).status).toBe(404);
    expect((await call("GET", `/matches/${missing}`)).status).toBe(404);
  });
});
