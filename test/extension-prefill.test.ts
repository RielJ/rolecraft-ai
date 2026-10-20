import { beforeEach, describe, expect, test } from "bun:test";
import type { PdfRenderer } from "@/server/adapters/pdf";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  ApiErrorBody,
  type OpportunityId,
  type OutputDto,
  type OutputId,
  ProfileDto,
  TaskDto,
  WorkspaceDto,
} from "@/shared/api";
import {
  type ApplicationSessionId,
  ClaimPairingResult,
  CreatePairingResult,
  CreateSessionResult,
  ExtensionOutputDto,
  ExtensionOutputList,
  FieldDescriptor,
  MAX_PREFILL_FIELDS,
  PreferenceDto,
  PreferenceList,
  PrefillResponse,
  ScanNonce,
} from "@/shared/extension";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Chrome extension (docs/EXTENSION.md): saved preferences, the prefill payload for a claimed
 * session, and the materials routes (outputs without bodies, mark reviewed, draft, task poll, PDF).
 * Everything goes through createApp, as the extension and the SPA would call it.
 */

const APP_ORIGIN = "http://localhost";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT_ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const NONCE = ScanNonce.parse("scan-nonce-0123456789");
const SALARY = "PHP 150,000 a month";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000009";

const CV = [
  "- Built a payments API in Go serving 2M requests a day",
  "- Led a team of 4 engineers at Acme Corp",
  "- Moved our job queue to Postgres in 2022",
].join("\n");

const JOB = {
  url: "https://jobs.lever.co/acme/123",
  title: "Senior Backend Engineer",
  company: "Acme Inc",
  description: "We need someone to build payment APIs. Remote, worldwide.",
};
const OTHER_JOB = {
  url: "https://boards.greenhouse.io/globex/jobs/77",
  title: "Platform Engineer",
  company: "Globex",
  description: "Run our platform. Hybrid in Makati.",
};

/** Records what was rendered instead of starting Chromium. */
const fakePdf: PdfRenderer & { rendered: number } = {
  rendered: 0,
  async render() {
    fakePdf.rendered += 1;
    return new TextEncoder().encode("%PDF-1.4 fake");
  },
  async close() {},
};

let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps({ pdf: fakePdf });
  app = createApp(deps);
});

type Call = { method?: string; path: string; headers?: Record<string, string>; body?: unknown };

function call({ method = "GET", path, headers = {}, body }: Call) {
  const sent = new Headers(headers);
  if (body !== undefined && !sent.has("content-type")) sent.set("content-type", "application/json");
  return app.request(path, { method, headers: sent, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

async function errorCode(res: Response, status: number): Promise<string> {
  return (await json(res, ApiErrorBody, status)).error.code;
}

/** A web (SPA) call: same-origin, no token. */
function web(method: string, path: string, body?: unknown) {
  return call({ method, path: `/api${path}`, headers: { origin: APP_ORIGIN }, body });
}

type Ext = { token: string; origin?: string };

/** An extension call with the bearer token. */
function ext({ token, origin = EXT_ORIGIN }: Ext, method: string, path: string, body?: unknown) {
  return call({
    method,
    path: `/api/extension${path}`,
    headers: { authorization: `Bearer ${token}`, origin },
    body,
  });
}

async function pair(origin = EXT_ORIGIN): Promise<Ext> {
  const created = await web("POST", "/extension-web/pairings", {});
  const { code } = await json(created, CreatePairingResult, 201);
  const claimed = await call({
    method: "POST",
    path: "/api/extension/pair/claim",
    headers: { origin },
    body: { code },
  });
  const { token } = await json(claimed, ClaimPairingResult);
  return { token, origin };
}

async function workspace(opportunityId: OpportunityId): Promise<WorkspaceDto> {
  return json(await web("GET", `/opportunities/${opportunityId}`), WorkspaceDto);
}

async function addJob(job: typeof JOB): Promise<OpportunityId> {
  return (await json(await web("POST", "/jobs/from-paste", job), AddJobResult, 201)).opportunityId;
}

/** Contact, standard answers (salary included), confirmed facts, an AI key, and two jobs. */
async function setup() {
  await web("PUT", "/profile", {
    contact: {
      fullName: "Juan Dela Cruz",
      email: "juan@example.ph",
      phone: "+63 917 000 0000",
      location: "Manila, Philippines",
      links: ["https://github.com/juan"],
    },
    standardAnswers: { salary: SALARY, notice: "30 days", work_auth: "Filipino citizen" },
  });
  await waitForSplits(await json(await web("PUT", "/profile/cv", { text: CV }), ProfileDto));
  await json(await web("POST", "/facts/confirm-all"), ProfileDto);
  expect((await web("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
  const opportunityId = await addJob(JOB);
  const otherId = await addJob(OTHER_JOB);
  return { opportunityId, otherId };
}

/** Apply from the workspace, then claim from the job's tab. */
async function claimedSession(opportunityId: OpportunityId, who: Ext, tabUrl = JOB.url) {
  const created = await web("POST", "/extension-web/sessions", { opportunityId });
  const { session } = await json(created, CreateSessionResult, 201);
  const claimed = await ext(who, "POST", `/sessions/${session.id}/claim`, { tabUrl });
  expect(claimed.status).toBe(200);
  return session.id;
}

async function addAnswer(opportunityId: OpportunityId, question: string, body: string): Promise<OutputDto> {
  const ws = await json(
    await web("POST", `/opportunities/${opportunityId}/questions`, { question }),
    WorkspaceDto,
    201,
  );
  const answer = ws.answers.find((a) => a.question === question);
  if (!answer) throw new Error(`no answer for ${question}`);
  const edited = await json(await web("PATCH", `/outputs/${answer.id}`, { body }), WorkspaceDto);
  return output(edited, answer.id);
}

function output(ws: WorkspaceDto, id: OutputId): OutputDto {
  const found = [...ws.files, ...ws.answers].find((o) => o.id === id);
  if (!found) throw new Error(`no output ${id}`);
  return found;
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message"): OutputDto {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

let fieldNo = 0;
function field(label: string, over: Partial<Omit<FieldDescriptor, "fieldId">> = {}): FieldDescriptor {
  fieldNo += 1;
  return FieldDescriptor.parse({
    fieldId: `f${fieldNo}`,
    control: "text",
    label,
    autocomplete: null,
    name: null,
    required: false,
    options: [],
    adapterCategory: null,
    ...over,
  });
}

async function prefill(who: Ext, sessionId: ApplicationSessionId, fields: FieldDescriptor[]) {
  const res = await ext(who, "POST", `/sessions/${sessionId}/prefill`, { nonce: NONCE, fields });
  expect(res.headers.get("cache-control")).toBe("no-store");
  const raw: unknown = await res.json();
  expect({ status: res.status, raw }).toMatchObject({ status: 200 });
  return { raw, payload: PrefillResponse.parse(raw) };
}

function matchOf(payload: PrefillResponse, fieldId: string) {
  return payload.matches.find((m) => m.fieldId === fieldId);
}

function unresolvedOf(payload: PrefillResponse, fieldId: string) {
  return payload.unresolved.find((u) => u.fieldId === fieldId);
}

/** "Mark reviewed" in the workspace, sending the body the page shows (the stored one unless given). */
async function markReviewedWeb(outputId: OutputId, shown?: string): Promise<OutputDto> {
  const body = shown ?? (await storedBody(outputId));
  return output(await json(await web("POST", `/outputs/${outputId}/reviewed`, { body }), WorkspaceDto), outputId);
}

async function storedBody(outputId: OutputId): Promise<string> {
  const [row] = await testSql()<{ body: string | null }[]>`SELECT body FROM outputs WHERE id = ${outputId}`;
  return row?.body ?? "";
}

async function storedReviewedAt(outputId: OutputId): Promise<Date | null> {
  const [row] = await testSql()<{ reviewed_at: Date | null }[]>`SELECT reviewed_at FROM outputs WHERE id = ${outputId}`;
  return row?.reviewed_at ?? null;
}

const CHANGED = "This text changed since you opened it. Read the new version, then mark it reviewed.";

// ---------- reviewed_at ----------

describe("Mark reviewed (web) and reviewed_at", () => {
  test("POST /outputs/:id/reviewed sets reviewedAt; an edit and a redraft clear it", async () => {
    const { opportunityId } = await setup();
    const resume = file(await workspace(opportunityId), "resume");
    expect(resume.reviewedAt).toBeNull();

    const drafted = await json(
      await web("POST", `/opportunities/${opportunityId}/draft`, { kinds: ["resume"] }),
      TaskDto,
      202,
    );
    await waitForTask(drafted.id);
    const reviewed = await markReviewedWeb(resume.id);
    expect(reviewed.reviewedAt).toBe(deps.clock.now().toISOString());

    // A redraft rewrites the body: the review no longer applies.
    const redraft = await json(
      await web("POST", `/opportunities/${opportunityId}/draft`, { kinds: ["resume"] }),
      TaskDto,
      202,
    );
    await waitForTask(redraft.id);
    expect(output(await workspace(opportunityId), resume.id).reviewedAt).toBeNull();

    // So does an edit of the body; ticking it on or off does not.
    await markReviewedWeb(resume.id);
    await web("PATCH", `/outputs/${resume.id}`, { included: true });
    expect(output(await workspace(opportunityId), resume.id).reviewedAt).not.toBeNull();
    await web("PATCH", `/outputs/${resume.id}`, { body: "# Juan Dela Cruz\n- Led a team of 4 engineers [FACT-2]." });
    expect(output(await workspace(opportunityId), resume.id).reviewedAt).toBeNull();
  });

  test("an output with no body cannot be marked reviewed; an unknown output is 404; a missing body is 400", async () => {
    const { opportunityId } = await setup();
    const letter = file(await workspace(opportunityId), "letter");
    expect(await errorCode(await web("POST", `/outputs/${letter.id}/reviewed`, { body: "" }), 400)).toBe(
      "invalid_input",
    );
    expect(await errorCode(await web("POST", `/outputs/${UNKNOWN_ID}/reviewed`, { body: "x" }), 404)).toBe("not_found");
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    expect(await errorCode(await web("POST", `/outputs/${answer.id}/reviewed`, {}), 400)).toBe("invalid_input");
    expect(await storedReviewedAt(answer.id)).toBeNull();
  });

  test("a stale body after an edit is 409 and leaves reviewed_at null; the current body is 200", async () => {
    const { opportunityId } = await setup();
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    // Another tab edits the answer after this one showed "Yes.".
    await web("PATCH", `/outputs/${answer.id}`, { body: "No, I can't travel." });

    const stale = await json(await web("POST", `/outputs/${answer.id}/reviewed`, { body: "Yes." }), ApiErrorBody, 409);
    expect(stale.error).toMatchObject({ code: "output_changed", message: CHANGED });
    expect(await storedReviewedAt(answer.id)).toBeNull();

    const reviewed = await markReviewedWeb(answer.id, "No, I can't travel.");
    expect(reviewed.reviewedAt).toBe(deps.clock.now().toISOString());
    expect(await storedReviewedAt(answer.id)).not.toBeNull();
  });

  test("a redraft that lands between loading the page and Mark reviewed makes the old body 409", async () => {
    const { opportunityId } = await setup();
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    // The page loads and shows the body.
    const shown = output(await workspace(opportunityId), answer.id).body ?? "";
    // The redraft's write (saveDraft): a new body, review cleared.
    await testSql()`UPDATE outputs SET body = 'Yes, up to 30% of the time.', reviewed_at = NULL WHERE id = ${answer.id}`;

    expect(await errorCode(await web("POST", `/outputs/${answer.id}/reviewed`, { body: shown }), 409)).toBe(
      "output_changed",
    );
    expect(await storedReviewedAt(answer.id)).toBeNull();
  });

  test("a redraft committing while Mark reviewed waits on the row wins: the old body is 409", async () => {
    const { opportunityId } = await setup();
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    let marked: Promise<Response> | Response | undefined;
    // The redraft holds the row with its new body uncommitted while Mark reviewed arrives.
    await testSql().begin(async (tx) => {
      await tx`UPDATE outputs SET body = 'Yes, up to 30% of the time.', reviewed_at = NULL WHERE id = ${answer.id}`;
      marked = web("POST", `/outputs/${answer.id}/reviewed`, { body: "Yes." });
      await Bun.sleep(100);
    });
    if (marked === undefined) throw new Error("Mark reviewed was not sent");
    expect(await errorCode(await marked, 409)).toBe("output_changed");
    expect(await storedReviewedAt(answer.id)).toBeNull();
  });
});

// ---------- Preferences ----------

describe("preferences", () => {
  const relocateYes = {
    category: "willing_to_relocate",
    typedValue: { valueType: "yesNo", value: true },
    displayText: "Yes",
    scope: { kind: "global" },
  };

  test("PUT upserts per category and scope; GET lists both scopes; DELETE removes one", async () => {
    const { opportunityId } = await setup();
    const who = await pair();

    const global = await json(await ext(who, "PUT", "/preferences", relocateYes), PreferenceDto);
    expect(global).toMatchObject({ category: "willing_to_relocate", scope: { kind: "global" }, displayText: "Yes" });

    const again = await json(
      await ext(who, "PUT", "/preferences", { ...relocateYes, displayText: "Yes, anywhere in Asia" }),
      PreferenceDto,
    );
    expect(again.id).toBe(global.id);
    expect(again.displayText).toBe("Yes, anywhere in Asia");

    const job = await json(
      await ext(who, "PUT", "/preferences", {
        ...relocateYes,
        typedValue: { valueType: "yesNo", value: false },
        displayText: "No",
        scope: { kind: "opportunity", opportunityId },
      }),
      PreferenceDto,
    );
    expect(job.id).not.toBe(global.id);
    expect(job.scope).toEqual({ kind: "opportunity", opportunityId });

    const listed = await json(await ext(who, "GET", "/preferences"), PreferenceList);
    expect(listed.preferences.map((p) => p.id).sort()).toEqual([global.id, job.id].sort());

    const afterDelete = await json(await ext(who, "DELETE", `/preferences/${global.id}`), PreferenceList);
    expect(afterDelete.preferences.map((p) => p.id)).toEqual([job.id]);
    expect(await errorCode(await ext(who, "DELETE", `/preferences/${global.id}`), 404)).toBe("not_found");
  });

  test("a value that does not fit, a salary category, or an unknown job is refused", async () => {
    await setup();
    const who = await pair();
    const wrongType = { ...relocateYes, typedValue: { valueType: "text", value: "sure" } };
    expect(await errorCode(await ext(who, "PUT", "/preferences", wrongType), 400)).toBe("invalid_input");
    const wrongChoice = {
      category: "gender",
      typedValue: { valueType: "choice", value: "robot" },
      displayText: "Robot",
      scope: { kind: "global" },
    };
    expect(await errorCode(await ext(who, "PUT", "/preferences", wrongChoice), 400)).toBe("invalid_input");
    for (const category of ["salary", "compensation", "expected_salary"]) {
      const salary = {
        category,
        typedValue: { valueType: "text", value: SALARY },
        displayText: SALARY,
        scope: { kind: "global" },
      };
      expect(await errorCode(await ext(who, "PUT", "/preferences", salary), 400)).toBe("invalid_input");
    }
    const unknownJob = { ...relocateYes, scope: { kind: "opportunity", opportunityId: UNKNOWN_ID } };
    expect(await errorCode(await ext(who, "PUT", "/preferences", unknownJob), 404)).toBe("not_found");
    const [{ n } = { n: -1 }] = await testSql()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM application_preferences`;
    expect(n).toBe(0);
  });
});

// ---------- Prefill ----------

describe("POST sessions/:id/prefill", () => {
  test("profile, then per-job, then global; salary never leaves the server", async () => {
    const { opportunityId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);

    // A salary answer, reviewed, and a salary preference attempt must never reach the payload.
    const salaryAnswer = await addAnswer(opportunityId, "What are your salary expectations?", SALARY);
    expect(salaryAnswer.mustAnswer).toBe("salary");
    await markReviewedWeb(salaryAnswer.id);

    const yesNo = [
      { value: "", label: "Select..." },
      { value: "y", label: "Yes" },
      { value: "n", label: "No" },
    ];
    await ext(who, "PUT", "/preferences", {
      category: "willing_to_relocate",
      typedValue: { valueType: "yesNo", value: true },
      displayText: "Yes",
      scope: { kind: "global" },
    });
    const travelGlobal = await json(
      await ext(who, "PUT", "/preferences", {
        category: "willing_to_travel",
        typedValue: { valueType: "yesNo", value: true },
        displayText: "Yes",
        scope: { kind: "global" },
      }),
      PreferenceDto,
    );
    const relocateJob = await json(
      await ext(who, "PUT", "/preferences", {
        category: "willing_to_relocate",
        typedValue: { valueType: "yesNo", value: false },
        displayText: "No",
        scope: { kind: "opportunity", opportunityId },
      }),
      PreferenceDto,
    );
    // A preference that conflicts with the profile loses to it.
    await ext(who, "PUT", "/preferences", {
      category: "notice_period",
      typedValue: { valueType: "text", value: "Two weeks" },
      displayText: "Two weeks",
      scope: { kind: "global" },
    });

    const email = field("Email", { control: "email", autocomplete: "email" });
    const notice = field("Notice period");
    const relocate = field("Are you willing to relocate?", { control: "select", options: yesNo });
    const travel = field("Are you willing to travel?", { control: "radio", options: yesNo });
    const rate = field("Expected monthly rate");
    const salaryQuestion = field("What are your salary expectations?");
    const unlabelled = field("", { name: "desired_salary" });
    const resume = field("Resume", { control: "file" });

    const { raw, payload } = await prefill(who, sessionId, [
      email,
      notice,
      relocate,
      travel,
      rate,
      salaryQuestion,
      unlabelled,
      resume,
    ]);
    expect(payload.nonce).toBe(NONCE);

    expect(matchOf(payload, email.fieldId)).toMatchObject({
      confidence: "high",
      provenance: { kind: "profile" },
      value: { kind: "text", text: "juan@example.ph" },
    });
    expect(matchOf(payload, notice.fieldId)).toMatchObject({
      provenance: { kind: "profile" },
      value: { kind: "text", text: "30 days" },
    });
    expect(matchOf(payload, relocate.fieldId)).toMatchObject({
      provenance: { kind: "job_preference", preferenceId: relocateJob.id },
      value: { kind: "option", value: "n" },
    });
    expect(matchOf(payload, travel.fieldId)).toMatchObject({
      provenance: { kind: "global_preference", preferenceId: travelGlobal.id },
      value: { kind: "option", value: "y" },
    });
    for (const f of [rate, salaryQuestion, unlabelled]) {
      expect(unresolvedOf(payload, f.fieldId)).toEqual({ fieldId: f.fieldId, reason: "salary", category: null });
    }
    expect(unresolvedOf(payload, resume.fieldId)?.reason).toBe("file_field");

    const text = JSON.stringify(raw);
    expect(text).not.toContain("150,000");
    expect(text).not.toContain(salaryAnswer.id);
  });

  test("a generated answer needs review until marked reviewed, and again after a redraft; markers are stripped", async () => {
    const { opportunityId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes, I led a team of 4 [FACT-2].");
    const travel = field("Are you willing to travel?", { control: "textarea" });

    const before = matchOf((await prefill(who, sessionId, [travel])).payload, travel.fieldId);
    expect(before).toMatchObject({
      provenance: { kind: "generated", outputId: answer.id },
      value: { kind: "text", text: "Yes, I led a team of 4." },
      needsReview: true,
    });

    // Reviewed in the panel, with the text the panel showed (markers stripped). A stale text is 409.
    const path = `/sessions/${sessionId}/outputs/${answer.id}/reviewed`;
    const stale = await json(await ext(who, "POST", path, { body: "Yes." }), ApiErrorBody, 409);
    expect(stale.error).toMatchObject({ code: "output_changed", message: CHANGED });
    expect(await storedReviewedAt(answer.id)).toBeNull();
    const reviewed = await json(await ext(who, "POST", path, { body: "Yes, I led a team of 4." }), ExtensionOutputDto);
    expect(reviewed.reviewedAt).not.toBeNull();
    expect(matchOf((await prefill(who, sessionId, [travel])).payload, travel.fieldId)?.needsReview).toBe(false);

    // A redraft from the panel clears the review.
    const task = await json(
      await ext(who, "POST", `/sessions/${sessionId}/draft`, { outputId: answer.id }),
      TaskDto,
      202,
    );
    await waitForTask(task.id);
    expect((await json(await ext(who, "GET", `/tasks/${task.id}`), TaskDto)).status).toBe("done");
    const [row] = await testSql()<{ reviewed_at: Date | null; generated_at: Date | null }[]>`
      SELECT reviewed_at, generated_at FROM outputs WHERE id = ${answer.id}`;
    expect(row?.generated_at).not.toBeNull();
    expect(row?.reviewed_at).toBeNull();
    const after = matchOf((await prefill(who, sessionId, [travel])).payload, travel.fieldId);
    expect(after?.needsReview).toBe(true);
    expect(after?.value.kind === "text" && after.value.text).not.toMatch(/\[FACT-\d+\]/);
  });

  test("more than 200 fields is 400; a pending, unknown or other pairing's session is refused", async () => {
    const { opportunityId } = await setup();
    const who = await pair();
    const other = await pair(OTHER_EXT_ORIGIN);
    const sessionId = await claimedSession(opportunityId, who);

    const tooMany = Array.from({ length: MAX_PREFILL_FIELDS + 1 }, () => field("Email"));
    const res = await ext(who, "POST", `/sessions/${sessionId}/prefill`, { nonce: NONCE, fields: tooMany });
    expect(await errorCode(res, 400)).toBe("invalid_input");

    const body = { nonce: NONCE, fields: [field("Email")] };
    expect(await errorCode(await ext(other, "POST", `/sessions/${sessionId}/prefill`, body), 404)).toBe("not_found");
    expect(await errorCode(await ext(who, "POST", `/sessions/${UNKNOWN_ID}/prefill`, body), 404)).toBe("not_found");

    // A new Apply supersedes the claimed session; the new one is still pending.
    const { session: pending } = await json(
      await web("POST", "/extension-web/sessions", { opportunityId }),
      CreateSessionResult,
      201,
    );
    expect(await errorCode(await ext(who, "POST", `/sessions/${sessionId}/prefill`, body), 409)).toBe(
      "session_expired",
    );
    expect(await errorCode(await ext(who, "POST", `/sessions/${pending.id}/prefill`, body), 409)).toBe(
      "session_expired",
    );
  });
});

// ---------- Materials ----------

describe("materials: outputs, edit, draft, tasks, PDF", () => {
  test("GET sessions/:id/outputs lists the session's outputs without bodies", async () => {
    const { opportunityId, otherId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    await addAnswer(otherId, "Are you willing to relocate?", "No.");

    const res = await ext(who, "GET", `/sessions/${sessionId}/outputs`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw: unknown = await res.json();
    expect(res.status).toBe(200);
    const { outputs } = ExtensionOutputList.parse(raw);
    expect(outputs.map((o) => o.kind)).toEqual(["resume", "letter", "message", "answer"]);
    expect(outputs.find((o) => o.id === answer.id)).toMatchObject({
      question: "Are you willing to travel?",
      reviewedAt: null,
      outdated: false,
    });
    expect(JSON.stringify(raw)).not.toContain('"body"');
    expect(JSON.stringify(raw)).not.toContain("relocate");
  });

  test("PATCH from the panel edits the body and clears the review", async () => {
    const { opportunityId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);
    const answer = await addAnswer(opportunityId, "Are you willing to travel?", "Yes.");
    await markReviewedWeb(answer.id);

    const edited = await json(
      await ext(who, "PATCH", `/sessions/${sessionId}/outputs/${answer.id}`, { body: "Yes, up to 30% of the time." }),
      ExtensionOutputDto,
    );
    expect(edited.reviewedAt).toBeNull();
    expect(edited.editedAt).not.toBeNull();
    expect(output(await workspace(opportunityId), answer.id).body).toBe("Yes, up to 30% of the time.");
  });

  test("another opportunity's outputs are 404 on every material route", async () => {
    const { opportunityId, otherId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);
    const foreign = file(await workspace(otherId), "resume");
    await web("PATCH", `/outputs/${foreign.id}`, { body: "# Juan\n- Led a team of 4 engineers [FACT-2]." });

    const base = `/sessions/${sessionId}/outputs/${foreign.id}`;
    expect(await errorCode(await ext(who, "PATCH", base, { body: "hijack" }), 404)).toBe("not_found");
    expect(
      await errorCode(
        await ext(who, "POST", `${base}/reviewed`, { body: "# Juan\n- Led a team of 4 engineers [FACT-2]." }),
        404,
      ),
    ).toBe("not_found");
    expect(await errorCode(await ext(who, "GET", `${base}/pdf`), 404)).toBe("not_found");
    expect(await errorCode(await ext(who, "POST", `/sessions/${sessionId}/draft`, { outputId: foreign.id }), 404)).toBe(
      "not_found",
    );
    const after = output(await workspace(otherId), foreign.id);
    expect(after.body).toBe("# Juan\n- Led a team of 4 engineers [FACT-2].");
    expect(after.reviewedAt).toBeNull();
    expect(fakePdf.rendered).toBe(0);
  });

  test("GET tasks/:id returns only draft tasks of a job this pairing holds a session for", async () => {
    const { opportunityId, otherId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);

    const mine = await json(
      await ext(who, "POST", `/sessions/${sessionId}/draft`, { kinds: ["resume"] }),
      TaskDto,
      202,
    );
    await waitForTask(mine.id);
    expect(await json(await ext(who, "GET", `/tasks/${mine.id}`), TaskDto)).toMatchObject({
      id: mine.id,
      kind: "draft",
    });

    const foreign = await json(
      await web("POST", `/opportunities/${otherId}/draft`, { kinds: ["resume"] }),
      TaskDto,
      202,
    );
    await waitForTask(foreign.id);
    expect(await errorCode(await ext(who, "GET", `/tasks/${foreign.id}`), 404)).toBe("not_found");

    const [refresh] = await testSql()<{ id: string }[]>`
      INSERT INTO tasks (user_id, kind, status, input) VALUES (${deps.userId}, 'refresh', 'done', '{}'::jsonb) RETURNING id`;
    expect(await errorCode(await ext(who, "GET", `/tasks/${refresh?.id}`), 404)).toBe("not_found");
    expect(await errorCode(await ext(who, "GET", `/tasks/${UNKNOWN_ID}`), 404)).toBe("not_found");
  });

  test("GET .../pdf returns the session's resume as application/pdf, no-store; a message is not a PDF", async () => {
    const { opportunityId } = await setup();
    const who = await pair();
    const sessionId = await claimedSession(opportunityId, who);
    const ws = await workspace(opportunityId);
    await web("PATCH", `/outputs/${file(ws, "resume").id}`, { body: "# Juan\n- Led a team of 4 engineers [FACT-2]." });
    await web("PATCH", `/outputs/${file(ws, "letter").id}`, { body: "Dear Acme, I build payment APIs [FACT-1]." });
    await web("PATCH", `/outputs/${file(ws, "message").id}`, { body: "Hi, I led a team of 4 [FACT-2]." });

    const res = await ext(who, "GET", `/sessions/${sessionId}/outputs/${file(ws, "resume").id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF-1.4 fake");

    const message = await ext(who, "GET", `/sessions/${sessionId}/outputs/${file(ws, "message").id}/pdf`);
    expect(await errorCode(message, 400)).toBe("not_exportable");
  });
});
