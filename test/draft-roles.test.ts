import { beforeEach, describe, expect, test } from "bun:test";
import { extractText, getDocumentProxy } from "unpdf";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { PAREN_CV } from "./fixtures/roles-cv";
import { resetDb, testDeps, waitForSplits } from "./setup";

/* Role headers in a drafted resume (decision 71): the model writes [ROLE-n], the server the header. */

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

/**
 * `PAREN_CV` without its experience heading: the base CV parser reads the roles as contact lines
 * and finds none, so the resume is generated from facts (the fallback in decision 75) and these
 * tests keep covering the generator.
 */
const GENERATOR_CV = PAREN_CV.replace("PROFESSIONAL EXPERIENCE\n", "");

const LAKBAY = "### Full-stack Software Engineer | Lakbay Labs, Remote | Jan, 2026 – Jun, 2026";
const TALA = "### Backend Engineer | Tala.video, Remote, Part-time | Oct, 2025 – Apr, 2026";

/** A key, the role-shaped CV split with AI (roles read), facts confirmed, and one pasted job. */
async function setup(): Promise<{ ws: WorkspaceDto; profile: ProfileDto }> {
  await call("PUT", "/profile", {
    contact: { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] },
  });
  expect((await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
  await waitForSplits(await json(await call("PUT", "/profile/cv", { text: GENERATOR_CV }), ProfileDto));
  let profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
  // Sinag's only fact goes, so its role has nothing to show and stays out of the prompt.
  const mentored = profile.facts.find((f) => f.text.startsWith("Mentored"));
  profile = await json(await call("DELETE", `/facts/${mentored?.id}`), ProfileDto);
  const added = await json(
    await call("POST", "/jobs/from-paste", {
      title: "Backend Engineer",
      company: "Acme Inc",
      description: "Payments. Remote, worldwide.",
    }),
    AddJobResult,
    201,
  );
  deps.fake.calls.length = 0;
  return { ws: await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto), profile };
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

async function draft(ws: WorkspaceDto, kinds: string[]) {
  const task = await json(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { kinds }), TaskDto, 202);
  await waitForTask(task.id);
  const done = await json(await call("GET", `/tasks/${task.id}`), TaskDto);
  return { task: done, ws: await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto) };
}

const prompt = (i: number) => deps.fake.calls[i]?.messages[0]?.content ?? "";

describe("resume drafting with roles", () => {
  test("the prompt lists roles with facts; [ROLE-n] lines become headers that pass checkDraft", async () => {
    const { ws, profile } = await setup();
    const { task, ws: after } = await draft(ws, ["resume"]);
    expect(task).toMatchObject({ status: "done", error: null });

    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key;
    const text = prompt(0);
    expect(text).toContain(
      "ROLES\nROLE-1: Full-stack Software Engineer, Lakbay Labs, Remote, Jan, 2026 – Jun, 2026\nROLE-2: Backend Engineer, Tala.video, Remote, Part-time, Oct, 2025 – Apr, 2026\n\nREQUIREMENTS",
    );
    expect(text).not.toContain("Sinag");
    expect(text).toContain(`${key("Migrated")}: Migrated the API from Express to Hono on Cloudflare Workers. (ROLE-2)`);
    expect(text).toContain(`${key("B.S.")}: B.S. [R1]\n`);

    // One call: no retry, and the date dash is not a style hit.
    expect(deps.fake.calls).toHaveLength(1);
    const resume = file(after, "resume");
    expect(resume.styleHits).toEqual([]);
    const lines = (resume.body ?? "").split("\n");
    expect(lines.indexOf(LAKBAY)).toBeGreaterThan(lines.indexOf("## Experience"));
    expect(lines.indexOf(TALA)).toBeGreaterThan(lines.indexOf(LAKBAY));
    expect(lines[lines.indexOf(TALA) + 1]).toStartWith("- Migrated the API");
    expect(resume.body).not.toContain("[ROLE-");
  });

  test("the preview PDF and the copy text show each header like the CV", async () => {
    const { ws } = await setup();
    const { ws: after } = await draft(ws, ["resume"]);
    const resume = file(after, "resume");
    const res = await call("GET", `/outputs/${resume.id}/preview.pdf`);
    expect(res.status).toBe(200);
    const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
    const pdf = (await extractText(doc, { mergePages: true })).text;
    for (const part of ["Full-stack Software Engineer", "Jan, 2026 – Jun, 2026", "Lakbay Labs, Remote"]) {
      expect(pdf).toContain(part);
    }
    expect(pdf).not.toContain("###");
    expect(pdf).not.toContain(" | ");

    // Copy text is the same plain text; its export is gated until the other files are written.
    const text = resume.plain ?? "";
    expect(text).toContain("Full-stack Software Engineer, Lakbay Labs, Remote (Jan, 2026 – Jun, 2026)\n• Built");
    expect(text).toContain("Backend Engineer, Tala.video, Remote, Part-time (Oct, 2025 – Apr, 2026)");
  }, 30_000);

  test("an unknown [ROLE-n] is retried with the model's own text, then becomes a Check this blank", async () => {
    const { ws, profile } = await setup();
    const built = profile.facts.find((f) => f.text.startsWith("Built"));
    const reply = `# Maria Santos\n## Experience\n[ROLE-1]\n- Built a billing service [${built?.key}]\n[ROLE-7]`;
    deps.fake.queue(reply, reply);
    const { task, ws: after } = await draft(ws, ["resume"]);
    expect(task.status).toBe("done");
    expect(deps.fake.calls).toHaveLength(2);
    const retry = deps.fake.calls[1]?.messages ?? [];
    expect(retry[1]).toEqual({ role: "assistant", content: reply });
    expect(retry[2]?.content).toContain("writes [ROLE-7]");
    const body = file(after, "resume").body ?? "";
    expect(body).toContain(LAKBAY);
    expect(body).toContain('[[Check this: "ROLE-7" is not backed by your facts]]');
    expect(after.gate.ok).toBe(false);
  });

  test("a header the model types itself is checked like any claim", async () => {
    const { ws } = await setup();
    deps.fake.queue("## Experience\n### Staff Engineer | Google, Remote | 2019 – 2021", `## Experience\n[ROLE-1]`);
    const { ws: after } = await draft(ws, ["resume"]);
    expect(deps.fake.calls[1]?.messages[2]?.content).toContain("Google");
    expect(file(after, "resume").body).toBe(`## Experience\n${LAKBAY}`);
  });

  test("a fact under the wrong role is retried, then the model's fix is kept", async () => {
    const { ws, profile } = await setup();
    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key;
    // "Migrated" is a Tala.video (ROLE-2) fact; "B.S." has no role. Neither belongs under ROLE-1.
    const wrong = `## Experience\n[ROLE-1]\n- Migrated the API to Hono [${key("Migrated")}]\n- B.S. [${key("B.S.")}]`;
    const right = `## Experience\n[ROLE-2]\n- Migrated the API to Hono [${key("Migrated")}]\n## Education\n- B.S. [${key("B.S.")}]`;
    deps.fake.queue(wrong, right);
    const { task, ws: after } = await draft(ws, ["resume"]);
    expect(task.status).toBe("done");
    expect(deps.fake.calls).toHaveLength(2);
    const retry = deps.fake.calls[1]?.messages[2]?.content ?? "";
    expect(retry).toContain(`is under [ROLE-1] but cites ${key("Migrated")}`);
    expect(retry).toContain(`is under [ROLE-1] but cites ${key("B.S.")}`);
    const body = file(after, "resume").body ?? "";
    expect(body).toContain(`${TALA}\n- Migrated the API to Hono`);
    expect(body).not.toContain(LAKBAY);
  });

  test("a letter gets no roles", async () => {
    const { ws } = await setup();
    await draft(ws, ["letter"]);
    expect(prompt(0)).not.toContain("ROLE-");
  });
});

describe("requirement map (decision 73)", () => {
  const mapPrompt = (i: number) => deps.fake.mapCalls[i]?.messages[0]?.content ?? "";

  test("a role that proves a requirement keeps all its facts; a role that proves none keeps its context fact", async () => {
    const { ws, profile } = await setup();
    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key ?? "";
    deps.fake.queueMap(
      JSON.stringify({
        role: "Backend engineer",
        requirements: [
          { text: "Billing systems in TypeScript", weight: "must", facts: [key("Built a billing")] },
          { text: "Go", weight: "must", facts: ["FACT-999"] },
        ],
        context: [{ role: "ROLE-2", fact: key("Migrated") }],
      }),
    );
    const { task } = await draft(ws, ["resume"]);
    expect(task).toMatchObject({ status: "done", error: null });

    expect(deps.fake.mapCalls).toHaveLength(1);
    expect(mapPrompt(0)).toContain("Payments. Remote, worldwide.");
    const text = prompt(0);
    expect(text).toContain(`R1 (must): Billing systems in TypeScript <- ${key("Built a billing")}`);
    expect(text).toContain("R2 (must): Go <- no fact (a gap: never mention it)");
    expect(text).toContain(`${key("Built a billing")}: Built a billing`);
    // Lakbay proves R1, so its measured invoice fact stays and is REQUIRED; Tala keeps its context fact.
    expect(text).toContain(`${key("Migrated")}: Migrated the API`);
    expect(text).toContain(`${key("Cut invoice")}: Cut invoice`);
    expect(text).toContain(
      `REQUIRED: cite every one of these facts: ${key("Built a billing")}, ${key("Cut invoice")}.`,
    );
    // Facts with no role all stay, so Education can't disappear.
    expect(text).toContain(`${key("B.S.")}: B.S.`);
  });

  test("a redraft with the same posting and facts reuses the stored map; editing a fact reads it again", async () => {
    const { ws, profile } = await setup();
    await draft(ws, ["resume"]);
    await draft(ws, ["resume", "letter"]);
    expect(deps.fake.mapCalls).toHaveLength(1);

    const fact = profile.facts.find((f) => f.text.startsWith("Cut invoice"));
    await call("PATCH", `/facts/${fact?.id}`, { text: "Cut invoice processing time from 40 minutes to 5 minutes." });
    await draft(ws, ["resume"]);
    expect(deps.fake.mapCalls).toHaveLength(2);
    expect(mapPrompt(1)).toContain("from 40 minutes to 5 minutes");
  });

  test("an unreadable map is retried once; if still unreadable the draft goes ahead from every fact", async () => {
    const { ws, profile } = await setup();
    deps.fake.queueMap("not json", "still not json");
    const { task } = await draft(ws, ["resume"]);
    expect(task).toMatchObject({ status: "done", error: null });
    expect(deps.fake.mapCalls).toHaveLength(2);
    expect(deps.fake.mapCalls[1]?.messages.at(-1)?.content).toContain("That reply could not be read.");
    const text = prompt(0);
    expect(text).not.toContain("REQUIREMENTS");
    for (const f of profile.facts) expect(text).toContain(`${f.key}: `);

    // Nothing was stored, so the next draft tries again.
    await draft(ws, ["resume"]);
    expect(deps.fake.mapCalls).toHaveLength(3);
  });

  test("a letter gets the same requirements, without the resume's fact selection", async () => {
    const { ws, profile } = await setup();
    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key ?? "";
    deps.fake.queueMap(
      JSON.stringify({
        role: "Backend engineer",
        requirements: [{ text: "Billing systems", weight: "must", facts: [key("Built a billing")] }],
        context: [],
      }),
    );
    await draft(ws, ["letter"]);
    const text = prompt(0);
    expect(text).toContain("R1 (must): Billing systems");
    expect(text).toContain(`${key("Cut invoice")}: Cut invoice`);
  });
});

test("a resume that leaves out a REQUIRED fact is retried once, naming it (decision 74)", async () => {
  const { ws, profile } = await setup();
  const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key ?? "";
  deps.fake.queueMap(
    JSON.stringify({
      role: "Backend engineer",
      requirements: [{ text: "Billing systems", weight: "must", facts: [key("Built a billing")] }],
      context: [],
    }),
  );
  // The first draft cites only the billing fact; the retry gets the default writer, which cites all.
  deps.fake.queue(`## Experience\n\n- Built a billing service. [${key("Built a billing")}]`);
  const { task } = await draft(ws, ["resume"]);
  expect(task).toMatchObject({ status: "done", error: null });
  expect(deps.fake.calls).toHaveLength(2);
  expect(deps.fake.calls[1]?.messages.at(-1)?.content).toContain(
    `These REQUIRED facts are missing: ${key("Cut invoice")}.`,
  );
});
