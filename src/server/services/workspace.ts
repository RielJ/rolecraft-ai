import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { checkDraft, factKey, parseCitations, quarantineViolations, stripMarkers } from "@/domain/citations";
import { checkGate, type GateOutput } from "@/domain/gate";
import { isPrivateGithubUrl, stripPrivateGithubUrls } from "@/domain/github-link";
import { classifyQuestion } from "@/domain/must-answer";
import {
  allowedFacts,
  buildDraftPrompt,
  buildQuestionsPrompt,
  buildRetryPrompt,
  buildStyleRewritePrompt,
  cleanModelText,
  DRAFT_MAX_TOKENS,
  type PromptFact,
  QUESTIONS_MAX_TOKENS,
} from "@/domain/prompts";
import { checkStyle } from "@/domain/style";
import { sentenceSpans } from "@/domain/text";
import {
  type AddQuestionInput,
  type ContractTerms,
  type DraftInput,
  DraftTaskInput,
  type FactId,
  type FactKey,
  type GateResult,
  type OpportunityId,
  type OutdatedChange,
  type OutputDto,
  type OutputId,
  type StandardAnswers,
  SuggestQuestionsResult,
  SuggestQuestionsTaskInput,
  type TaskDto,
  type UpdateOutputInput,
  type WorkspaceDto,
} from "@/shared/api";
import {
  type FactStatus,
  FILE_KINDS,
  FROZEN_STATUSES,
  type ItemUsage,
  type OpportunityStatus,
  type OutputKind,
  PDF_KINDS,
} from "@/shared/enums";
import { outputKindLabel } from "@/shared/labels";
import type { DbOrTx } from "../db/client";
import { facts, jobs, opportunities, outputFacts, outputs, profileItems } from "../db/schema";
import { checkCap, estimateUsd, loadAiConfig, requireAiConfig, runAi } from "./ai";
import { parseQuestionsReply } from "./ai-replies";
import { AppError, type Deps, notFound } from "./context";
import { privateGithubRepos } from "./github";
import { jobFacts } from "./jobs";
import { loadContact } from "./profile";
import { latestTask, startTask, type TaskContext } from "./tasks";

type OutputRow = typeof outputs.$inferSelect;
/** A cited fact as it is now; null when the fact was deleted. */
type CurrentFact = { text: string; status: FactStatus; usage: ItemUsage };
type Citation = { factKey: FactKey; factText: string; deleted: boolean; current: CurrentFact | null };

/** Contract terms as the API shows them, or null for a job. `numeric` arrives from Postgres as text. */
export function contractTerms(
  row: Pick<typeof opportunities.$inferSelect, "type" | "rateAmount" | "rateType" | "rateCurrency" | "platform">,
): ContractTerms | null {
  if (row.type === "job") return null;
  return {
    rateAmount: row.rateAmount === null ? null : Number(row.rateAmount),
    rateType: row.rateType,
    rateCurrency: row.rateCurrency,
    platform: row.platform,
  };
}

function isFrozen(status: OpportunityStatus | null): boolean {
  return FROZEN_STATUSES.some((s) => s === status);
}

async function loadOpportunity(deps: Pick<Deps, "db" | "userId">, opportunityId: OpportunityId) {
  const [row] = await deps.db
    .select({ opportunity: opportunities, job: jobs })
    .from(opportunities)
    .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  if (!row) throw notFound("That job");
  return row;
}

async function loadOutputs(
  db: DbOrTx,
  opportunityId: OpportunityId,
): Promise<{ row: OutputRow; citations: Citation[] }[]> {
  const rows = await db
    .select()
    .from(outputs)
    .where(eq(outputs.opportunityId, opportunityId))
    .orderBy(asc(outputs.position), asc(outputs.createdAt));
  const ids = rows.map((r) => r.id);
  const cites = ids.length
    ? await db
        .select({
          outputId: outputFacts.outputId,
          factKey: outputFacts.factKey,
          factText: outputFacts.factText,
          factId: outputFacts.factId,
          currentText: facts.text,
          currentStatus: facts.status,
          usage: profileItems.usage,
        })
        .from(outputFacts)
        .leftJoin(facts, eq(facts.id, outputFacts.factId))
        .leftJoin(profileItems, eq(profileItems.id, facts.itemId))
        .where(inArray(outputFacts.outputId, ids))
        .orderBy(asc(outputFacts.factKey))
    : [];
  return rows.map((row) => ({
    row,
    citations: cites
      .filter((c) => c.outputId === row.id)
      .map((c) => ({
        factKey: c.factKey,
        factText: c.factText,
        deleted: c.factId === null,
        current:
          c.currentText !== null && c.currentStatus !== null && c.usage !== null
            ? { text: c.currentText, status: c.currentStatus, usage: c.usage }
            : null,
      })),
  }));
}

/**
 * What changed in the facts an output cites (section 2, Provenance). Frozen outputs skip this.
 * One reason per fact: deleted, then edited, then unconfirmed, then letters-only on a resume.
 */
function outdatedChanges(kind: OutputKind, citations: readonly Citation[]): OutdatedChange[] {
  return citations.flatMap((c): OutdatedChange[] => {
    const base = { factKey: c.factKey, oldText: c.factText };
    if (c.current === null) return [{ ...base, reason: "deleted", newText: null }];
    const newText = c.current.text;
    if (newText !== c.factText) return [{ ...base, reason: "edited", newText }];
    if (c.current.status !== "confirmed") return [{ ...base, reason: "unconfirmed", newText }];
    if (kind === "resume" && c.current.usage === "letters_only") return [{ ...base, reason: "letters_only", newText }];
    return [];
  });
}

function toGateOutput({ row, citations }: { row: OutputRow; citations: Citation[] }): GateOutput {
  return {
    id: row.id,
    kind: row.kind,
    included: row.included,
    question: row.question,
    mustAnswer: row.mustAnswer,
    body: row.body,
    citations,
  };
}

function toOutputDto(
  { row, citations }: { row: OutputRow; citations: Citation[] },
  standardAnswers: StandardAnswers,
  frozen: boolean,
): OutputDto {
  return {
    id: row.id,
    kind: row.kind,
    included: row.included,
    question: row.question,
    mustAnswer: row.mustAnswer,
    body: row.body,
    profileAnswer: row.mustAnswer ? (standardAnswers[row.mustAnswer] ?? null) : null,
    position: row.position,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    editedAt: row.editedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    citations: citations.map((c) => ({ key: c.factKey, text: c.factText, deleted: c.deleted })),
    styleHits: row.styleHits,
    outdated: frozen ? [] : outdatedChanges(row.kind, citations),
  };
}

async function gateFor(deps: Deps, opportunityId: OpportunityId): Promise<GateResult> {
  const [{ standardAnswers }, loaded] = await Promise.all([loadContact(deps), loadOutputs(deps.db, opportunityId)]);
  return checkGate({ outputs: loaded.map(toGateOutput), standardAnswers });
}

/** Ready only when it was marked and the gate still passes on current data (section 3.5). */
export async function isReady(deps: Deps, { opportunityId }: { opportunityId: OpportunityId }): Promise<boolean> {
  const { opportunity } = await loadOpportunity(deps, opportunityId);
  if (opportunity.readyAt === null) return false;
  return (await gateFor(deps, opportunityId)).ok;
}

export async function getWorkspace(
  deps: Deps,
  { opportunityId }: { opportunityId: OpportunityId },
): Promise<WorkspaceDto> {
  const { opportunity, job } = await loadOpportunity(deps, opportunityId);
  const frozen = isFrozen(opportunity.status);
  const [{ standardAnswers }, loaded, confirmed, aiConfig, draftTask, suggestTask, jobView] = await Promise.all([
    loadContact(deps),
    loadOutputs(deps.db, opportunityId),
    deps.db
      .select({ no: facts.no, text: facts.text })
      .from(facts)
      .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")))
      .orderBy(asc(facts.no)),
    loadAiConfig(deps),
    latestTask(deps, { kind: "draft", inputMatches: { opportunityId } }),
    latestTask(deps, { kind: "suggest_questions", inputMatches: { opportunityId } }),
    jobFacts(deps, job),
  ]);
  const gate = checkGate({ outputs: loaded.map(toGateOutput), standardAnswers });
  const dtos = loaded.map((o) => toOutputDto(o, standardAnswers, frozen));
  const draftInput = DraftTaskInput.safeParse(draftTask?.input);
  return {
    opportunity: {
      id: opportunity.id,
      type: opportunity.type,
      status: opportunity.status,
      outcome: opportunity.outcome,
      frozen,
      ready: opportunity.readyAt !== null && gate.ok,
      notes: opportunity.notes,
      contract: contractTerms(opportunity),
    },
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      description: job.description,
      applyUrl: job.applyUrl,
      ...jobView,
    },
    files: dtos.filter((o) => o.kind !== "answer"),
    answers: dtos.filter((o) => o.kind === "answer"),
    gate,
    facts: confirmed.map((f) => ({ key: factKey(f.no), text: f.text })),
    aiReady: aiConfig !== null,
    draftTask: draftTask && draftInput.success ? { ...draftTask.task, outputIds: draftInput.data.outputIds } : null,
    suggestTask: suggestTask
      ? { ...suggestTask.task, result: SuggestQuestionsResult.nullable().catch(null).parse(suggestTask.result) }
      : null,
  };
}

async function loadOutput(deps: Deps, outputId: OutputId) {
  const [row] = await deps.db
    .select({ output: outputs, status: opportunities.status })
    .from(outputs)
    .innerJoin(opportunities, eq(opportunities.id, outputs.opportunityId))
    .where(and(eq(outputs.id, outputId), eq(outputs.userId, deps.userId)));
  if (!row) throw notFound("That file or answer");
  return row;
}

function assertEditable(status: OpportunityStatus | null): void {
  if (isFrozen(status)) {
    throw new AppError({
      code: "frozen",
      message: "This job is marked applied, so its files and answers stay as you sent them.",
    });
  }
}

/**
 * Re-parse markers after an edit: new markers get a fresh snapshot of the fact text,
 * kept markers keep their old snapshot, removed markers lose their row (section 2).
 * A marker naming a fact that does not exist gets no row.
 */
async function syncCitations(db: DbOrTx, deps: Deps, outputId: OutputId, body: string | null): Promise<void> {
  const keys = body === null ? [] : parseCitations(body);
  const existing = await db
    .select({ factKey: outputFacts.factKey })
    .from(outputFacts)
    .where(eq(outputFacts.outputId, outputId));
  const have = new Set<string>(existing.map((e) => e.factKey));
  const want = new Set<string>(keys);

  const removed = existing.filter((e) => !want.has(e.factKey)).map((e) => e.factKey);
  if (removed.length) {
    await db.delete(outputFacts).where(and(eq(outputFacts.outputId, outputId), inArray(outputFacts.factKey, removed)));
  }

  const added = keys.filter((k) => !have.has(k));
  if (!added.length) return;
  const nos = added.map((k) => Number(k.slice("FACT-".length)));
  const found = await db
    .select({ id: facts.id, no: facts.no, text: facts.text })
    .from(facts)
    .where(and(eq(facts.userId, deps.userId), inArray(facts.no, nos)));
  if (!found.length) return;
  await db.insert(outputFacts).values(
    found.map((f) => ({
      outputId,
      factKey: factKey(f.no),
      userId: deps.userId,
      factId: f.id,
      factText: f.text,
    })),
  );
}

export async function updateOutput(
  deps: Deps,
  { outputId, ...input }: { outputId: OutputId } & UpdateOutputInput,
): Promise<WorkspaceDto> {
  const { output, status } = await loadOutput(deps, outputId);
  assertEditable(status);
  await deps.db.transaction(async (tx) => {
    const patch: Partial<typeof outputs.$inferInsert> = {};
    if (input.included !== undefined) patch.included = input.included;
    if (input.body !== undefined) {
      patch.body = input.body;
      patch.editedAt = deps.clock.now();
      // A new body has not been reviewed (Task 6, docs/plans/chrome-extension.md).
      patch.reviewedAt = null;
      // Edits re-run the style check without AI so the warnings stay current (section 3.4, step 4a).
      patch.styleHits = input.body === null ? [] : checkStyle(input.body);
    }
    await tx.update(outputs).set(patch).where(eq(outputs.id, outputId));
    if (input.body !== undefined) await syncCitations(tx, deps, outputId, input.body);
  });
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

export async function addQuestion(
  deps: Deps,
  { opportunityId, question }: { opportunityId: OpportunityId } & AddQuestionInput,
): Promise<WorkspaceDto> {
  const { opportunity } = await loadOpportunity(deps, opportunityId);
  assertEditable(opportunity.status);
  const [last] = await deps.db
    .select({ position: max(outputs.position) })
    .from(outputs)
    .where(eq(outputs.opportunityId, opportunityId));
  await deps.db.insert(outputs).values({
    userId: deps.userId,
    opportunityId,
    kind: "answer",
    question,
    mustAnswer: classifyQuestion(question),
    position: (last?.position ?? 0) + 1,
  });
  return getWorkspace(deps, { opportunityId });
}

// ---------- Suggest questions (section 3.4, decision 23) ----------

const questionKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Insert suggested questions as answers with `included = false`, skipping any the job already has.
 * Each goes through `classifyQuestion`, so a salary or visa question is must-answer and never drafted.
 * Runs in one transaction with the opportunity locked, and refuses if it was marked applied meanwhile.
 */
async function insertSuggested(
  deps: Deps,
  { opportunityId, questions }: { opportunityId: OpportunityId; questions: readonly string[] },
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: opportunities.status })
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId))
      .for("update");
    if (!locked) throw notFound("That job");
    assertEditable(locked.status);
    const existing = await tx
      .select({ question: outputs.question, position: outputs.position })
      .from(outputs)
      .where(eq(outputs.opportunityId, opportunityId));
    const have = new Set(existing.flatMap((o) => (o.question === null ? [] : [questionKey(o.question)])));
    const fresh = questions.filter((q) => !have.has(questionKey(q)));
    if (fresh.length === 0) return 0;
    const start = Math.max(0, ...existing.map((o) => o.position)) + 1;
    await tx.insert(outputs).values(
      fresh.map((question, i) => ({
        userId: deps.userId,
        opportunityId,
        kind: "answer" as const,
        question,
        included: false,
        mustAnswer: classifyQuestion(question),
        position: start + i,
      })),
    );
    return fresh.length;
  });
}

/**
 * `POST /api/opportunities/:id/suggest-questions`: check the cap for one light-tier call, then
 * start a `suggest_questions` task that reads the posting and adds what it finds, unticked.
 */
export async function startSuggestQuestions(
  deps: Deps,
  { opportunityId, confirmOverCap = false }: { opportunityId: OpportunityId; confirmOverCap?: boolean },
): Promise<TaskDto> {
  const { opportunity, job } = await loadOpportunity(deps, opportunityId);
  assertEditable(opportunity.status);
  const running = await latestTask(deps, { kind: "suggest_questions", inputMatches: { opportunityId } });
  if (running?.task.status === "running") {
    throw new AppError({
      code: "invalid_input",
      message: "Already looking for questions in this posting. Wait for it to finish.",
    });
  }
  const config = await requireAiConfig(deps);
  const prompt = buildQuestionsPrompt({
    posting: { title: job.title, company: job.company, description: job.description },
  });
  await checkCap(deps, {
    capUsd: config.capUsd,
    estimateUsd: estimateUsd({ model: config.models.light, prompt, maxOutputTokens: QUESTIONS_MAX_TOKENS }),
    confirmOverCap,
  });

  const input: SuggestQuestionsTaskInput = { opportunityId };
  return startTask(deps, {
    kind: "suggest_questions",
    input,
    run: async (ctx): Promise<SuggestQuestionsResult> => {
      await ctx.step("Reading the posting for questions");
      const { text } = await runAi(deps, {
        tier: "light",
        purpose: "questions",
        taskId: ctx.taskId,
        prompt,
        maxOutputTokens: QUESTIONS_MAX_TOKENS,
        confirmOverCap,
      });
      const questions = parseQuestionsReply(text);
      if (questions === null) {
        throw new AppError({
          code: "ai_unavailable",
          message: `The ${config.models.light} reply could not be read as a list of questions. Retry, or add questions by hand.`,
        });
      }
      await ctx.step(`Adding ${questions.length} question${questions.length === 1 ? "" : "s"}`);
      const added = await insertSuggested(deps, { opportunityId, questions });
      return { found: questions.length, added };
    },
  });
}

/** Retry handler for `suggest_questions` tasks. */
export async function retrySuggestQuestions(
  deps: Deps,
  input: unknown,
  { confirmOverCap }: { confirmOverCap: boolean },
): Promise<TaskDto> {
  const parsed = SuggestQuestionsTaskInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError({
      code: "invalid_input",
      message: "This task's input is unreadable. Click Suggest questions again instead.",
    });
  }
  return startSuggestQuestions(deps, { ...parsed.data, confirmOverCap });
}

export async function deleteQuestion(deps: Deps, { outputId }: { outputId: OutputId }): Promise<WorkspaceDto> {
  const { output, status } = await loadOutput(deps, outputId);
  assertEditable(status);
  if (output.kind !== "answer") {
    throw new AppError({ code: "invalid_input", message: "Files can be unticked, not deleted." });
  }
  await deps.db.delete(outputs).where(eq(outputs.id, outputId));
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

function needsInput(gate: Extract<GateResult, { ok: false }>): AppError {
  return new AppError({
    code: "needs_input",
    message: "This job still needs your input. Fix the items listed, then try again.",
    details: gate.blockers,
  });
}

/**
 * "Mark reviewed": the user read this body and stands by it. Prefill fills a generated answer only
 * once it is reviewed and not redrafted or edited since (both clear `reviewed_at`).
 *
 * `body` is the text the user was shown; `shown` turns the stored body into that view (the web
 * shows it as stored, the panel shows the fill text). The row is locked and compared in one
 * transaction, so an edit or redraft that landed after the user read it is refused, never marked.
 */
export async function markReviewed(
  deps: Deps,
  {
    outputId,
    body,
    shown = (stored) => stored,
  }: { outputId: OutputId; body: string; shown?: (stored: string) => string },
): Promise<WorkspaceDto> {
  const { output } = await loadOutput(deps, outputId);
  await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ body: outputs.body })
      .from(outputs)
      .where(and(eq(outputs.id, outputId), eq(outputs.userId, deps.userId)))
      .for("update");
    if (!locked) throw notFound("That file or answer");
    const stored = locked.body ?? "";
    if (shown(stored) !== body) {
      throw new AppError({
        code: "output_changed",
        message: "This text changed since you opened it. Read the new version, then mark it reviewed.",
      });
    }
    if (stored.trim() === "") {
      throw new AppError({
        code: "invalid_input",
        message: `${outputKindLabel(output.kind)} is empty. Draft or write it, then mark it reviewed.`,
      });
    }
    await tx.update(outputs).set({ reviewedAt: deps.clock.now() }).where(eq(outputs.id, outputId));
  });
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

/** Every output of one of this user's opportunities, as the workspace shows them (bodies included). */
export async function listOutputs(
  deps: Deps,
  { opportunityId }: { opportunityId: OpportunityId },
): Promise<OutputDto[]> {
  const { opportunity } = await loadOpportunity(deps, opportunityId);
  const [{ standardAnswers }, loaded] = await Promise.all([loadContact(deps), loadOutputs(deps.db, opportunityId)]);
  const frozen = isFrozen(opportunity.status);
  return loaded.map((o) => toOutputDto(o, standardAnswers, frozen));
}

/** The opportunity an output of this user belongs to; 404 when there is no such output. */
export async function outputOpportunity(deps: Deps, { outputId }: { outputId: OutputId }): Promise<OpportunityId> {
  return (await loadOutput(deps, outputId)).output.opportunityId;
}

export async function markReady(
  deps: Deps,
  { opportunityId }: { opportunityId: OpportunityId },
): Promise<{ ready: true }> {
  await loadOpportunity(deps, opportunityId);
  const gate = await gateFor(deps, opportunityId);
  if (!gate.ok) throw needsInput(gate);
  await deps.db.update(opportunities).set({ readyAt: deps.clock.now() }).where(eq(opportunities.id, opportunityId));
  return { ready: true };
}

/** Gate, then the marker-free text of one included output. Shared by PDF and Copy as text. */
async function exportableText(deps: Deps, outputId: OutputId) {
  const { output } = await loadOutput(deps, outputId);
  if (!output.included) {
    throw new AppError({
      code: "not_exportable",
      message: `${outputKindLabel(output.kind)} is unticked. Tick it to include it, then export.`,
    });
  }
  const gate = await gateFor(deps, output.opportunityId);
  if (!gate.ok) throw needsInput(gate);
  const [{ contact, standardAnswers }, repos] = await Promise.all([loadContact(deps), privateGithubRepos(deps)]);
  const body = output.body ?? (output.mustAnswer ? standardAnswers[output.mustAnswer] : undefined) ?? "";
  // A private repo's facts may be drafted from, but its repo and commit URLs never leave the app
  // (decision 55): not in the text, and not in the contact line of a PDF.
  return {
    output,
    contact: { ...contact, links: contact.links.filter((link) => !isPrivateGithubUrl({ link, repos })) },
    text: stripPrivateGithubUrls({ text: stripMarkers(body), repos }).trim(),
  };
}

export async function exportText(deps: Deps, { outputId }: { outputId: OutputId }): Promise<{ text: string }> {
  const { text } = await exportableText(deps, outputId);
  return { text };
}

export async function exportPdf(
  deps: Deps,
  { outputId }: { outputId: OutputId },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const { output, contact, text } = await exportableText(deps, outputId);
  const kind = PDF_KINDS.find((k) => k === output.kind);
  if (kind === undefined) {
    throw new AppError({
      code: "not_exportable",
      message: `${outputKindLabel(output.kind)} exports as text only. Use Copy as text.`,
    });
  }
  const { job } = await loadOpportunity(deps, output.opportunityId);
  const label = outputKindLabel(kind);
  const bytes = await deps.pdf.render({ contact, title: `${label} · ${job.company}`, body: text });
  const name = [contact.fullName || "Application", job.company, label]
    .join(" - ")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "")
    .trim();
  return { bytes, filename: `${name}.pdf` };
}

// ---------- Drafting (section 3.4) ----------

type DraftFactRow = PromptFact & { id: FactId };

/** Confirmed facts with their item's link and usage, in key order. */
async function loadDraftFacts(deps: Pick<Deps, "db" | "userId">): Promise<DraftFactRow[]> {
  const rows = await deps.db
    .select({
      id: facts.id,
      no: facts.no,
      text: facts.text,
      link: profileItems.link,
      usage: profileItems.usage,
      githubPrivate: profileItems.githubPrivate,
      evidence: facts.evidence,
    })
    .from(facts)
    .innerJoin(profileItems, eq(profileItems.id, facts.itemId))
    .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")))
    .orderBy(asc(facts.no));
  return rows.map((r) => ({
    id: r.id,
    key: factKey(r.no),
    text: r.text,
    // A private repo's link is not offered to the drafter; the export filter is the backstop.
    link: r.githubPrivate === true || r.evidence?.private === true ? null : r.link,
    usage: r.usage,
  }));
}

function mustAnswerRefusal(output: Pick<OutputRow, "question">): AppError {
  return new AppError({
    code: "must_answer",
    message: `"${output.question ?? "This question"}" is yours to answer. Write it yourself, or set a standard answer in Profile.`,
  });
}

/** Everything one output's prompt needs, read fresh at the moment of drafting. */
async function draftContext(
  deps: Deps,
  { opportunityId, output }: { opportunityId: OpportunityId; output: OutputRow },
) {
  const [{ opportunity, job }, { contact }, all] = await Promise.all([
    loadOpportunity(deps, opportunityId),
    loadContact(deps),
    loadDraftFacts(deps),
  ]);
  const allowed = allowedFacts({ kind: output.kind, facts: all });
  const prompt = buildDraftPrompt({
    kind: output.kind,
    opportunityType: opportunity.type,
    posting: { title: job.title, company: job.company, description: job.description },
    candidateName: contact.fullName,
    facts: allowed,
    question: output.question,
  });
  const check = (body: string) =>
    checkDraft({
      body,
      facts: allowed,
      allowedKeys: allowed.map((f) => f.key),
      posting: { company: job.company, title: job.title },
      contact,
    });
  return { opportunity, allowed, prompt, check };
}

const StyleRewriteReply = z.object({ rewrites: z.array(z.string()) });

function parseRewrites(text: string, count: number): string[] | null {
  try {
    const parsed = StyleRewriteReply.safeParse(JSON.parse(cleanModelText(text)));
    return parsed.success && parsed.data.rewrites.length === count ? parsed.data.rewrites : null;
  } catch {
    return null;
  }
}

/** Swap whole sentences in `body`. Each original is matched to its first unused span. */
function replaceSentences(body: string, swaps: ReadonlyMap<string, string>): string {
  const used = new Set<number>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const span of sentenceSpans(body)) {
    const next = swaps.get(span.text);
    if (next === undefined || used.has(span.start)) continue;
    used.add(span.start);
    edits.push({ start: span.start, end: span.end, text: next });
  }
  let out = body;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Draft one output: prompt, check, one retry, quarantine, one style rewrite, save. */
async function draftOne(
  deps: Deps,
  ctx: TaskContext,
  { outputId, confirmOverCap, label }: { outputId: OutputId; confirmOverCap: boolean; label: string },
): Promise<void> {
  const { output, status } = await loadOutput(deps, outputId);
  assertEditable(status);
  if (output.mustAnswer !== null) throw mustAnswerRefusal(output);
  const { allowed, prompt, check } = await draftContext(deps, { opportunityId: output.opportunityId, output });
  const ai = (p: typeof prompt) =>
    runAi(deps, {
      tier: "writing",
      purpose: "draft",
      taskId: ctx.taskId,
      prompt: p,
      maxOutputTokens: DRAFT_MAX_TOKENS[output.kind],
      confirmOverCap,
    });

  // Steps 2 to 4: draft, check, retry once with the violations, then quarantine what still fails.
  const first = await ai(prompt);
  let body = cleanModelText(first.text);
  let aiCallId = first.aiCallId;
  let result = check(body);
  if (!result.ok) {
    await ctx.step(`Checking ${label} against your facts`);
    const retry = await ai(buildRetryPrompt({ prompt, draft: body, violations: result.violations }));
    body = cleanModelText(retry.text);
    aiCallId = retry.aiCallId;
    result = check(body);
    if (!result.ok) body = quarantineViolations({ body, violations: result.violations });
  }

  // Step 4a: one rewrite of the flagged sentences. A rewrite that fails checkDraft is discarded.
  const hits = checkStyle(body);
  if (hits.length > 0) {
    await ctx.step(`Tidying the wording of ${label}`);
    const sentences = [...new Set(hits.map((h) => h.sentence))].map((sentence) => ({
      sentence,
      hits: hits.filter((h) => h.sentence === sentence),
    }));
    const reply = await ai(buildStyleRewritePrompt({ sentences, facts: allowed }));
    const rewrites = parseRewrites(reply.text, sentences.length) ?? [];
    const swaps = new Map<string, string>();
    rewrites.forEach((rewrite, i) => {
      const original = sentences[i]?.sentence;
      const text = rewrite.trim();
      if (original !== undefined && text !== "" && check(text).ok) swaps.set(original, text);
    });
    body = replaceSentences(body, swaps);
  }

  // Step 5: save body, ai_call_id, generated_at, style hits and fresh citation snapshots.
  const byKey = new Map<string, DraftFactRow>(allowed.map((f) => [f.key, f]));
  const cited = parseCitations(body).flatMap((key) => {
    const fact = byKey.get(key);
    return fact ? [fact] : [];
  });
  await deps.db.transaction(async (tx) => {
    await tx
      .update(outputs)
      .set({
        body,
        aiCallId,
        generatedAt: deps.clock.now(),
        editedAt: null,
        reviewedAt: null,
        styleHits: checkStyle(body),
      })
      .where(eq(outputs.id, outputId));
    await tx.delete(outputFacts).where(eq(outputFacts.outputId, outputId));
    if (cited.length) {
      await tx
        .insert(outputFacts)
        .values(cited.map((f) => ({ outputId, factKey: f.key, userId: deps.userId, factId: f.id, factText: f.text })));
    }
  });
}

/** Which outputs a draft request targets: one output, some kinds, or every included file. */
async function draftTargets(
  deps: Deps,
  {
    opportunityId,
    kinds,
    outputIds,
  }: { opportunityId: OpportunityId; kinds?: readonly OutputKind[]; outputIds?: readonly OutputId[] },
): Promise<OutputRow[]> {
  const rows = (await loadOutputs(deps.db, opportunityId)).map((o) => o.row);
  if (outputIds !== undefined) return rows.filter((r) => outputIds.includes(r.id));
  const wanted: readonly OutputKind[] = kinds ?? FILE_KINDS;
  return rows.filter((r) => r.included && wanted.includes(r.kind));
}

/**
 * `POST /api/opportunities/:id/draft`: refuse frozen and must-answer targets, check the cap
 * against an estimate for every target, then start a `draft` task (section 3.4).
 */
export async function startDraft(
  deps: Deps,
  {
    opportunityId,
    kinds,
    outputIds,
    confirmOverCap = false,
  }: {
    opportunityId: OpportunityId;
    kinds?: readonly OutputKind[];
    outputIds?: readonly OutputId[];
    confirmOverCap?: boolean;
  },
): Promise<TaskDto> {
  const { opportunity } = await loadOpportunity(deps, opportunityId);
  assertEditable(opportunity.status);
  const targets = await draftTargets(deps, {
    opportunityId,
    ...(kinds ? { kinds } : {}),
    ...(outputIds ? { outputIds } : {}),
  });
  const [first, ...rest] = targets;
  if (!first) {
    throw new AppError({ code: "invalid_input", message: "Nothing to draft. Tick a file, then draft again." });
  }
  const mustAnswer = targets.find((t) => t.mustAnswer !== null);
  if (mustAnswer) throw mustAnswerRefusal(mustAnswer);

  const running = await latestTask(deps, { kind: "draft", inputMatches: { opportunityId } });
  if (running?.task.status === "running") {
    throw new AppError({
      code: "invalid_input",
      message: "A draft is already running for this job. Wait for it to finish.",
    });
  }

  const config = await requireAiConfig(deps);
  let estimate = 0;
  for (const output of targets) {
    const { prompt } = await draftContext(deps, { opportunityId, output });
    estimate += estimateUsd({ model: config.models.writing, prompt, maxOutputTokens: DRAFT_MAX_TOKENS[output.kind] });
  }
  await checkCap(deps, { capUsd: config.capUsd, estimateUsd: estimate, confirmOverCap });

  const input: DraftTaskInput = { opportunityId, outputIds: [first.id, ...rest.map((t) => t.id)] };
  return startTask(deps, {
    kind: "draft",
    input,
    run: async (ctx) => {
      for (const [i, outputId] of input.outputIds.entries()) {
        const output = targets.find((t) => t.id === outputId);
        const label = output ? outputKindLabel(output.kind).toLowerCase() : "output";
        const of = input.outputIds.length > 1 ? ` (${i + 1} of ${input.outputIds.length})` : "";
        await ctx.step(`Drafting ${label}${of}`);
        await draftOne(deps, ctx, { outputId, confirmOverCap, label });
      }
      return { outputIds: input.outputIds };
    },
  });
}

/** The request body form of `startDraft`, with `outputId` checked against the opportunity. */
export async function draft(
  deps: Deps,
  { opportunityId, kinds, outputId, confirmOverCap }: { opportunityId: OpportunityId } & DraftInput,
): Promise<TaskDto> {
  if (outputId !== undefined) {
    const { output } = await loadOutput(deps, outputId);
    if (output.opportunityId !== opportunityId) throw notFound("That file or answer");
  }
  return startDraft(deps, {
    opportunityId,
    ...(kinds ? { kinds } : {}),
    ...(outputId ? { outputIds: [outputId] } : {}),
    confirmOverCap: confirmOverCap ?? false,
  });
}

/** Retry handler for `draft` tasks: start again from the stored input. */
export async function retryDraft(deps: Deps, input: unknown, { confirmOverCap }: { confirmOverCap: boolean }) {
  const parsed = DraftTaskInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError({
      code: "invalid_input",
      message: "This task's input is unreadable. Start a new draft instead.",
    });
  }
  return startDraft(deps, { ...parsed.data, confirmOverCap });
}

/** "Mark up to date": refresh this output's snapshots to the facts' current text. */
export async function markOutputCurrent(deps: Deps, { outputId }: { outputId: OutputId }): Promise<WorkspaceDto> {
  const { output, status } = await loadOutput(deps, outputId);
  assertEditable(status);
  await deps.db.execute(sql`
    UPDATE ${outputFacts} SET fact_text = f.text
    FROM ${facts} f
    WHERE ${outputFacts.outputId} = ${outputId} AND ${outputFacts.factId} = f.id`);
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}
