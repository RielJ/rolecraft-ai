import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { acceptAiVerdict, classifyEligibility } from "@/domain/eligibility";
import { createFakeAi, type FakeAi } from "@/server/adapters/ai/fake";
import { DEFAULT_MODELS, EVAL_PASSED_LIGHT, PRICES } from "@/server/adapters/ai/pricing";
import { type AiCompletionRequest, AiError, type AiProviderClient } from "@/server/adapters/ai/types";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createApp } from "@/server/http/app";
import { parseEligibilityReply, parseQuestionsReply } from "@/server/services/ai-replies";
import type { Deps } from "@/server/services/context";
import { AI_PASS_LIMIT } from "@/server/services/sync";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ApiErrorBody, RefreshDto, SettingsDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { type DraftingCase, type EligibilityCase, exitCode, loadSets, main, piProviderFor, runEval } from "../eval/run";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Slice 10 (PLAN.md section 5): suggested questions, the AI eligibility pass during Refresh, and
 * the evaluation set's scorer. Every AI call goes to a fake; nothing reaches the network.
 */

const KEY = "sk-ant-good-key-a1B2";
const NOW = new Date("2026-10-16T08:00:00Z");

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

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

async function errorCode(res: Response): Promise<{ status: number; code: string }> {
  const body = ApiErrorBody.parse(await res.json());
  return { status: res.status, code: body.error.code };
}

const saveKey = async () =>
  json(await call("PUT", "/settings/ai-key", { provider: "anthropic", key: KEY }), SettingsDto);

/** A request is an eligibility question when it asks for the verdict JSON. */
const isEligibility = (r: AiCompletionRequest) => (r.messages.at(-1)?.content ?? "").includes('{"verdict"');
/** The posting's description as the prompt shows it, between <<< and >>>. */
const promptDescription = (r: AiCompletionRequest) =>
  /^<<<\n([\s\S]*?)\n>>>$/m.exec(r.messages[0]?.content ?? "")?.[1] ?? "";

// ---------- Suggest questions ----------

describe("suggest questions", () => {
  const JOB = {
    title: "Senior Backend Engineer",
    company: "Stripe",
    description:
      "We build payment APIs. In your application, tell us why you want to join and your salary expectations.",
  };
  const REPLY = JSON.stringify({
    questions: [
      "Why do you want to work here?",
      "What are your salary expectations?",
      "Do you need visa sponsorship?",
      "Describe a payments system you built.",
      "  describe a payments   system you built. ",
    ],
  });

  beforeEach(async () => {
    await resetDb();
    deps = await testDeps({ clock: { now: () => NOW } });
    app = createApp(deps);
  });

  async function pasteJob(): Promise<WorkspaceDto> {
    const added = await json(await call("POST", "/jobs/from-paste", JOB), AddJobResult, 201);
    return json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
  }

  async function suggest(ws: WorkspaceDto, body: Record<string, unknown> = {}) {
    const task = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/suggest-questions`, body),
      TaskDto,
      202,
    );
    await waitForTask(task.id);
    return { task, ws: await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto) };
  }

  const byQuestion = (ws: WorkspaceDto, q: string) => {
    const found = ws.answers.find((a) => a.question === q);
    if (!found) throw new Error(`no answer "${q}"`);
    return found;
  };

  test("suggested questions arrive with included = false, classified, without duplicates, from one light call", async () => {
    await saveKey();
    const ws = await pasteJob();
    await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/questions`, {
        question: "Why do you want to work here?",
      }),
      WorkspaceDto,
      201,
    );
    deps.fake.queue(REPLY);
    const { task, ws: after } = await suggest(ws);
    expect(task.kind).toBe("suggest_questions");

    expect(after.answers.map((a) => ({ q: a.question, included: a.included, mustAnswer: a.mustAnswer }))).toEqual([
      { q: "Why do you want to work here?", included: true, mustAnswer: null },
      { q: "What are your salary expectations?", included: false, mustAnswer: "salary" },
      { q: "Do you need visa sponsorship?", included: false, mustAnswer: "work_auth" },
      { q: "Describe a payments system you built.", included: false, mustAnswer: null },
    ]);
    expect(after.suggestTask).toMatchObject({ id: task.id, status: "done", result: { found: 4, added: 3 } });
    // Unticked suggestions are not part of the application, so they do not block it.
    expect(after.gate.ok ? [] : after.gate.blockers.map((b) => b.outputId)).not.toContain(
      byQuestion(after, "What are your salary expectations?").id,
    );

    const request = deps.fake.calls[0];
    expect(deps.fake.calls).toHaveLength(1);
    expect(request?.tier).toBe("light");
    expect(request?.messages[0]?.content).toContain(JOB.description);
    const calls = await testSql()<{ purpose: string; tier: string; model: string; task_id: string }[]>`
      SELECT purpose, tier, model, task_id FROM ai_calls`;
    expect([...calls]).toEqual([{ purpose: "questions", tier: "light", model: "claude-haiku-5-5", task_id: task.id }]);

    // A second run adds nothing it already has.
    deps.fake.queue(REPLY);
    const again = await suggest(after);
    expect(again.ws.answers).toHaveLength(4);
    expect(again.ws.suggestTask?.result).toEqual({ found: 4, added: 0 });
  });

  test("must-answer suggestions are never drafted, even after they are ticked", async () => {
    await saveKey();
    const ws = await pasteJob();
    deps.fake.queue(REPLY);
    const { ws: after } = await suggest(ws);
    const salary = byQuestion(after, "What are your salary expectations?");
    const visa = byQuestion(after, "Do you need visa sponsorship?");
    const open = byQuestion(after, "Describe a payments system you built.");
    for (const id of [salary.id, visa.id, open.id]) {
      await json(await call("PATCH", `/outputs/${id}`, { included: true }), WorkspaceDto);
    }

    for (const id of [salary.id, visa.id]) {
      expect(
        await errorCode(await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { outputId: id })),
      ).toEqual({ status: 409, code: "must_answer" });
    }
    // Drafting the open question works, and no draft prompt ever carries a must-answer question.
    deps.fake.reset();
    const task = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { outputId: open.id }),
      TaskDto,
      202,
    );
    await waitForTask(task.id);
    const drafted = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(byQuestion(drafted, open.question ?? "").body).not.toBeNull();
    expect(byQuestion(drafted, salary.question ?? "")).toMatchObject({ body: null, generatedAt: null });
    expect(byQuestion(drafted, visa.question ?? "")).toMatchObject({ body: null, generatedAt: null });
    const prompts = deps.fake.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
    expect(prompts).toContain("Describe a payments system you built.");
    expect(prompts).not.toContain("salary expectations?");
    expect(prompts).not.toContain("visa sponsorship?");
  });

  test("the fake's default reply finds the posting's own questions", async () => {
    await saveKey();
    const added = await json(
      await call("POST", "/jobs/from-paste", {
        ...JOB,
        description: "We build payment APIs. What is your expected salary? Why payments? Send your CV.",
      }),
      AddJobResult,
      201,
    );
    const ws = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    const { ws: after } = await suggest(ws);
    expect(after.answers.map((a) => [a.question, a.mustAnswer])).toEqual([
      ["What is your expected salary?", "salary"],
      ["Why payments?", null],
    ]);
  });

  test("an unreadable reply fails the task with a way out, and Retry runs it again", async () => {
    await saveKey();
    const ws = await pasteJob();
    deps.fake.queue("Sure! Here are some questions you might get asked.");
    const { task, ws: failed } = await suggest(ws);
    expect(failed.suggestTask).toMatchObject({ id: task.id, status: "failed", result: null });
    expect(failed.suggestTask?.error).toContain("Retry, or add questions by hand");
    expect(failed.answers).toEqual([]);

    deps.fake.queue(REPLY);
    const retried = await json(await call("POST", `/tasks/${task.id}/retry`, {}), TaskDto, 202);
    expect(retried.kind).toBe("suggest_questions");
    await waitForTask(retried.id);
    const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
    expect(after.suggestTask).toMatchObject({ id: retried.id, status: "done" });
    expect(after.answers).toHaveLength(4);
  });

  test("refused without AI, on an applied job, and over the cap until confirmed", async () => {
    const ws = await pasteJob();
    const path = `/opportunities/${ws.opportunity.id}/suggest-questions`;
    expect(await errorCode(await call("POST", path, {}))).toEqual({ status: 409, code: "no_ai_key" });

    await saveKey();
    await json(await call("PATCH", "/settings", { monthlyCapUsd: 0.01 }), SettingsDto);
    await testSql()`
      INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (${deps.userId}, 'light', 'split', 'anthropic', 'claude-haiku-5-5', 1, 1, 0.01, ${NOW})`;
    expect(await errorCode(await call("POST", path, {}))).toEqual({ status: 402, code: "over_cap" });
    expect(deps.fake.calls).toHaveLength(0);
    deps.fake.queue(REPLY);
    const confirmed = await json(await call("POST", path, { confirmOverCap: true }), TaskDto, 202);
    await waitForTask(confirmed.id);
    expect((await json(await call("GET", `/tasks/${confirmed.id}`), TaskDto)).status).toBe("done");

    await testSql()`UPDATE opportunities SET status = 'applied' WHERE id = ${ws.opportunity.id}`;
    expect(await errorCode(await call("POST", path, {}))).toEqual({ status: 409, code: "frozen" });
  });

  test("parseQuestionsReply trims, dedupes, caps at 15 and refuses non-JSON", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Question ${i}?`);
    expect(parseQuestionsReply(JSON.stringify({ questions: many }))).toHaveLength(15);
    expect(parseQuestionsReply('```json\n{"questions": [" A? ", "a?", ""]}\n```')).toEqual(["A?"]);
    expect(parseQuestionsReply("no")).toBeNull();
    expect(parseQuestionsReply('{"items": []}')).toBeNull();
  });
});

// ---------- AI eligibility pass ----------

describe("AI eligibility pass during Refresh", () => {
  const GH_BOARD = "boards-api.greenhouse.io/v1/boards/elig";
  const GH_JOBS = "boards-api.greenhouse.io/v1/boards/elig/jobs";
  let postings: { id: number; title: string; text: string }[];
  /** How the test's AI answers an eligibility question, from the description it was shown. */
  let answer: (description: string) => string | AiError;
  let tokens: { input: number; output: number };

  const fakeFetch: FetchFn = async (url) => {
    const { host, pathname } = new URL(url);
    const route = `${host}${pathname}`;
    const body =
      route === GH_BOARD
        ? { name: "Elig Co" }
        : route === GH_JOBS
          ? {
              jobs: postings.map((p) => ({
                id: p.id,
                title: p.title,
                absolute_url: `https://boards.greenhouse.io/elig/jobs/${p.id}`,
                location: { name: "Distributed" },
                updated_at: "2026-10-15T10:00:00-04:00",
                first_published: "2026-10-15T09:00:00-04:00",
                content: `&lt;p&gt;${p.text}&lt;/p&gt;`,
                departments: [],
                offices: [],
              })),
            }
          : null;
    return body
      ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  };

  /** Eligibility questions get `answer`; anything else (CV splits) goes to the fake. */
  function testAi(fallback: FakeAi): AiProviderClient & { asked: AiCompletionRequest[] } {
    const asked: AiCompletionRequest[] = [];
    return {
      asked,
      checkKey: (args) => fallback.checkKey(args),
      complete: async (request) => {
        if (!isEligibility(request)) return fallback.complete(request);
        asked.push(request);
        const reply = answer(promptDescription(request));
        if (reply instanceof AiError) throw reply;
        return { text: reply, inputTokens: tokens.input, outputTokens: tokens.output, model: request.model };
      },
    };
  }

  let ai: ReturnType<typeof testAi>;
  /** Each refresh moves the clock a day on, past every source's minimum interval. */
  let now: Date;

  async function setUp(over: Partial<Pick<Deps, "aiSource">> = {}) {
    await resetDb();
    now = NOW;
    const base = await testDeps({
      http: createHttpClient({ fetch: fakeFetch, sleep: async () => {} }),
      clock: { now: () => now },
      ...over,
    });
    ai = testAi(base.fake);
    deps = { ...base, ai: { anthropic: ai, openai: ai } };
    app = createApp(deps);
    await json(await call("POST", "/sources", { url: "https://boards.greenhouse.io/elig" }), z.unknown(), 201);
  }

  beforeEach(async () => {
    postings = [];
    answer = () => JSON.stringify({ verdict: "unclear", phrase: null });
    tokens = { input: 400, output: 20 };
    await setUp();
  });

  async function refresh(): Promise<{ task: TaskDto; result: NonNullable<RefreshDto["result"]> }> {
    now = new Date(now.getTime() + 24 * 3600_000);
    const started = await json(await call("POST", "/refresh"), TaskDto, 202);
    await waitForTask(started.id);
    const latest = await json(await call("GET", "/refresh"), RefreshDto);
    if (!latest.task || !latest.result) throw new Error("no refresh result");
    return { task: latest.task, result: latest.result };
  }

  async function jobRow(title: string) {
    const [row] = await testSql()<{ eligibility: string; phrase: string | null; by: string }[]>`
      SELECT eligibility, eligibility_phrase AS phrase, eligibility_by AS by FROM jobs WHERE title = ${title}`;
    return row;
  }

  const unclearJobs = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      id: 9000 + from + i,
      title: `Engineer ${from + i}`,
      text: `Role ${from + i}. We hire people wherever they live and work async.`,
    }));

  const enable = async () => {
    await saveKey();
    await json(await call("PATCH", "/settings", { eligibilityOnRefresh: true }), SettingsDto);
  };

  test("a verdict is kept only with a phrase found verbatim in the description", async () => {
    await enable();
    postings = [
      { id: 1, title: "Verbatim", text: "Payroll tools. We hire people wherever they live." },
      { id: 2, title: "Paraphrase", text: "Billing tools. This role is open to candidates in one of the 50 states." },
      { id: 3, title: "Says unclear", text: "Search tools. The team meets online." },
      { id: 4, title: "Not JSON", text: "Chat tools. We are a small team." },
      { id: 5, title: "Too short", text: "Map tools. Hiring in US and EU time." },
      { id: 6, title: "Rule decided", text: "Remote, worldwide." },
    ];
    answer = (description) => {
      if (description.includes("Payroll"))
        return JSON.stringify({ verdict: "worldwide", phrase: "We hire people wherever they live." });
      if (description.includes("Billing"))
        return JSON.stringify({ verdict: "excluded", phrase: "Open to United States residents only." });
      if (description.includes("Chat")) return "I think it is worldwide.";
      if (description.includes("Map")) return JSON.stringify({ verdict: "excluded", phrase: "US" });
      return JSON.stringify({ verdict: "unclear", phrase: null });
    };
    const { task, result } = await refresh();
    expect(task.status).toBe("done");
    expect(result.aiPass).toEqual({ kind: "ran", checked: 5, decided: 1, unbacked: 4, left: 0, stopped: null });

    expect(await jobRow("Verbatim")).toEqual({
      eligibility: "worldwide",
      phrase: "We hire people wherever they live.",
      by: "ai",
    });
    for (const title of ["Paraphrase", "Says unclear", "Not JSON", "Too short"]) {
      expect({ title, ...(await jobRow(title)) }).toEqual({ title, eligibility: "unclear", phrase: null, by: "rule" });
    }
    // The rules decided this one, so the model never saw it.
    expect(await jobRow("Rule decided")).toMatchObject({ eligibility: "worldwide", by: "rule" });
    expect(ai.asked.map(promptDescription).some((d) => d.includes("Remote, worldwide."))).toBe(false);
    expect(ai.asked.every((r) => r.tier === "light" && r.model === "claude-haiku-5-5")).toBe(true);

    const calls = await testSql()<{ purpose: string; tier: string; task_id: string }[]>`
      SELECT purpose, tier, task_id FROM ai_calls`;
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.purpose === "eligibility" && c.tier === "light" && c.task_id === task.id)).toBe(true);
  });

  test("only jobs first seen in this refresh go to the model", async () => {
    postings = unclearJobs(2);
    expect((await refresh()).result.aiPass).toEqual({ kind: "not_run", reason: "off" });
    await enable();
    // Same postings again: nothing is new, so nothing is asked.
    expect((await refresh()).result.aiPass).toEqual({
      kind: "ran",
      checked: 0,
      decided: 0,
      unbacked: 0,
      left: 0,
      stopped: null,
    });
    postings = [...postings, ...unclearJobs(1, 3)];
    expect((await refresh()).result.aiPass).toMatchObject({ kind: "ran", checked: 1 });
    expect(ai.asked.map(promptDescription)).toEqual([expect.stringContaining("Role 3.")]);
  });

  test(`at most ${AI_PASS_LIMIT} jobs per refresh`, async () => {
    expect(AI_PASS_LIMIT).toBe(25);
    await enable();
    postings = unclearJobs(30);
    const { result } = await refresh();
    expect(result.aiPass).toMatchObject({ kind: "ran", checked: 25, left: 5, stopped: null });
    expect(ai.asked).toHaveLength(25);
    const [count] = await testSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_calls`;
    expect(count?.n).toBe(25);
  });

  test("skips itself when the batch would cross the monthly cap, without asking", async () => {
    await enable();
    await json(await call("PATCH", "/settings", { monthlyCapUsd: 0.01 }), SettingsDto);
    await testSql()`
      INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (${deps.userId}, 'light', 'split', 'anthropic', 'claude-haiku-5-5', 1, 1, 0.00999, ${NOW})`;
    postings = unclearJobs(3);
    const { task, result } = await refresh();
    expect(task).toMatchObject({ status: "done", error: null });
    expect(result.aiPass).toMatchObject({ kind: "skipped", reason: "over_cap", jobs: 3, capUsd: 0.01 });
    expect(ai.asked).toHaveLength(0);
    expect(result.sources.find((s) => s.label.includes("Elig"))).toMatchObject({ status: "ok", added: 3 });
    expect(await jobRow("Engineer 1")).toMatchObject({ eligibility: "unclear" });
  });

  test("stops when real costs cross the cap midway, keeping what it decided", async () => {
    await enable();
    await json(await call("PATCH", "/settings", { monthlyCapUsd: 0.5 }), SettingsDto);
    // Each call reports 10M input tokens: $1 at Haiku's price, far over the estimate.
    tokens = { input: 10_000_000, output: 10 };
    answer = (d) => JSON.stringify({ verdict: "worldwide", phrase: d.slice(d.indexOf("We hire")) });
    postings = unclearJobs(3);
    const { task, result } = await refresh();
    expect(task.status).toBe("done");
    expect(result.aiPass).toMatchObject({ kind: "ran", checked: 1, decided: 1, left: 2 });
    if (result.aiPass.kind !== "ran") throw new Error("not ran");
    expect(result.aiPass.stopped?.reason).toBe("over_cap");
    expect(ai.asked).toHaveLength(1);
  });

  test("a provider failure stops the pass, not the refresh", async () => {
    await enable();
    answer = () => new AiError({ kind: "unavailable", message: "503" });
    postings = unclearJobs(2);
    const { task, result } = await refresh();
    expect(task).toMatchObject({ status: "done", error: null });
    expect(result.aiPass).toMatchObject({ kind: "ran", checked: 0, left: 2, stopped: { reason: "ai_failed" } });
    expect(result.sources.find((s) => s.label.includes("Elig"))).toMatchObject({ status: "ok", added: 2 });
  });

  test("not run when the setting is on but no AI is set up", async () => {
    await json(await call("PATCH", "/settings", { eligibilityOnRefresh: true }), SettingsDto);
    postings = unclearJobs(1);
    expect((await refresh()).result.aiPass).toEqual({ kind: "not_run", reason: "no_ai" });
    expect(ai.asked).toHaveLength(0);
  });

  test("in pi mode it runs without a key, on pi's light model", async () => {
    await setUp({ aiSource: { kind: "pi", models: { light: "pi-light", writing: "pi-writing" } } });
    await json(await call("PATCH", "/settings", { eligibilityOnRefresh: true }), SettingsDto);
    postings = unclearJobs(1);
    expect((await refresh()).result.aiPass).toMatchObject({ kind: "ran", checked: 1 });
    expect(ai.asked.map((r) => r.model)).toEqual(["pi-light"]);
    const calls = await testSql()<{ model: string }[]>`SELECT model FROM ai_calls`;
    expect(calls.map((c) => c.model)).toEqual(["pi-light"]);
  });

  test("acceptAiVerdict and parseEligibilityReply", () => {
    const description = "Acme builds payroll. We hire people wherever they live.\nRemote.";
    const accept = (verdict: string, phrase: string | null) => {
      const answer = parseEligibilityReply(JSON.stringify({ verdict, phrase }));
      return answer && acceptAiVerdict({ answer, description });
    };
    expect(accept("worldwide", "We hire people wherever they live.")).toEqual({
      verdict: "worldwide",
      phrase: "We hire people wherever they live.",
    });
    expect(accept("worldwide", "  wherever they live  ")).toEqual({
      verdict: "worldwide",
      phrase: "wherever they live",
    });
    expect(accept("worldwide", "We hire people anywhere.")).toBeNull();
    expect(accept("worldwide", "we hire people wherever they live.")).toBeNull();
    expect(accept("excluded", "Rem")).toBeNull();
    expect(accept("excluded", "....")).toBeNull();
    expect(accept("unclear", "Remote.")).toBeNull();
    expect(accept("excluded", null)).toBeNull();
    expect(parseEligibilityReply('```json\n{"verdict":"apac","phrase":"Asia"}\n```')).toEqual({
      verdict: "apac",
      phrase: "Asia",
    });
    expect(parseEligibilityReply('{"verdict":"maybe","phrase":null}')).toBeNull();
  });
});

// ---------- The evaluation set ----------

describe("eval set and scorer", () => {
  const EXCLUDED: EligibilityCase = {
    id: "fifty-states",
    title: "Backend Engineer",
    company: "Ledgerline",
    locationText: "Remote",
    description: "Billing software. This role is open to candidates residing in one of the 50 states.",
    expected: "excluded",
    why: "US only",
  };
  const DRAFT: DraftingCase = {
    id: "k8s",
    kind: "message",
    opportunityType: "job",
    posting: { title: "Platform Engineer", company: "Harbor", description: "7+ years of Kubernetes on AWS." },
    question: null,
    facts: [{ text: "Built a payments API in Go", usage: "everywhere", link: null }],
    tempts: "Kubernetes and years",
    candidate: { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Cebu", links: [] },
  };

  /** A fake model: eligibility questions get `verdict`, drafts get `draft`. */
  function fakeModel({ verdict, draft }: { verdict: string; draft: string }): FakeAi {
    const fake = createFakeAi();
    fake.queue(...Array.from({ length: 10 }, () => (r: AiCompletionRequest) => (isEligibility(r) ? verdict : draft)));
    return fake;
  }
  const sets = { eligibility: [EXCLUDED], drafting: [DRAFT] };
  const run = (client: AiProviderClient) =>
    runEval({ client, model: "claude-haiku-5-5", tier: "light", via: "fake", sets });
  const goodVerdict = JSON.stringify({
    verdict: "excluded",
    phrase: "open to candidates residing in one of the 50 states",
  });
  const goodDraft = "I built a payments API in Go [FACT-1].";

  test("a clean run exits 0", async () => {
    const report = await run(fakeModel({ verdict: goodVerdict, draft: goodDraft }));
    expect(report).toMatchObject({ missedExclusions: 0, inventedClaims: 0, errors: 0 });
    expect(report.eligibility[0]).toMatchObject({ rule: "unclear", final: "excluded", by: "ai" });
    expect(exitCode(report)).toBe(0);
  });

  test("one missed exclusion exits non-zero", async () => {
    const verdict = JSON.stringify({ verdict: "worldwide", phrase: "Billing software." });
    const report = await run(fakeModel({ verdict, draft: goodDraft }));
    expect(report).toMatchObject({ missedExclusions: 1, inventedClaims: 0, errors: 0 });
    expect(report.eligibility[0]).toMatchObject({ final: "worldwide", missedExclusion: true });
    expect(exitCode(report)).toBe(1);
  });

  test("an exclusion the model cannot back with a verbatim phrase is still missed", async () => {
    const verdict = JSON.stringify({ verdict: "excluded", phrase: "US residents only." });
    const report = await run(fakeModel({ verdict, draft: goodDraft }));
    expect(report.eligibility[0]).toMatchObject({ final: "unclear", by: "none", missedExclusion: true });
    expect(exitCode(report)).toBe(1);
  });

  test("one invented claim exits non-zero, after the app's one retry", async () => {
    const fake = fakeModel({ verdict: goodVerdict, draft: "I ran Kubernetes on AWS for 7 years [FACT-1]." });
    const report = await run(fake);
    expect(report.missedExclusions).toBe(0);
    expect(report.inventedClaims).toBe(1);
    expect(report.drafting[0]?.invented[0]).toMatchObject({
      kind: "unsupported_token",
      tokens: expect.arrayContaining(["Kubernetes", "AWS", "7"]),
    });
    // Eligibility once, the draft, and its retry.
    expect(fake.calls).toHaveLength(3);
    expect(exitCode(report)).toBe(1);
  });

  test("a draft fixed on the retry passes", async () => {
    const fake = createFakeAi();
    fake.queue(goodVerdict, "I ran Kubernetes for 7 years [FACT-1].", goodDraft);
    const report = await run(fake);
    expect(report.drafting[0]).toMatchObject({ invented: [] });
    expect(report.drafting[0]?.firstDraft).toHaveLength(1);
    expect(exitCode(report)).toBe(0);
  });

  test("a failed call exits non-zero", async () => {
    const fake = createFakeAi();
    fake.queue(new AiError({ kind: "unavailable", message: "down" }), goodDraft);
    const report = await run(fake);
    expect(report).toMatchObject({ errors: 1, missedExclusions: 1 });
    expect(exitCode(report)).toBe(1);
  });

  test("the fixture files parse; rules never contradict an expected verdict; most exclusions need the model", async () => {
    const real = await loadSets();
    expect(real.eligibility.length).toBeGreaterThanOrEqual(12);
    expect(real.drafting.length).toBeGreaterThanOrEqual(4);
    for (const c of real.eligibility) {
      const rule = classifyEligibility({ description: c.description, locationText: c.locationText, structured: null });
      expect({ id: c.id, ok: rule.verdict === "unclear" || rule.verdict === c.expected }).toEqual({
        id: c.id,
        ok: true,
      });
    }
    const newExclusions = real.eligibility.filter(
      (c) =>
        c.expected === "excluded" &&
        classifyEligibility({ description: c.description, locationText: c.locationText, structured: null }).verdict ===
          "unclear",
    );
    expect(newExclusions.length).toBeGreaterThanOrEqual(8);
  });

  describe("the CLI", () => {
    const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
    beforeEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    });
    afterEach(() => {
      if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic;
      if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
    });

    test("bad arguments and a missing key exit 2 before any call", async () => {
      const lines: string[] = [];
      const out = (l: string) => void lines.push(l);
      expect(await main(["--tier", "light"], out)).toBe(2);
      expect(await main(["--model", "x", "--tier", "huge"], out)).toBe(2);
      expect(await main(["--model", "claude-haiku-5-5", "--via", "key"], out)).toBe(2);
      expect(lines.at(-1)).toBe("Set ANTHROPIC_API_KEY to run the eval with a key, or pass --via pi.");
      expect(await main(["--model", "mystery-1", "--via", "key"], out)).toBe(2);
      expect(lines.at(-1)).toContain("--provider");
      expect(await main(["--model", "mystery-1", "--via", "pi"], out)).toBe(2);
      expect(lines.at(-1)).toContain("--pi-provider");
      expect(await main(["--model", "gpt-6-luna", "--via", "pi", "--pi-provider", "nope"], out)).toBe(2);
    });

    test("via pi, the pi provider follows the model unless --pi-provider names one", () => {
      expect(piProviderFor({ model: "claude-haiku-5-5" })).toBe("anthropic");
      expect(piProviderFor({ model: "gpt-6-luna" })).toBe("openai-codex");
      expect(piProviderFor({ model: "gpt-6-luna", piProvider: "anthropic" })).toBe("anthropic");
      expect(piProviderFor({ model: "mystery-1" })).toBeNull();
    });
  });

  test("the light default is the model that passed the eval, and Settings offers it", async () => {
    expect(EVAL_PASSED_LIGHT.anthropic?.model).toBe("claude-haiku-5-5");
    for (const provider of ["anthropic", "openai"] as const) {
      const passed = EVAL_PASSED_LIGHT[provider];
      if (passed) expect(DEFAULT_MODELS[provider].light).toBe(passed.model);
    }
    // Nothing cheaper from Anthropic is priced, so Haiku is the cheapest light model that passed.
    const haiku = PRICES["claude-haiku-5-5"];
    const cheaper = Object.entries(PRICES).filter(
      ([id, p]) => id.startsWith("claude") && haiku && p.input + p.output < haiku.input + haiku.output,
    );
    expect(cheaper).toEqual([]);
    await resetDb();
    deps = await testDeps({ clock: { now: () => NOW } });
    app = createApp(deps);
    const settings = await json(await call("GET", "/settings"), SettingsDto);
    expect(settings.ai.defaults.anthropic.light).toBe("claude-haiku-5-5");
  });

  test("the eval never imports the app database", async () => {
    const root = join(import.meta.dir, "..");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = ["eval/run.ts"];
    while (queue.length) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const source = await Bun.file(join(root, file)).text();
      for (const { path } of transpiler.scanImports(source)) {
        const target = path.startsWith("@/")
          ? `src/${path.slice(2)}`
          : path.startsWith(".")
            ? relative(root, join(root, dirname(file), path))
            : null;
        if (target === null) {
          packages.add(path);
          continue;
        }
        const candidates = [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, target];
        let resolved: string | undefined;
        for (const p of candidates) if (!resolved && (await Bun.file(join(root, p)).exists())) resolved = p;
        // Text imports (the drafting guide) are data, not code with imports of their own.
        if (resolved && /\.tsx?$/.test(resolved)) queue.push(resolved);
      }
    }
    expect([...seen].filter((f) => f.startsWith("src/server/db/") || f === "src/server/services/ai.ts")).toEqual([]);
    expect([...packages].filter((p) => p === "postgres" || p.startsWith("drizzle-orm"))).toEqual([]);
    expect(seen.has("src/server/services/ai-replies.ts")).toBe(true);
  });
});
