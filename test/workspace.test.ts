import { beforeEach, describe, expect, test } from "bun:test";
import { extractText, getDocumentProxy } from "unpdf";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddJobResult, ApiErrorBody, type GateBlocker, ProfileDto, TextExport, WorkspaceDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

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

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

const CV = [
  "Juan Dela Cruz",
  "EXPERIENCE",
  "- Built a payments API in Go serving 2M requests a day",
  "- Led a team of 4 engineers at Acme Corp",
  "I moved our job queue to Postgres in 2022.",
].join("\n");

const JOB = {
  url: "https://jobs.lever.co/acme/123?utm_source=linkedin",
  title: "Senior Backend Engineer",
  company: "Acme Inc",
  description: "We need someone to build payment APIs. Remote, worldwide.",
};

async function pasteJob(): Promise<WorkspaceDto> {
  const added = await json(await call("POST", "/jobs/from-paste", JOB), AddJobResult, 201);
  return json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

/** Writes all three files so only the blocker under test remains. */
async function writeAllFiles(ws: WorkspaceDto, resumeBody: string): Promise<WorkspaceDto> {
  await call("PATCH", `/outputs/${file(ws, "letter").id}`, { body: "Dear Acme, I build payment APIs [FACT-1]." });
  await call("PATCH", `/outputs/${file(ws, "message").id}`, { body: "Hi, I led a team of 4 [FACT-2]." });
  return json(await call("PATCH", `/outputs/${file(ws, "resume").id}`, { body: resumeBody }), WorkspaceDto);
}

async function confirmedProfile(): Promise<ProfileDto> {
  await call("PUT", "/profile", {
    contact: {
      fullName: "Juan Dela Cruz",
      email: "juan@example.ph",
      phone: "+63 917 000 0000",
      location: "Manila, Philippines",
      links: ["https://github.com/juan"],
    },
  });
  await call("PUT", "/profile/cv", { text: CV });
  return json(await call("POST", "/facts/confirm-all"), ProfileDto);
}

describe("profile: CV paste to facts", () => {
  test("pasting CV text creates a cv item and pending facts by rule split; confirming moves them to confirmed", async () => {
    const profile = await json(await call("PUT", "/profile/cv", { text: CV }), ProfileDto);
    expect(profile.cv?.text).toBe(CV);
    expect(profile.facts.map((f) => [f.key, f.text, f.status, f.itemKind])).toEqual([
      ["FACT-1", "Juan Dela Cruz", "pending", "cv"],
      ["FACT-2", "Built a payments API in Go serving 2M requests a day", "pending", "cv"],
      ["FACT-3", "Led a team of 4 engineers at Acme Corp", "pending", "cv"],
      ["FACT-4", "I moved our job queue to Postgres in 2022.", "pending", "cv"],
    ]);
    const items = await testSql()`SELECT kind, rev FROM profile_items`;
    expect([...items]).toEqual([{ kind: "cv", rev: 1 }]);

    const first = profile.facts[1];
    if (!first) throw new Error("missing fact");
    const one = await json(await call("POST", `/facts/${first.id}/confirm`), ProfileDto);
    expect(one.facts.filter((f) => f.status === "confirmed").map((f) => String(f.key))).toEqual(["FACT-2"]);

    const all = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(all.facts.every((f) => f.status === "confirmed")).toBe(true);
    for (const f of all.facts) expect(f.key).toMatch(/^FACT-\d+$/);
  });

  test("re-pasting keeps unchanged facts and their keys, drops vanished pending ones", async () => {
    const before = await confirmedProfile();
    const kept = before.facts.find((f) => f.text.startsWith("Built a payments"));
    const after = await json(
      await call("PUT", "/profile/cv", {
        text: "- Built a payments API in Go serving 2M requests a day\n- Wrote docs",
      }),
      ProfileDto,
    );
    const again = after.facts.find((f) => f.text.startsWith("Built a payments"));
    expect(String(again?.id)).toBe(String(kept?.id));
    expect(String(again?.key)).toBe(String(kept?.key));
    expect(again?.status).toBe("confirmed");
    const added = after.facts.find((f) => f.text === "Wrote docs");
    expect(added?.status).toBe("pending");
    expect(String(added?.key)).toBe("FACT-5");
    // Vanished confirmed facts stay (slice 3 lists them under "Not in your latest CV").
    expect(after.facts.some((f) => f.text === "Led a team of 4 engineers at Acme Corp")).toBe(true);
  });

  test("saving one standard answer keeps the others; a blank answer clears only itself", async () => {
    await call("PUT", "/profile", { standardAnswers: { salary: "PHP 180,000", notice: "30 days" } });
    await call("PUT", "/profile", { standardAnswers: { work_auth: "Filipino citizen, no visa needed" } });
    const after = await json(await call("PUT", "/profile", { standardAnswers: { notice: " " } }), ProfileDto);
    expect(after.standardAnswers).toEqual({ salary: "PHP 180,000", work_auth: "Filipino citizen, no visa needed" });
  });

  test("a deleted fact's key is never reused", async () => {
    const profile = await json(await call("PUT", "/profile/cv", { text: "- One\n- Two" }), ProfileDto);
    const two = profile.facts.find((f) => f.key === "FACT-2");
    await call("DELETE", `/facts/${two?.id}`);
    const after = await json(await call("PUT", "/profile/cv", { text: "- One\n- Three" }), ProfileDto);
    expect(after.facts.map((f) => String(f.key))).toEqual(["FACT-1", "FACT-3"]);
  });
});

describe("jobs: paste", () => {
  test("pasting a job creates a paste job, a saved opportunity and three file outputs", async () => {
    const ws = await pasteJob();
    const [job] = await testSql()`SELECT origin, title_key, company_key, apply_url_key FROM jobs`;
    expect(job).toEqual({
      origin: "paste",
      title_key: "backend engineer senior",
      company_key: "acme",
      apply_url_key: "https://jobs.lever.co/acme/123",
    });
    const [opp] = await testSql()`SELECT status, history FROM opportunities`;
    expect(opp?.status).toBe("saved");
    expect(opp?.history).toEqual([{ at: "2026-10-16T08:00:00.000Z", from: null, to: "saved" }]);
    expect(ws.files.map((f) => [f.kind, f.body, f.included])).toEqual([
      ["resume", null, true],
      ["letter", null, true],
      ["message", null, true],
    ]);
    expect(ws.answers).toEqual([]);
    expect(ws.opportunity.status).toBe("saved");
  });

  test("the same apply URL and title returns the existing job", async () => {
    const first = await json(await call("POST", "/jobs/from-paste", JOB), AddJobResult, 201);
    const second = await json(
      await call("POST", "/jobs/from-paste", { ...JOB, url: "https://jobs.lever.co/acme/123/" }),
      AddJobResult,
    );
    expect(second).toEqual({ kind: "existing", opportunityId: first.opportunityId });
  });

  test("bad input returns 400 with the error shape", async () => {
    const body = await json(await call("POST", "/jobs/from-paste", { title: "", company: "x" }), ApiErrorBody, 400);
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("workspace: must-answer questions and the gate", () => {
  test("a salary question is must-answer; export and ready return 409 needs_input until the profile answers it", async () => {
    await confirmedProfile();
    let ws = await pasteJob();
    ws = await writeAllFiles(ws, "# Summary\n- Built a payments API [FACT-2]");
    expect(ws.gate).toEqual({ ok: true });

    ws = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/questions`, {
        question: "What are your salary expectations?",
      }),
      WorkspaceDto,
      201,
    );
    const question = ws.answers[0];
    if (!question) throw new Error("no question");
    expect(question.mustAnswer).toBe("salary");
    const [row] = await testSql()`SELECT must_answer FROM outputs WHERE id = ${question.id}`;
    expect(row?.must_answer).toBe("salary");

    const expected: GateBlocker[] = [
      {
        kind: "must_answer",
        outputId: question.id,
        question: "What are your salary expectations?",
        category: "salary",
      },
    ];
    for (const res of [
      await call("GET", `/outputs/${file(ws, "resume").id}/export.pdf`),
      await call("POST", `/opportunities/${ws.opportunity.id}/ready`),
      await call("GET", `/outputs/${file(ws, "message").id}/text`),
    ]) {
      const body = await json(res, ApiErrorBody, 409);
      expect(body.error.code).toBe("needs_input");
      expect(body.error.details).toEqual(expected);
    }

    const outputsBefore = await testSql()`SELECT id, body, must_answer, edited_at FROM outputs ORDER BY id`;
    await call("PUT", "/profile", { standardAnswers: { salary: "PHP 180,000 a month" } });
    const outputsAfter = await testSql()`SELECT id, body, must_answer, edited_at FROM outputs ORDER BY id`;
    expect([...outputsAfter]).toEqual([...outputsBefore]);

    ws = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(ws.gate).toEqual({ ok: true });
    expect(ws.answers[0]?.profileAnswer).toBe("PHP 180,000 a month");
    expect((await call("POST", `/opportunities/${ws.opportunity.id}/ready`)).status).toBe(200);
    ws = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(ws.opportunity.ready).toBe(true);
    const text = await json(await call("GET", `/outputs/${question.id}/text`), TextExport);
    expect(text.text).toBe("PHP 180,000 a month");
  });

  test("adding a must-answer question after ready shows the job as not ready again", async () => {
    await confirmedProfile();
    let ws = await writeAllFiles(await pasteJob(), "Resume [FACT-1]");
    await call("POST", `/opportunities/${ws.opportunity.id}/ready`);
    await call("POST", `/opportunities/${ws.opportunity.id}/questions`, { question: "When can you start?" });
    ws = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(ws.opportunity.ready).toBe(false);
  });

  test("a [[placeholder]] in an included body blocks export; unticking that file clears the block", async () => {
    await confirmedProfile();
    let ws = await writeAllFiles(await pasteJob(), "Resume [FACT-1]");
    const letter = file(ws, "letter");
    ws = await json(
      await call("PATCH", `/outputs/${letter.id}`, { body: "I led [[team size]] people [FACT-3]." }),
      WorkspaceDto,
    );
    const blocked = await json(await call("GET", `/outputs/${file(ws, "resume").id}/export.pdf`), ApiErrorBody, 409);
    expect(blocked.error.details).toEqual([{ kind: "placeholder", outputId: letter.id, text: "team size" }]);

    ws = await json(await call("PATCH", `/outputs/${letter.id}`, { included: false }), WorkspaceDto);
    expect(ws.gate).toEqual({ ok: true });
    const res = await call("GET", `/outputs/${file(ws, "resume").id}/export.pdf`);
    expect(res.status).toBe(200);
  });

  test("an empty included file blocks as not drafted", async () => {
    const ws = await pasteJob();
    expect(ws.gate.ok).toBe(false);
    if (!ws.gate.ok) expect(ws.gate.blockers.map((b) => b.kind)).toEqual(["not_drafted", "not_drafted", "not_drafted"]);
  });

  test("citing a deleted fact blocks export and keeps the snapshot", async () => {
    const profile = await confirmedProfile();
    const ws = await writeAllFiles(await pasteJob(), "Moved it [FACT-4]");
    expect<unknown>(file(ws, "resume").citations).toEqual([
      { key: "FACT-4", text: "I moved our job queue to Postgres in 2022.", deleted: false },
    ]);
    const fact = profile.facts.find((f) => f.key === "FACT-4");
    await call("DELETE", `/facts/${fact?.id}`);
    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(file(after, "resume").citations[0]?.deleted).toBe(true);
    expect<unknown>(after.gate).toEqual({
      ok: false,
      blockers: [{ kind: "deleted_fact", outputId: file(after, "resume").id, factKey: "FACT-4" }],
    });
  });

  test("editing markers keeps old snapshots, adds new ones, drops removed ones", async () => {
    const profile = await confirmedProfile();
    let ws = await writeAllFiles(await pasteJob(), "A [FACT-2]. B [FACT-3].");
    const fact2 = profile.facts.find((f) => f.key === "FACT-2");
    await call("PATCH", `/facts/${fact2?.id}`, { text: "Built a payments API in Go" });
    ws = await json(
      await call("PATCH", `/outputs/${file(ws, "resume").id}`, { body: "A [FACT-2]. C [FACT-4]." }),
      WorkspaceDto,
    );
    expect(file(ws, "resume").citations.map((c) => [String(c.key), c.text])).toEqual([
      ["FACT-2", "Built a payments API in Go serving 2M requests a day"],
      ["FACT-4", "I moved our job queue to Postgres in 2022."],
    ]);
  });
});

describe("workspace: export", () => {
  test("export returns application/pdf with the contact header from users and markers stripped", async () => {
    await confirmedProfile();
    const ws = await writeAllFiles(
      await pasteJob(),
      "# Summary\n- Built a payments API in Go [FACT-2]\n- Led a team of 4 [FACT-3][FACT-1]\n\nI like **Postgres** [FACT-4].",
    );
    const res = await call("GET", `/outputs/${file(ws, "resume").id}/export.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("Juan%20Dela%20Cruz%20-%20Acme%20Inc%20-%20Resume.pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    expect(text).toContain("Juan Dela Cruz");
    expect(text).toContain("juan@example.ph");
    expect(text).toContain("+63 917 000 0000");
    expect(text).toContain("Manila, Philippines");
    expect(text).toContain("Built a payments API in Go");
    expect(text).toContain("I like Postgres.");
    expect(text).not.toContain("FACT");
    expect(text).not.toContain("**");
  }, 30_000);

  test("Copy as text is gated like PDF and strips markers", async () => {
    await confirmedProfile();
    const ws = await writeAllFiles(await pasteJob(), "Resume [FACT-1]");
    const text = await json(await call("GET", `/outputs/${file(ws, "message").id}/text`), TextExport);
    expect(text.text).toBe("Hi, I led a team of 4.");
  });

  test("the short message does not export to PDF; unticked files do not export", async () => {
    await confirmedProfile();
    let ws = await writeAllFiles(await pasteJob(), "Resume [FACT-1]");
    const msg = await json(await call("GET", `/outputs/${file(ws, "message").id}/export.pdf`), ApiErrorBody, 400);
    expect(msg.error.code).toBe("not_exportable");
    ws = await json(await call("PATCH", `/outputs/${file(ws, "letter").id}`, { included: false }), WorkspaceDto);
    const off = await json(await call("GET", `/outputs/${file(ws, "letter").id}/export.pdf`), ApiErrorBody, 400);
    expect(off.error.code).toBe("not_exportable");
  });

  test("unknown ids return 404 with the error shape", async () => {
    const body = await json(
      await call("GET", "/opportunities/00000000-0000-4000-8000-000000000000"),
      ApiErrorBody,
      404,
    );
    expect(body.error.code).toBe("not_found");
  });
});

/** postgres.js queries are lazy (they run on `.then`), so await them before asserting. */
async function sqlError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String(error);
  }
  return "no error";
}

describe("database invariants", () => {
  test("a must-answer output can never carry generated_at", async () => {
    const ws = await pasteJob();
    const error = await sqlError(testSql()`
      INSERT INTO outputs (user_id, opportunity_id, kind, question, must_answer, generated_at)
      VALUES (${deps.userId}, ${ws.opportunity.id}, 'answer', 'Salary?', 'salary', now())`);
    expect(error).toContain("outputs_must_answer_not_generated");
  });

  test("a file row cannot carry a question, and an answer must have one", async () => {
    const ws = await pasteJob();
    const error = await sqlError(
      testSql()`INSERT INTO outputs (user_id, opportunity_id, kind) VALUES (${deps.userId}, ${ws.opportunity.id}, 'answer')`,
    );
    expect(error).toContain("outputs_question");
  });

  test("one row per file kind per opportunity", async () => {
    const ws = await pasteJob();
    const error = await sqlError(
      testSql()`INSERT INTO outputs (user_id, opportunity_id, kind) VALUES (${deps.userId}, ${ws.opportunity.id}, 'resume')`,
    );
    expect(error).toContain("outputs_one_file");
  });
});
