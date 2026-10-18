import { beforeEach, describe, expect, test } from "bun:test";
import { BUILTIN_SKILLS_VERSION, compileSkills } from "@/domain/features";
import { derive, type JobFields, jobSkills } from "@/domain/posting";
import { dictionaryStamp, skillsStamp } from "@/domain/user-skills";
import { jobs } from "@/server/db/schema";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { type JobId, MatchList, ProfileDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * A skill of your own reaches stored jobs inside `PUT /api/profile/skills` (decision 68): Postgres
 * narrows the open jobs to those whose text contains the skill's literal, the exact regex decides,
 * and the jobs' skills stamp moves to the new one in the same transaction.
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

async function setSkill(name: string, state: "added" | "hidden" | "none"): Promise<ProfileDto> {
  const res = await call("PUT", "/profile/skills", { name, state });
  expect(res.status).toBe(200);
  return ProfileDto.parse(await res.json());
}

let seen = 0;
/** A job as sync stores it, read with the built-ins unless a dictionary is given. */
async function addJob(
  fields: Partial<JobFields> & { title: string; description: string; closed?: boolean },
  dict = compileSkills([]),
): Promise<JobId> {
  seen++;
  const { closed, ...rest } = fields;
  const derived = derive(
    {
      company: "Acme",
      locationText: "Remote",
      applyUrl: null,
      postedAt: null,
      expiresAt: null,
      pay: null,
      restrictions: null,
      ...rest,
    },
    dict,
  );
  const at = new Date(Date.parse("2026-10-01T00:00:00Z") + seen * 60_000);
  const [row] = await deps.db
    .insert(jobs)
    .values({
      userId: deps.userId,
      origin: "source",
      ...derived,
      firstSeenAt: at,
      updatedAt: at,
      closedAt: closed ? at : null,
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

type Stored = { title: string; description: string; skills: string[]; stamp: string | null; closed: boolean };
async function stored(): Promise<Stored[]> {
  return testSql()<Stored[]>`
    SELECT title, description, skills, skills_stamp AS stamp, closed_at IS NOT NULL AS closed
    FROM jobs ORDER BY title`;
}
const skillsOf = async (title: string) => (await stored()).find((j) => j.title === title)?.skills;
const stamp = (...customNames: string[]) => skillsStamp({ version: BUILTIN_SKILLS_VERSION, customNames });

/** Every open job's skills are what a full read with the user's current list gives. */
async function expectFreshRead(custom: string[]): Promise<void> {
  const dict = compileSkills(custom);
  for (const job of (await stored()).filter((j) => !j.closed)) {
    expect({ title: job.title, skills: job.skills, stamp: job.stamp }).toEqual({
      title: job.title,
      skills: jobSkills(job, dict),
      stamp: dictionaryStamp(dict),
    });
  }
}

describe("adding and removing a skill of your own (decision 68)", () => {
  test("shows on Matches at once, with no Refresh, and leaves at once when removed", async () => {
    await addJob({ title: "Backend Engineer", description: "Go services behind Hasura. Remote worldwide." });
    await addJob({ title: "Frontend Engineer", description: "React and TypeScript." });
    await addJob({ title: "Closed Engineer", description: "Go and Hasura.", closed: true });
    const asked = async (title: string) => {
      const res = await call("GET", "/matches?excluded=true");
      return MatchList.parse(await res.json()).jobs.find((j) => j.title === title)?.skills.asked;
    };
    expect(await asked("Backend Engineer")).toBe(1);

    await setSkill("Hasura", "added");
    expect(await asked("Backend Engineer")).toBe(2);
    expect(await stored()).toEqual([
      {
        title: "Backend Engineer",
        description: expect.any(String),
        skills: ["Go", "Hasura"],
        stamp: stamp("Hasura"),
        closed: false,
      },
      // A closed job keeps its skills and its old stamp: if it reopens, the next Refresh reads it.
      { title: "Closed Engineer", description: expect.any(String), skills: ["Go"], stamp: stamp(), closed: true },
      {
        title: "Frontend Engineer",
        description: expect.any(String),
        skills: ["TypeScript", "React"],
        stamp: stamp("Hasura"),
        closed: false,
      },
    ]);
    await expectFreshRead(["Hasura"]);

    await setSkill("hasura", "none");
    expect(await asked("Backend Engineer")).toBe(1);
    expect(await skillsOf("Backend Engineer")).toEqual(["Go"]);
    await expectFreshRead([]);
  });

  test("a second skill goes after the first, as a full read orders them", async () => {
    await addJob({ title: "Platform Engineer", description: "Temporal workflows and Hasura, on Go." });
    await setSkill("Temporal", "added");
    await setSkill("Hasura", "added");
    expect(await skillsOf("Platform Engineer")).toEqual(["Go", "Temporal", "Hasura"]);
    await expectFreshRead(["Temporal", "Hasura"]);
    await setSkill("Temporal", "none");
    await expectFreshRead(["Hasura"]);
  });

  test("finds the skill in slash-joined words, which the text-search index splits wrongly", async () => {
    const texts = {
      "Job A": "We use React/Redux and Hasura/Postgres.",
      "Job B": "Clouds: AWS/GCP/Pulumi.",
      "Job C": "Run containers/Kubernetes/Nomad in prod.",
      "Job D": "Reports in Power BI/Tableau.",
      "Job E": "Read our post at x.com/temporal today.",
    };
    for (const [title, description] of Object.entries(texts)) await addJob({ title, description });
    const custom = ["Hasura", "Pulumi", "Nomad", "Power BI", "Temporal"];
    // jobs.search, the index Matches searches with, finds none of them (decision 68).
    for (const name of custom) {
      const [hit] = await testSql()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM jobs WHERE search @@ phraseto_tsquery('english', ${name})`;
      expect({ name, n: hit?.n }).toEqual({ name, n: 0 });
    }
    for (const name of custom) await setSkill(name, "added");
    expect(
      Object.fromEntries((await stored()).map((j) => [j.title, j.skills.filter((s) => custom.includes(s))])),
    ).toEqual({
      "Job A": ["Hasura"],
      "Job B": ["Pulumi"],
      "Job C": ["Nomad"],
      "Job D": ["Power BI"],
      "Job E": ["Temporal"],
    });
    await expectFreshRead(custom);
  });

  test("a stopword name matches as written; C++/CLI does not match a job that says C and CLI", async () => {
    await addJob({ title: "Support Engineer", description: "Join our IT team. It is remote." });
    await addJob({ title: "Writer", description: "It is a writing job about it." });
    await addJob({ title: "Windows Engineer", description: "Managed C++/CLI interop." });
    await addJob({ title: "Embedded Engineer", description: "We write C and CLI tools in C." });
    await setSkill("IT", "added");
    await setSkill("C++/CLI", "added");
    expect(await skillsOf("Support Engineer")).toEqual(["IT"]);
    expect(await skillsOf("Writer")).toEqual([]);
    // The built-in C++ is read as before; the skill of your own matches its exact spelling only.
    expect(await skillsOf("Windows Engineer")).toEqual(["C++", "C++/CLI"]);
    expect(await skillsOf("Embedded Engineer")).toEqual([]);
    await expectFreshRead(["IT", "C++/CLI"]);
  });

  test("names outside ASCII: Postgres lowercases the text and the name alike", async () => {
    // Known to work under the database's en_US.utf8 collation. Characters a case-insensitive regex
    // folds but Postgres' lower() keeps (the long s ſ, the Kelvin sign) are the known gap.
    await addJob({ title: "Job Ñ", description: "Our ÑANDÚ platform team." });
    await addJob({ title: "Job Z", description: "An office in İzmir and one in ZÜRICH." });
    await addJob({ title: "Job S", description: "Die STRAẞE und die Straße." });
    await setSkill("Ñandú", "added");
    await setSkill("İzmir", "added");
    await setSkill("Zürich", "added");
    await setSkill("Straße", "added");
    expect(Object.fromEntries((await stored()).map((j) => [j.title, j.skills]))).toEqual({
      "Job S": ["Straße"],
      "Job Z": ["İzmir", "Zürich"],
      "Job Ñ": ["Ñandú"],
    });
    await expectFreshRead(["Ñandú", "İzmir", "Zürich", "Straße"]);
  });

  test("a built-in skill, a hidden one, or the same skill again writes no job", async () => {
    await addJob({ title: "Backend Engineer", description: "Go, Postgres and Hasura." });
    await setSkill("Hasura", "added");
    const before = await stored();
    await setSkill("Hasura", "added");
    await setSkill("python", "added");
    await setSkill("Python", "none");
    expect(await stored()).toEqual(before);
  });

  test("a job read with an older list keeps its stamp, so the next Refresh reads it", async () => {
    // Saved by a Refresh that started before Hasura was added: read without it.
    await setSkill("Temporal", "added");
    await addJob({ title: "Stale Engineer", description: "Hasura and Temporal." }, compileSkills([]));
    await setSkill("Hasura", "added");
    // Hasura is on it at once all the same, but its stamp still says it needs reading.
    expect(await stored()).toEqual([
      { title: "Stale Engineer", description: expect.any(String), skills: ["Hasura"], stamp: stamp(), closed: false },
    ]);
  });
});
