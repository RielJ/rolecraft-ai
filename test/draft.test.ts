import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  ApiErrorBody,
  OverCapDetails,
  ProfileDto,
  TaskDto,
  TextExport,
  WorkspaceDto,
} from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

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

const CV = [
  "- Built a payments API in Go serving 2M requests a day",
  "- Led a team of 4 engineers at Acme Corp",
  "- Moved our job queue to Postgres in 2022",
].join("\n");

const JOB = {
  title: "Senior Backend Engineer",
  company: "Stripe",
  description: "We need someone to build payment APIs. Remote, worldwide.",
};

/** Contact, CV, confirmed facts, an AI key and one pasted job. Returns its workspace. */
async function setup(): Promise<{ ws: WorkspaceDto; profile: ProfileDto }> {
  await call("PUT", "/profile", {
    contact: {
      fullName: "Juan Dela Cruz",
      email: "juan@example.ph",
      phone: "+63 917 000 0000",
      location: "Manila, Philippines",
      links: ["https://github.com/juan"],
    },
  });
  await waitForSplits(await json(await call("PUT", "/profile/cv", { text: CV }), ProfileDto));
  const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
  expect((await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
  const added = await json(await call("POST", "/jobs/from-paste", JOB), AddJobResult, 201);
  const ws = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
  return { ws, profile };
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

function factId(profile: ProfileDto, text: string) {
  const found = profile.facts.find((f) => f.text.includes(text));
  if (!found) throw new Error(`no fact like ${text}`);
  return found;
}

/** Start a draft, wait for its task, and return the task and the workspace after it. */
async function draft(ws: WorkspaceDto, body: Record<string, unknown>) {
  const task = await json(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, body), TaskDto, 202);
  await waitForTask(task.id);
  const done = await json(await call("GET", `/tasks/${task.id}`), TaskDto);
  const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
  return { task: done, ws: after };
}

describe("drafting with citations", () => {
  test("a fake resume draft stores markers and one output_facts row per cited key with a snapshot", async () => {
    const { ws } = await setup();
    const { task, ws: after } = await draft(ws, { kinds: ["resume"] });
    expect(task).toMatchObject({ status: "done", error: null });

    const resume = file(after, "resume");
    expect(resume.body).toContain("[FACT-1]");
    expect(resume.generatedAt).not.toBeNull();
    expect(resume.editedAt).toBeNull();
    expect(resume.styleHits).toEqual([]);

    const rows = await testSql()<{ fact_key: string; fact_text: string; fact_id: string | null }[]>`
      SELECT fact_key, fact_text, fact_id FROM output_facts WHERE output_id = ${resume.id} ORDER BY fact_key`;
    const keys = [...new Set(resume.body?.match(/FACT-\d+/g) ?? [])].sort();
    expect(rows.map((r) => r.fact_key)).toEqual(keys);
    expect(rows.every((r) => r.fact_id !== null && r.fact_text.length > 0)).toBe(true);
    expect(rows.find((r) => r.fact_key === "FACT-1")?.fact_text).toBe(
      "Built a payments API in Go serving 2M requests a day",
    );

    const [saved] = await testSql()<{ ai_call_id: string | null }[]>`
      SELECT ai_call_id FROM outputs WHERE id = ${resume.id}`;
    expect(saved?.ai_call_id).not.toBeNull();
  });

  test('an invented "8 years" fails checkDraft, retries once, then becomes a Check this placeholder the gate reports', async () => {
    const { ws } = await setup();
    const invented = "# Juan Dela Cruz\n## Summary\nI have 8 years of experience building payment APIs in Go [FACT-1].";
    deps.fake.queue(invented, invented);
    const { task, ws: after } = await draft(ws, { kinds: ["resume"] });
    expect(task.status).toBe("done");

    expect(deps.fake.calls).toHaveLength(2);
    expect(deps.fake.calls[1]?.messages.at(-1)?.content).toContain('"8"');

    const resume = file(after, "resume");
    expect(resume.body).toContain(
      '[[Check this: "I have 8 years of experience building payment APIs in Go." is not backed by your facts]]',
    );
    expect(resume.body).not.toContain("[FACT-1]");
    expect(after.gate.ok).toBe(false);
    if (after.gate.ok) return;
    expect(after.gate.blockers).toContainEqual({
      kind: "placeholder",
      outputId: resume.id,
      text: 'Check this: "I have 8 years of experience building payment APIs in Go." is not backed by your facts',
    });
  });

  test("a retry that fixes the claim is saved as is", async () => {
    const { ws } = await setup();
    deps.fake.queue("I have 8 years of Go [FACT-1].", "I build payment APIs in Go [FACT-1].");
    const { ws: after } = await draft(ws, { kinds: ["resume"] });
    expect(file(after, "resume").body).toBe("I build payment APIs in Go [FACT-1].");
  });

  test("the resume prompt never contains a letters_only fact; the letter prompt does", async () => {
    const { ws } = await setup();
    const sql = testSql();
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO profile_items (user_id, kind, title, body, usage)
      VALUES (${deps.userId}, 'other', 'Mentoring', 'Mentored students', 'letters_only') RETURNING id`;
    await sql`INSERT INTO facts (user_id, item_id, text, status, seen_rev)
      VALUES (${deps.userId}, ${item?.id ?? ""}, 'Mentored three students at a bootcamp', 'confirmed', 1)`;

    await draft(ws, { kinds: ["resume"] });
    const resumePrompt = deps.fake.calls[0]?.messages[0]?.content ?? "";
    expect(resumePrompt).toContain("FACT-1");
    expect(resumePrompt).not.toContain("Mentored three students");

    deps.fake.reset();
    await draft(ws, { kinds: ["letter"] });
    expect(deps.fake.calls[0]?.messages[0]?.content).toContain("Mentored three students");
  });

  test("a skill added for matching never reaches a draft prompt (decision 66)", async () => {
    const { ws, profile } = await setup();
    // Added with no fact behind it, and a skill found in facts hidden from matching.
    for (const [name, state] of [
      ["Kubernetes", "added"],
      ["Hasura", "added"],
      ["Go", "hidden"],
    ] as const) {
      expect((await call("PUT", "/profile/skills", { name, state })).status).toBe(200);
    }
    await draft(ws, { kinds: ["resume", "letter"] });
    const prompts = deps.fake.calls.flatMap((c) => c.messages.map((m) => m.content)).join("\n");
    expect(prompts).toContain(factId(profile, "payments API").text);
    expect(prompts).not.toContain("Kubernetes");
    expect(prompts).not.toContain("Hasura");
  });

  test("drafting and citation modules never read the skill list for matching (decision 66)", async () => {
    const root = join(import.meta.dir, "..");
    const modules = [
      "src/server/services/workspace.ts",
      "src/domain/citations.ts",
      "src/domain/prompts.ts",
      "src/domain/gate.ts",
      "src/domain/style.ts",
    ];
    const banned = /userSkills|user_skills|skillChips|profileSkills|loadSkillDictionary/;
    const hits: string[] = [];
    for (const path of modules) {
      const source = await Bun.file(join(root, path)).text();
      if (banned.test(source)) hits.push(`${path}: ${source.match(banned)?.[0]}`);
    }
    expect(hits).toEqual([]);
  });

  test("a resume citing a fact that became letters_only shows as outdated", async () => {
    const { ws, profile } = await setup();
    await draft(ws, { kinds: ["resume"] });
    const fact = factId(profile, "payments API");
    await testSql()`UPDATE profile_items SET usage = 'letters_only', kind = 'other'
      WHERE id = (SELECT item_id FROM facts WHERE id = ${fact.id})`;
    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(file(after, "resume").outdated.map((o) => o.reason)).toContain("letters_only");
  });
});

describe("style pass", () => {
  const TELL = "I am passionate about leveraging Go — I built a payments API [FACT-1].";

  async function onlyResume(ws: WorkspaceDto) {
    await call("PATCH", `/outputs/${file(ws, "letter").id}`, { included: false });
    await call("PATCH", `/outputs/${file(ws, "message").id}`, { included: false });
  }

  test("tells trigger one rewrite; a leftover tell is saved as a style hit and export still succeeds", async () => {
    const { ws } = await setup();
    await onlyResume(ws);
    deps.fake.queue(TELL, JSON.stringify({ rewrites: ["I leverage Go to build payment APIs [FACT-1]."] }));
    const { ws: after } = await draft(ws, { kinds: ["resume"] });

    expect(deps.fake.calls).toHaveLength(2);
    const rewritePrompt = deps.fake.calls[1]?.messages.at(-1)?.content ?? "";
    expect(rewritePrompt).toContain(`1. ${TELL}`);
    expect(rewritePrompt).toContain('"passionate about"');
    expect(rewritePrompt).toContain("Dash used as punctuation");

    const resume = file(after, "resume");
    expect(resume.body).toBe("I leverage Go to build payment APIs [FACT-1].");
    expect(resume.styleHits).toEqual([
      { sentence: "I leverage Go to build payment APIs [FACT-1].", phrase: "leverage", rule: "banned_phrase" },
    ]);
    expect(after.gate).toEqual({ ok: true });

    const text = await json(await call("GET", `/outputs/${resume.id}/text`), TextExport);
    expect(text.text).toBe("I leverage Go to build payment APIs.");
  });

  test("a rewrite that adds an unbacked number is discarded and the original sentence kept", async () => {
    const { ws } = await setup();
    deps.fake.queue(TELL, JSON.stringify({ rewrites: ["I built 5 payment APIs in Go [FACT-1]."] }));
    const { ws: after } = await draft(ws, { kinds: ["resume"] });
    const resume = file(after, "resume");
    expect(resume.body).toBe(TELL);
    expect(resume.styleHits.map((h) => h.phrase)).toEqual(["—", "passionate about", "leveraging"]);
  });

  test("an unreadable rewrite reply keeps the draft", async () => {
    const { ws } = await setup();
    deps.fake.queue(TELL, "Sure! Here you go.");
    const { task, ws: after } = await draft(ws, { kinds: ["resume"] });
    expect(task.status).toBe("done");
    expect(file(after, "resume").body).toBe(TELL);
  });

  test("user edits re-run the style check without AI", async () => {
    const { ws } = await setup();
    const res = await call("PATCH", `/outputs/${file(ws, "letter").id}`, { body: "I am thrilled to apply." });
    const after = await json(res, WorkspaceDto);
    expect(file(after, "letter").styleHits).toEqual([
      { sentence: "I am thrilled to apply.", phrase: "thrilled", rule: "banned_phrase" },
    ]);
    expect(deps.fake.calls).toHaveLength(0);
    const cleared = await json(
      await call("PATCH", `/outputs/${file(ws, "letter").id}`, { body: "I want to apply." }),
      WorkspaceDto,
    );
    expect(file(cleared, "letter").styleHits).toEqual([]);
  });
});

describe("refusals", () => {
  test("drafting a must-answer output returns 409 must_answer; the CHECK rejects ai_call_id on it", async () => {
    const { ws } = await setup();
    const withQ = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/questions`, {
        question: "What is your salary expectation?",
      }),
      WorkspaceDto,
      201,
    );
    const salary = withQ.answers[0];
    if (!salary) throw new Error("no answer row");
    expect(salary.mustAnswer).toBe("salary");

    const res = await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { outputId: salary.id });
    const body = await json(res, ApiErrorBody, 409);
    expect(body.error.code).toBe("must_answer");
    const kinds = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { kinds: ["answer"] }),
      ApiErrorBody,
      409,
    );
    expect(kinds.error.code).toBe("must_answer");
    expect(deps.fake.calls).toHaveLength(0);

    const sql = testSql();
    const [aiCall] = await sql<{ id: string }[]>`
      INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens)
      VALUES (${deps.userId}, 'writing', 'draft', 'anthropic', 'claude-sonnet-5-5', 1, 1) RETURNING id`;
    // postgres.js queries run lazily on `then`, so wrap the query in an async function.
    const update = async () => {
      await sql`UPDATE outputs SET ai_call_id = ${aiCall?.id ?? ""} WHERE id = ${salary.id}`;
    };
    await expect(update()).rejects.toThrow(/outputs_must_answer_not_generated/);
  });

  test("a frozen job refuses drafting with 409 frozen", async () => {
    const { ws } = await setup();
    await testSql()`UPDATE opportunities SET status = 'applied' WHERE id = ${ws.opportunity.id}`;
    const body = await json(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, {}), ApiErrorBody, 409);
    expect(body.error.code).toBe("frozen");
  });

  test("without a key, drafting says to add one in Settings", async () => {
    const { ws } = await setup();
    await call("DELETE", "/settings/ai-key");
    const body = await json(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, {}), ApiErrorBody, 409);
    expect(body.error.code).toBe("no_ai_key");
    expect(body.error.message).toContain("Settings");
  });

  test("a rejected key fails the task with a message that names the way out", async () => {
    const { ws } = await setup();
    await deps.keyStore.write(deps.userId, "sk-bad-key");
    const { task } = await draft(ws, { kinds: ["resume"] });
    expect(task.status).toBe("failed");
    expect(task.error).toBe("Anthropic rejected the saved key. Paste a new key in Settings.");
  });
});

describe("outdated", () => {
  test("editing a cited fact lists old and new text; Mark up to date clears it", async () => {
    const { ws, profile } = await setup();
    await draft(ws, { kinds: ["resume"] });
    const fact = factId(profile, "payments API");
    await call("PATCH", `/facts/${fact.id}`, { text: "Built a payments API in Go serving 3M requests a day" });

    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(file(after, "resume").outdated).toEqual([
      {
        factKey: fact.key,
        reason: "edited",
        oldText: "Built a payments API in Go serving 2M requests a day",
        newText: "Built a payments API in Go serving 3M requests a day",
      },
    ]);
    expect(file(after, "letter").outdated).toEqual([]);

    const current = await json(await call("POST", `/outputs/${file(after, "resume").id}/mark-current`), WorkspaceDto);
    expect(file(current, "resume").outdated).toEqual([]);
    expect(file(current, "resume").citations.find((c) => c.key === fact.key)?.text).toBe(
      "Built a payments API in Go serving 3M requests a day",
    );
  });

  test("deleting a cited fact shows it as deleted and adds a deleted_fact blocker", async () => {
    const { ws, profile } = await setup();
    await draft(ws, {});
    const fact = factId(profile, "payments API");
    await call("DELETE", `/facts/${fact.id}`);

    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    const resume = file(after, "resume");
    expect(resume.outdated).toEqual([
      {
        factKey: fact.key,
        reason: "deleted",
        oldText: "Built a payments API in Go serving 2M requests a day",
        newText: null,
      },
    ]);
    expect(after.gate.ok).toBe(false);
    if (after.gate.ok) return;
    expect(after.gate.blockers).toContainEqual({ kind: "deleted_fact", outputId: resume.id, factKey: fact.key });

    // Mark up to date cannot bring a deleted fact back; the marker still has to go.
    const current = await json(await call("POST", `/outputs/${resume.id}/mark-current`), WorkspaceDto);
    expect(file(current, "resume").outdated.map((o) => o.reason)).toEqual(["deleted"]);
  });

  test("a frozen job shows no outdated notices and refuses Mark up to date", async () => {
    const { ws, profile } = await setup();
    await draft(ws, { kinds: ["resume"] });
    await call("PATCH", `/facts/${factId(profile, "payments API").id}`, { text: "Changed text for a fact" });
    await testSql()`UPDATE opportunities SET status = 'applied' WHERE id = ${ws.opportunity.id}`;
    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(file(after, "resume").outdated).toEqual([]);
    const res = await call("POST", `/outputs/${file(after, "resume").id}/mark-current`);
    expect((await json(res, ApiErrorBody, 409)).error.code).toBe("frozen");
  });
});

describe("spend and the cap", () => {
  test("each AI call writes an ai_calls row with tokens and cost", async () => {
    const { ws } = await setup();
    await draft(ws, {});
    const rows = await testSql()<
      {
        tier: string;
        purpose: string;
        provider: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: string | null;
        task_id: string | null;
      }[]
    >`SELECT tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, task_id FROM ai_calls`;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        tier: "writing",
        purpose: "draft",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      });
      expect(row.input_tokens).toBeGreaterThan(0);
      expect(row.output_tokens).toBeGreaterThan(0);
      expect(row.task_id).not.toBeNull();
      // claude-sonnet-5-5: $2 in, $10 out per million tokens.
      expect(Number(row.cost_usd)).toBeCloseTo((row.input_tokens * 2 + row.output_tokens * 10) / 1e6, 6);
    }
  });

  test("an unpriced model records cost_usd NULL", async () => {
    const { ws } = await setup();
    await call("PATCH", "/settings", { modelWriting: "claude-experimental-x" });
    await draft(ws, { kinds: ["resume"] });
    const rows = await testSql()<{ model: string; cost_usd: string | null }[]>`SELECT model, cost_usd FROM ai_calls`;
    expect([...rows]).toEqual([{ model: "claude-experimental-x", cost_usd: null }]);
  });

  test("with a cap below the estimate, drafting returns 402 over_cap until confirmOverCap", async () => {
    const { ws } = await setup();
    await call("PATCH", "/settings", { monthlyCapUsd: 0.01 });

    const res = await call("POST", `/opportunities/${ws.opportunity.id}/draft`, {});
    const body = await json(res, ApiErrorBody, 402);
    expect(body.error.code).toBe("over_cap");
    const details = OverCapDetails.parse(body.error.details);
    expect(details.capUsd).toBe(0.01);
    expect(details.monthUsd).toBe(0);
    expect(details.estimateUsd).toBeGreaterThan(0.01);
    expect(deps.fake.calls).toHaveLength(0);

    const { task } = await draft(ws, { confirmOverCap: true });
    expect(task.status).toBe("done");
    expect(deps.fake.calls).toHaveLength(3);
  });

  test("spend counts only this month in Asia/Manila", async () => {
    await setup();
    const sql = testSql();
    // 2026-09-30T16:30Z is already October 1 in Manila; 2026-09-30T15:00Z is still September.
    await sql`INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (${deps.userId}, 'writing', 'draft', 'anthropic', 'm', 1, 1, 1.5, '2026-09-30T16:30:00Z'),
             (${deps.userId}, 'writing', 'draft', 'anthropic', 'm', 1, 1, 2.0, '2026-09-30T15:00:00Z'),
             (${deps.userId}, 'writing', 'draft', 'anthropic', 'm', 1, 1, NULL, '2026-10-10T00:00:00Z')`;
    const res = await call("GET", "/settings");
    const settings: { spend: { monthUsd: number; calls: number; unpricedCalls: number } } = await res.json();
    expect(settings.spend).toEqual({ monthUsd: 1.5, calls: 2, unpricedCalls: 1 });
  });
});
