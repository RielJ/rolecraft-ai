import { beforeEach, describe, expect, test } from "bun:test";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { PAREN_CV } from "./fixtures/roles-cv";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * A resume tailored from the user's own CV (decision 75). PAREN_CV parses as:
 * L3 PROFESSIONAL EXPERIENCE; L4 Lakbay role, L5 "Built a billing service…", L6 "Cut invoice…";
 * L7 Tala role, L8 "Migrated the API…"; L9 Sinag role, L10 "Mentored…"; L11 EDUCATION, L12 "B.S. …".
 */

let deps: Deps & { fake: FakeAi };
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

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

const LAKBAY = "### Full-stack Software Engineer | Lakbay Labs, Remote | Jan, 2026 – Jun, 2026";
const CUT = "Cut invoice processing time from 40 minutes to 6 minutes by batching queries.";
const BATCHED = "Batched queries to cut invoice processing time from 40 minutes to 6 minutes.";

async function setup(cv = PAREN_CV): Promise<{ ws: WorkspaceDto; profile: ProfileDto }> {
  await call("PUT", "/profile", {
    contact: { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] },
  });
  expect((await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
  await waitForSplits(await json(await call("PUT", "/profile/cv", { text: cv }), ProfileDto));
  const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
  const added = await json(
    await call("POST", "/jobs/from-paste", {
      title: "Backend Engineer",
      company: "Acme Inc",
      description: "Payments. Remote, worldwide.",
    }),
    AddJobResult,
    201,
  );
  deps.fake.reset();
  return { ws: await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto), profile };
}

async function draft(ws: WorkspaceDto, kinds: string[]) {
  const task = await json(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { kinds }), TaskDto, 202);
  await waitForTask(task.id);
  const done = await json(await call("GET", `/tasks/${task.id}`), TaskDto);
  const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
  return { task: done, ws: after, resume: after.files.find((f) => f.kind === "resume") };
}

const decide = (outputId: string, body: unknown) => call("POST", `/outputs/${outputId}/changes`, body);

/** A draft with three changes: C1 reorders Lakbay's bullets, C2 rewords L6, C3 rewords L8 (Tala). */
async function threeChanges() {
  const { ws, profile } = await setup();
  deps.fake.queueTailor(
    JSON.stringify({
      ops: [
        { op: "order", parent: "L4", lines: ["L6", "L5"], reasons: ["R1"] },
        { op: "reword", line: "L6", text: BATCHED, reasons: ["R1"] },
        { op: "reword", line: "L8", text: "Moved the API from Express to Hono on Cloudflare Workers." },
      ],
    }),
  );
  const { resume, ws: after } = await draft(ws, ["resume"]);
  if (!resume) throw new Error("no resume");
  return { ws: after, resume, profile };
}

const reword = (line: string, text: string) => JSON.stringify({ ops: [{ op: "reword", line, text, reasons: ["R1"] }] });

describe("tailoring the resume from the CV (decision 75)", () => {
  test("a map call and one tailor call; no edits keeps the CV as it is", async () => {
    const { ws, profile } = await setup();
    deps.fake.queueTailor('{"ops": []}');
    const { task, resume } = await draft(ws, ["resume"]);
    expect(task).toMatchObject({ status: "done", error: null });
    expect(deps.fake.mapCalls).toHaveLength(1);
    expect(deps.fake.tailorCalls).toHaveLength(1);
    expect(deps.fake.calls).toHaveLength(0);

    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key;
    const body = resume?.body ?? "";
    expect(body.split("\n").slice(0, 5)).toEqual([
      "## PROFESSIONAL EXPERIENCE",
      "",
      LAKBAY,
      `- Built a billing service in TypeScript and Postgres for 40 clinics. [${key("Built")}]`,
      `- ${CUT} [${key("Cut")}]`,
    ]);
    expect(body).not.toContain("MARIA SANTOS");
    expect(resume?.tailoring).toMatchObject({ changes: [], dropped: 0, baseChanged: false });
    expect(resume?.styleHits).toEqual([]);
    expect(resume?.outdated).toEqual([]);

    const prompt = deps.fake.tailorCalls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(`L6 bullet (ROLE-1) (keep) [R1]: ${CUT}`);
  });

  test("a reword the CV backs is applied and listed with its reason", async () => {
    const { ws } = await setup();
    deps.fake.queueTailor(reword("L6", BATCHED));
    const { resume } = await draft(ws, ["resume"]);
    expect(deps.fake.tailorCalls).toHaveLength(1);
    expect(resume?.body).toContain(`- ${BATCHED} [`);
    expect(resume?.body).not.toContain(CUT);
    expect(resume?.tailoring?.changes).toEqual([
      {
        id: "C1",
        op: "reword",
        status: "accepted",
        before: CUT,
        after: BATCHED,
        beforeList: null,
        afterList: null,
        where: "Full-stack Software Engineer, Lakbay Labs, Remote",
        reasons: [{ id: "R1", text: "The work this job describes" }],
        note: null,
      },
    ]);
  });

  test("an invented tool is dropped and retried once with the reason; the retry's edit is kept", async () => {
    const { ws } = await setup();
    deps.fake.queueTailor(reword("L6", `${CUT.slice(0, -1)} on Kubernetes.`), reword("L6", BATCHED));
    const { resume } = await draft(ws, ["resume"]);
    expect(deps.fake.tailorCalls).toHaveLength(2);
    expect(deps.fake.tailorCalls[1]?.messages.at(-1)?.content).toContain("reword L6: says Kubernetes");
    expect(resume?.body).toContain(BATCHED);
    expect(resume?.body).not.toContain("Kubernetes");
    expect(resume?.tailoring).toMatchObject({ dropped: 0 });
  });

  test("an edit still invented after the retry is dropped, and the CV line stays", async () => {
    const { ws } = await setup();
    const bad = reword("L6", `${CUT.slice(0, -1)} on Kubernetes.`);
    deps.fake.queueTailor(bad, bad);
    const { resume } = await draft(ws, ["resume"]);
    expect(resume?.body).toContain(CUT);
    expect(resume?.tailoring).toMatchObject({ changes: [], dropped: 1 });
  });

  test("a line holding a REQUIRED fact is never removed", async () => {
    const { ws } = await setup();
    const remove = JSON.stringify({ ops: [{ op: "remove", line: "L10" }] });
    deps.fake.queueTailor(remove, remove);
    const { resume } = await draft(ws, ["resume"]);
    expect(deps.fake.tailorCalls[1]?.messages.at(-1)?.content).toContain("remove L10: the line is marked (keep).");
    expect(resume?.body).toContain("Mentored 3 junior engineers");
  });

  test("two unreadable replies leave the CV as it is; the task still finishes", async () => {
    const { ws } = await setup();
    deps.fake.queueTailor("Sure! Here are some edits.", "Still not JSON");
    const { task, resume } = await draft(ws, ["resume"]);
    expect(task.status).toBe("done");
    expect(deps.fake.tailorCalls).toHaveLength(2);
    expect(deps.fake.calls).toHaveLength(0);
    expect(resume?.body).toContain(CUT);
    expect(resume?.tailoring).toMatchObject({ changes: [], dropped: 0 });
  });

  test("an unreadable retry keeps the first reply's edits that passed", async () => {
    const { ws } = await setup();
    const ops = {
      ops: [
        { op: "reword", line: "L6", text: BATCHED },
        { op: "reword", line: "L8", text: "Migrated the API from Express to Hono on Kubernetes." },
      ],
    };
    deps.fake.queueTailor(JSON.stringify(ops), "not JSON");
    const { resume } = await draft(ws, ["resume"]);
    expect(resume?.body).toContain(BATCHED);
    expect(resume?.body).toContain("Migrated the API from Express to Hono on Cloudflare Workers.");
    expect(resume?.tailoring).toMatchObject({ dropped: 1 });
  });

  test("the fake's default reply reorders the first role's bullets and shortens another role's bullet", async () => {
    const { ws } = await setup();
    const { resume } = await draft(ws, ["resume"]);
    expect(resume?.tailoring?.changes.map((c) => [c.op, c.after])).toEqual([
      ["order", null],
      ["reword", "Migrated the API from Express to Hono."],
    ]);
    expect(resume?.tailoring?.dropped).toBe(0);
    expect((resume?.body ?? "").indexOf(CUT)).toBeLessThan((resume?.body ?? "").indexOf("Built a billing"));
  });

  test("a CV the parser can't use goes to the generator", async () => {
    const { ws } = await setup(PAREN_CV.replace("PROFESSIONAL EXPERIENCE\n", ""));
    const { resume } = await draft(ws, ["resume"]);
    expect(deps.fake.tailorCalls).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(1);
    expect(resume?.tailoring).toBeNull();
  });

  test("a cover letter is drafted as before", async () => {
    const { ws } = await setup();
    const { ws: after } = await draft(ws, ["letter"]);
    expect(deps.fake.tailorCalls).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(1);
    expect(after.files.find((f) => f.kind === "letter")?.tailoring).toBeNull();
  });

  test("importing the CV again marks the tailoring as based on the old CV", async () => {
    const { ws } = await setup();
    await draft(ws, ["resume"]);
    await waitForSplits(
      await json(await call("PUT", "/profile/cv", { text: `${PAREN_CV}\nAWS Certified (2024)` }), ProfileDto),
    );
    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(after.files.find((f) => f.kind === "resume")?.tailoring?.baseChanged).toBe(true);
  });
});

describe("keeping and undoing changes (decision 75)", () => {
  test("undoing a change restores the CV line exactly; keeping it again brings the change back", async () => {
    const { resume, profile } = await threeChanges();
    expect(resume.tailoring?.changes.map((c) => [c.id, c.op])).toEqual([
      ["C1", "order"],
      ["C2", "reword"],
      ["C3", "reword"],
    ]);
    const original = resume.body ?? "";
    expect(original.indexOf(BATCHED)).toBeLessThan(original.indexOf("Built a billing"));

    let ws = await json(await decide(resume.id, { ids: ["C2"], status: "rejected" }), WorkspaceDto);
    let body = ws.files.find((f) => f.kind === "resume")?.body ?? "";
    const cutKey = profile.facts.find((f) => f.text.startsWith("Cut"))?.key;
    expect(body).toContain(`- ${CUT} [${cutKey}]`);
    expect(body).not.toContain(BATCHED);
    expect(ws.files.find((f) => f.kind === "resume")?.tailoring?.changes.map((c) => c.status)).toEqual([
      "accepted",
      "rejected",
      "accepted",
    ]);

    ws = await json(await decide(resume.id, { ids: ["C2"], status: "accepted" }), WorkspaceDto);
    body = ws.files.find((f) => f.kind === "resume")?.body ?? "";
    expect(body).toBe(original);
  });

  test("Undo all gives back the CV as it was", async () => {
    const { resume } = await threeChanges();
    const ws = await json(await decide(resume.id, { ids: ["C1", "C2", "C3"], status: "rejected" }), WorkspaceDto);
    const body = ws.files.find((f) => f.kind === "resume")?.body ?? "";
    const lines = body.split("\n");
    expect(lines.findIndex((l) => l.includes("Built a billing"))).toBeLessThan(lines.findIndex((l) => l.includes(CUT)));
    expect(body).toContain("Migrated the API from Express to Hono");
    expect(body).not.toContain("Moved the API");
  });

  test("citations follow the body: an undone add loses its row, and kept rows keep their snapshot", async () => {
    const { ws, profile } = await setup();
    const mentored = profile.facts.find((f) => f.text.startsWith("Mentored"));
    // Sinag's fact moves to Tala's role, so it is offered there as a fact not in the CV.
    await testSql()`UPDATE facts SET role_id = (SELECT role_id FROM facts WHERE text LIKE 'Migrated%') WHERE id = ${mentored?.id ?? ""}`;
    deps.fake.queueTailor(
      JSON.stringify({
        ops: [
          { op: "add", after: "L8", text: "Mentored 3 junior engineers through code review.", facts: [mentored?.key] },
        ],
      }),
    );
    const { resume } = await draft(ws, ["resume"]);
    expect(resume?.tailoring?.changes.map((c) => c.op)).toEqual(["add"]);
    const cited = async () =>
      (await testSql()`SELECT fact_key FROM output_facts WHERE output_id = ${resume?.id ?? ""} ORDER BY fact_key`).map(
        (r) => r.fact_key,
      );
    expect(await cited()).toContain(mentored?.key);
    await decide(resume?.id ?? "", { ids: ["C1"], status: "rejected" });
    expect(await cited()).not.toContain(mentored?.key);
  });

  test("an unknown change id is output_changed; a frozen job is refused", async () => {
    const { ws, resume } = await threeChanges();
    const unknown = await decide(resume.id, { ids: ["C9"], status: "rejected" });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: { code: "output_changed" } });

    await testSql()`UPDATE opportunities SET status = 'applied' WHERE id = ${ws.opportunity.id}`;
    const frozen = await decide(resume.id, { ids: ["C1"], status: "rejected" });
    expect(frozen.status).toBe(409);
    expect(await frozen.json()).toMatchObject({ error: { code: "frozen" } });
  });

  test("a hand edit ends the tailoring, so its changes can't be decided", async () => {
    const { resume } = await threeChanges();
    const edited = await json(
      await call("PATCH", `/outputs/${resume.id}`, { text: `${resume.plain ?? ""}\nOne more line.` }),
      WorkspaceDto,
    );
    expect(edited.files.find((f) => f.kind === "resume")?.tailoring).toBeNull();
    expect((await decide(resume.id, { ids: ["C1"], status: "rejected" })).status).toBe(409);
  });

  test("a decision clears the review", async () => {
    const { resume } = await threeChanges();
    await testSql()`UPDATE outputs SET reviewed_at = now() WHERE id = ${resume.id}`;
    const ws = await json(await decide(resume.id, { ids: ["C3"], status: "rejected" }), WorkspaceDto);
    expect(ws.files.find((f) => f.kind === "resume")?.reviewedAt).toBeNull();
  });
});

describe("tailoring adds a project the CV lacks (decision 82)", () => {
  async function withProject() {
    const { ws } = await setup();
    await waitForSplits(
      await json(
        await call("POST", "/profile/addons", {
          kind: "open_source",
          title: "Nyx",
          body: "Nyx is a CLI that schedules Go jobs on Kubernetes.",
          link: "https://github.com/maria/nyx",
          skills: ["Go", "Kubernetes"],
          projectRole: "own",
        }),
        ProfileDto,
        201,
      ),
    );
    const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    deps.fake.reset();
    const nyx = profile.facts.find((f) => f.text.startsWith("Nyx is"))?.key;
    if (!nyx) throw new Error("no Nyx fact");
    return { ws, nyx };
  }

  test("the prompt offers it; the kept op adds the head and lines under a new Projects heading", async () => {
    const { ws, nyx } = await withProject();
    deps.fake.queueTailor(
      JSON.stringify({
        ops: [
          {
            op: "project",
            project: "PROJECT-1",
            lines: [{ text: "A CLI that schedules Go jobs on Kubernetes.", facts: [nyx] }],
            reasons: [],
          },
        ],
      }),
    );
    const { resume, task } = await draft(ws, ["resume"]);
    expect(task.status).toBe("done");
    const prompt = deps.fake.tailorCalls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("PROJECTS\nPROJECT-1: Nyx (your own project)");
    expect(prompt).toContain(`${nyx} (PROJECT-1) (not in the CV) [R1]: Nyx is a CLI`);
    expect(deps.fake.tailorCalls).toHaveLength(1);

    expect(resume?.body).toContain(
      `## Projects\n\n#### Nyx | https://github.com/maria/nyx | Go, Kubernetes\nA CLI that schedules Go jobs on Kubernetes. [${nyx}]\n\n## EDUCATION`,
    );
    expect(resume?.tailoring?.changes).toMatchObject([
      {
        id: "C1",
        op: "project",
        where: "Projects",
        afterList: ["Nyx · github.com/maria/nyx · Go, Kubernetes", "A CLI that schedules Go jobs on Kubernetes."],
      },
    ]);
    expect(resume?.citations.map((c) => c.key)).toContain(nyx);

    // Undoing it takes out the heading too.
    const undone = await json(await decide(resume?.id ?? "", { ids: ["C1"], status: "rejected" }), WorkspaceDto);
    const body = undone.files.find((f) => f.kind === "resume")?.body ?? "";
    expect(body).not.toContain("Nyx");
    expect(body).not.toContain("## Projects");
  });

  test("a project op citing a role's fact is retried with the reason", async () => {
    const { ws } = await withProject();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const built = profile.facts.find((f) => f.text.startsWith("Built a billing"))?.key;
    const bad = JSON.stringify({
      ops: [{ op: "project", project: "PROJECT-1", lines: [{ text: "Built a billing service.", facts: [built] }] }],
    });
    deps.fake.queueTailor(bad, '{"ops": []}');
    await draft(ws, ["resume"]);
    expect(deps.fake.tailorCalls).toHaveLength(2);
    expect(deps.fake.tailorCalls[1]?.messages.at(-1)?.content).toContain(
      `the project PROJECT-1: ${built} is not one of that project's facts.`,
    );
  });
});
