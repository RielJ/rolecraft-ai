import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { baseHash, isUsableBase, mapFactsToLines, parseBaseCv } from "@/domain/base-cv";
import {
  checkDraft,
  factKey,
  findPlaceholders,
  parseCitations,
  quarantineViolations,
  stripMarkers,
} from "@/domain/citations";
import { cleanForEdit, fillBlanks, restoreMarkers, stripLeadingName, toPlainText } from "@/domain/file-text";
import { checkGate, type GateOutput } from "@/domain/gate";
import { classifyQuestion } from "@/domain/must-answer";
import {
  allowedFacts,
  buildDraftPrompt,
  buildQuestionsPrompt,
  buildRetryPrompt,
  buildStyleRewritePrompt,
  buildTailorPrompt,
  buildTailorRetryPrompt,
  cleanModelText,
  DRAFT_MAX_TOKENS,
  type PromptFact,
  QUESTIONS_MAX_TOKENS,
  TAILOR_MAX_TOKENS,
} from "@/domain/prompts";
import {
  buildRequirementsPrompt,
  REQUIREMENTS_MAX_TOKENS,
  requiredResumeFacts,
  requirementMapSource,
  restrictRequirementMap,
  selectResumeFacts,
} from "@/domain/requirements";
import { checkStyle } from "@/domain/style";
import {
  applyEdits,
  changedText,
  type Tailoring,
  type TailorOp,
  tailoringView,
  validateEdits,
  worthRetry,
} from "@/domain/tailor";
import { sentenceSpans, wordCount } from "@/domain/text";
import { type DraftRole, expandRoles, roleHeader } from "@/domain/work-roles";
import {
  type AddQuestionInput,
  type Contact,
  type ContractTerms,
  type DecideChangesInput,
  type DraftInput,
  DraftTaskInput,
  type FactId,
  type FactKey,
  type FillBlanksInput,
  type GateResult,
  type OpportunityId,
  type OutdatedChange,
  type OutputDto,
  type OutputId,
  type RoleId,
  type StandardAnswers,
  SuggestQuestionsResult,
  SuggestQuestionsTaskInput,
  type TaskDto,
  type UpdateOutputInput,
  type WorkspaceDto,
} from "@/shared/api";
import { parseBlank } from "@/shared/blanks";
import {
  type FactStatus,
  FILE_KINDS,
  FROZEN_STATUSES,
  type ItemUsage,
  type OpportunityStatus,
  type OutputKind,
  PDF_KINDS,
} from "@/shared/enums";
import { type GithubRepoRef, isPrivateGithubUrl, stripPrivateGithubUrls } from "@/shared/github-link";
import { outputKindLabel } from "@/shared/labels";
import type { PdfDocument } from "../adapters/pdf";
import type { DbOrTx } from "../db/client";
import { facts, jobs, opportunities, outputFacts, outputs, profileItems } from "../db/schema";
import { checkCap, estimateUsd, loadAiConfig, requireAiConfig, runAi } from "./ai";
import { parseQuestionsReply, parseTailorReply } from "./ai-replies";
import { AppError, type Deps, notFound } from "./context";
import { privateGithubRepos } from "./github";
import { jobFacts } from "./jobs";
import { loadContact, saveDraftingFacts } from "./profile";
import { buildRequirementMap, requirementMapKey } from "./requirements";
import { loadDraftRoles } from "./roles";
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

/** What leaving the app removes, for every outgoing form of a body (decision 55, clean-files). */
type Outgoing = { name: string; repos: readonly GithubRepoRef[] };

/**
 * A body as it leaves the app, still in the Markdown subset the PDF reads: no markers, no first
 * `# name` line (the PDF header prints the name), and no private repo links (decision 55). Blanks
 * stay; the gate keeps them out of exports, and the preview shows them as boxes.
 */
function outgoingText(body: string, { name, repos }: Outgoing): string {
  return stripPrivateGithubUrls({ text: stripLeadingName({ body: stripMarkers(body), name }), repos }).trim();
}

/** The contact header of a PDF: a private repo's link never leaves the app (decision 55). */
function pdfContact(contact: Contact, repos: readonly GithubRepoRef[]): Contact {
  return { ...contact, links: contact.links.filter((link) => !isPrivateGithubUrl({ link, repos })) };
}

type DtoContext = {
  standardAnswers: StandardAnswers;
  frozen: boolean;
  /** Hash of the CV as it is now, for "Your CV changed" (decision 75). */
  cvHash: string | null;
} & Outgoing;

/** The current CV's hash, read only when an output was tailored from one (decision 75). */
async function cvHashFor(deps: Deps, loaded: readonly { row: OutputRow }[]): Promise<string | null> {
  if (!loaded.some((o) => o.row.tailoring !== null)) return null;
  const [cv] = await deps.db
    .select({ body: profileItems.body })
    .from(profileItems)
    .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
  return cv ? baseHash(cv.body) : null;
}

function toOutputDto(
  { row, citations }: { row: OutputRow; citations: Citation[] },
  { standardAnswers, frozen, cvHash, ...outgoing }: DtoContext,
): OutputDto {
  const plain = row.body === null ? null : toPlainText(outgoingText(row.body, outgoing));
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
    text: row.body === null ? null : cleanForEdit(row.body),
    plain,
    words: plain === null ? 0 : wordCount(plain),
    styleHits: row.styleHits,
    outdated: frozen ? [] : outdatedChanges(row.kind, citations),
    tailoring: row.tailoring ? tailoringView({ tailoring: row.tailoring, currentBaseHash: cvHash }) : null,
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
  const [{ contact, standardAnswers }, loaded, confirmed, aiConfig, draftTask, suggestTask, jobView, repos] =
    await Promise.all([
      loadContact(deps),
      loadOutputs(deps.db, opportunityId),
      deps.db
        .select({
          no: facts.no,
          text: facts.text,
          section: facts.section,
          itemKind: profileItems.kind,
          itemTitle: profileItems.title,
        })
        .from(facts)
        .innerJoin(profileItems, eq(profileItems.id, facts.itemId))
        .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")))
        .orderBy(asc(facts.no)),
      loadAiConfig(deps),
      latestTask(deps, { kind: "draft", inputMatches: { opportunityId } }),
      latestTask(deps, { kind: "suggest_questions", inputMatches: { opportunityId } }),
      jobFacts(deps, job),
      privateGithubRepos(deps),
    ]);
  const gate = checkGate({ outputs: loaded.map(toGateOutput), standardAnswers });
  const cvHash = await cvHashFor(deps, loaded);
  const dtos = loaded.map((o) => toOutputDto(o, { standardAnswers, frozen, cvHash, name: contact.fullName, repos }));
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
    // Grouped like Profile's confirmed facts: the section, else the add-on; CV facts with neither are "Other".
    facts: confirmed.map((f) => ({
      key: factKey(f.no),
      text: f.text,
      group: f.section ?? (f.itemKind === "cv" ? null : f.itemTitle),
    })),
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
    let next: string | null | undefined = input.body;
    if (input.text !== undefined) {
      // A clean edit: sentences the user left as they were get their markers back (clean-files).
      const [locked] = await tx
        .select({ body: outputs.body })
        .from(outputs)
        .where(eq(outputs.id, outputId))
        .for("update");
      next = input.text.trim() === "" ? null : restoreMarkers({ before: locked?.body ?? "", edited: input.text });
    }
    if (next !== undefined) {
      patch.body = next;
      patch.editedAt = deps.clock.now();
      // A new body has not been reviewed (Task 6, docs/plans/chrome-extension.md).
      patch.reviewedAt = null;
      // Edits re-run the style check without AI so the warnings stay current (section 3.4, step 4a).
      patch.styleHits = next === null ? [] : checkStyle({ body: next, kind: output.kind });
      // The body is the user's own now, so there are no changes left to keep or undo (decision 75).
      patch.tailoring = null;
    }
    await tx.update(outputs).set(patch).where(eq(outputs.id, outputId));
    if (next !== undefined) await syncCitations(tx, deps, outputId, next);
  });
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

/**
 * `POST /api/outputs/:id/changes`: keep or undo changes of a tailored resume (decision 75). The
 * body is derived again from the CV and every kept change, in one transaction with its citations
 * and style hits; review is cleared. Every id must be a change of this output's current tailoring.
 */
export async function decideChanges(
  deps: Deps,
  { outputId, ids, status }: { outputId: OutputId } & DecideChangesInput,
): Promise<WorkspaceDto> {
  const { output, status: opportunityStatus } = await loadOutput(deps, outputId);
  assertEditable(opportunityStatus);
  await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ tailoring: outputs.tailoring })
      .from(outputs)
      .where(eq(outputs.id, outputId))
      .for("update");
    const tailoring = locked?.tailoring;
    const known = new Set((tailoring?.changes ?? []).map((c) => c.id));
    if (!tailoring || ids.some((id) => !known.has(id))) {
      throw new AppError({
        code: "output_changed",
        message: "This resume changed since you opened it, and a change you picked is gone. Check the new version.",
      });
    }
    const picked = new Set(ids);
    const changes = tailoring.changes.map((c) => (picked.has(c.id) ? { ...c, status } : c));
    await saveTailoring(tx, deps, { outputId, tailoring: { ...tailoring, changes } });
  });
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

/**
 * `POST /api/outputs/:id/fill`: the "Needs your input" form. Answers replace their blanks, removed
 * Check this sentences go, and the result saves like an edit (edited, review cleared, style
 * re-checked). Answers to missing-info blanks with `saveAsFact` are also kept as confirmed facts,
 * "blank: answer", in the same transaction. Every blank named must still be in the body.
 */
export async function fillOutputBlanks(
  deps: Deps,
  { outputId, answers, remove }: { outputId: OutputId } & FillBlanksInput,
): Promise<WorkspaceDto> {
  const { output, status } = await loadOutput(deps, outputId);
  assertEditable(status);
  await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ body: outputs.body })
      .from(outputs)
      .where(eq(outputs.id, outputId))
      .for("update");
    const body = locked?.body ?? "";
    const present = new Set(findPlaceholders(body));
    if ([...answers.map((a) => a.blank), ...remove].some((blank) => !present.has(blank))) {
      throw new AppError({
        code: "output_changed",
        message: "This text changed since you opened it, and a blank you filled is gone. Check the new version.",
      });
    }
    const next = fillBlanks({ body, answers, remove });
    await tx
      .update(outputs)
      .set({
        body: next,
        editedAt: deps.clock.now(),
        reviewedAt: null,
        styleHits: checkStyle({ body: next, kind: output.kind }),
        tailoring: null,
      })
      .where(eq(outputs.id, outputId));
    await syncCitations(tx, deps, outputId, next);
    const lines = answers.flatMap((a) => {
      const blank = parseBlank(a.blank);
      return a.saveAsFact && blank.kind === "missing" ? [`${blank.label}: ${a.value.replace(/\s+/g, " ").trim()}`] : [];
    });
    if (lines.length) await saveDraftingFacts(tx, deps, { lines });
  });
  return getWorkspace(deps, { opportunityId: output.opportunityId });
}

/** One output's PDF document, as the preview, the export and the page count render it. */
async function pdfDocument(
  deps: Deps,
  { output, body }: { output: OutputRow; body: string },
): Promise<{ doc: PdfDocument; filename: string }> {
  const [{ contact }, repos, { job }] = await Promise.all([
    loadContact(deps),
    privateGithubRepos(deps),
    loadOpportunity(deps, output.opportunityId),
  ]);
  const label = outputKindLabel(output.kind);
  const name = [contact.fullName || "Application", job.company, label]
    .join(" - ")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "")
    .trim();
  return {
    doc: {
      contact: pdfContact(contact, repos),
      title: `${label} · ${job.company}`,
      body: outgoingText(body, { name: contact.fullName, repos }),
    },
    filename: `${name}.pdf`,
  };
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
  const [{ contact, standardAnswers }, loaded, repos] = await Promise.all([
    loadContact(deps),
    loadOutputs(deps.db, opportunityId),
    privateGithubRepos(deps),
  ]);
  const frozen = isFrozen(opportunity.status);
  const cvHash = await cvHashFor(deps, loaded);
  return loaded.map((o) => toOutputDto(o, { standardAnswers, frozen, cvHash, name: contact.fullName, repos }));
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

function refuseUnticked(output: OutputRow, then: string): void {
  if (output.included) return;
  throw new AppError({
    code: "not_exportable",
    message: `${outputKindLabel(output.kind)} is unticked. Tick it to include it, then ${then}.`,
  });
}

function refuseTextOnly(output: OutputRow): void {
  if (PDF_KINDS.some((k) => k === output.kind)) return;
  throw new AppError({
    code: "not_exportable",
    message: `${outputKindLabel(output.kind)} exports as text only. Use Copy text.`,
  });
}

/** Gate, then the body of one included output (a must-answer falls back to the profile answer). */
async function exportableBody(deps: Deps, outputId: OutputId) {
  const { output } = await loadOutput(deps, outputId);
  refuseUnticked(output, "export");
  const gate = await gateFor(deps, output.opportunityId);
  if (!gate.ok) throw needsInput(gate);
  const { standardAnswers } = await loadContact(deps);
  const body = output.body ?? (output.mustAnswer ? standardAnswers[output.mustAnswer] : undefined) ?? "";
  return { output, body };
}

/** Copy text: "content only" (toPlainText), with no name line and no private repo links. */
export async function exportText(deps: Deps, { outputId }: { outputId: OutputId }): Promise<{ text: string }> {
  const { body } = await exportableBody(deps, outputId);
  const [{ contact }, repos] = await Promise.all([loadContact(deps), privateGithubRepos(deps)]);
  return { text: toPlainText(outgoingText(body, { name: contact.fullName, repos })) };
}

export async function exportPdf(
  deps: Deps,
  { outputId }: { outputId: OutputId },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const { output, body } = await exportableBody(deps, outputId);
  refuseTextOnly(output);
  const { doc, filename } = await pdfDocument(deps, { output, body });
  return { bytes: await deps.pdf.render(doc), filename };
}

/**
 * The preview PDF: not gated, so it works while blanks remain, and each blank shows as a
 * highlighted box. The output must be included and written. Works on applied jobs too.
 */
export async function previewPdf(
  deps: Deps,
  { outputId }: { outputId: OutputId },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const { output } = await loadOutput(deps, outputId);
  refuseUnticked(output, "preview it");
  refuseTextOnly(output);
  if (output.body === null || output.body.trim() === "") {
    throw new AppError({
      code: "not_exportable",
      message: `${outputKindLabel(output.kind)} is empty. Draft or write it, then preview it.`,
    });
  }
  const { doc, filename } = await pdfDocument(deps, { output, body: output.body });
  return { bytes: await deps.pdf.render(doc), filename };
}

// ---------- Drafting (section 3.4) ----------

type DraftFactRow = PromptFact & { id: FactId; roleId: RoleId | null };

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
      roleId: facts.roleId,
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
    roleId: r.roleId,
  }));
}

/**
 * A resume's roles (decision 71): those with at least one fact the resume may use, keyed ROLE-1,
 * ROLE-2 in draft order, and the facts marked with their role's key. Other kinds get none.
 */
async function draftRoles(
  deps: Pick<Deps, "db" | "userId">,
  { kind, allowed }: { kind: OutputKind; allowed: readonly DraftFactRow[] },
): Promise<{ roles: DraftRole[]; facts: DraftFactRow[] }> {
  if (kind !== "resume") return { roles: [], facts: [...allowed] };
  const used = new Set(allowed.flatMap((f) => (f.roleId ? [f.roleId] : [])));
  const kept = (await loadDraftRoles(deps)).filter((r) => used.has(r.id));
  const keyOf = new Map(kept.map((r, i) => [r.id, `ROLE-${i + 1}`]));
  return {
    roles: kept.map((r) => ({ ...r, key: keyOf.get(r.id) ?? "" })),
    facts: allowed.map((f) => ({ ...f, roleKey: f.roleId ? (keyOf.get(f.roleId) ?? null) : null })),
  };
}

function mustAnswerRefusal(output: Pick<OutputRow, "question">): AppError {
  return new AppError({
    code: "must_answer",
    message: `"${output.question ?? "This question"}" is yours to answer. Write it yourself, or set a standard answer in Profile.`,
  });
}

/**
 * The requirement map's inputs for one opportunity (decision 73): every confirmed fact with its
 * role, whatever the kind, so one map serves every file. `map` is the stored map when it was read
 * against this posting and these facts, else null and `prompt` reads it again.
 */
async function requirementMapState(
  deps: Deps,
  {
    opportunity,
    posting,
    all,
  }: {
    opportunity: typeof opportunities.$inferSelect;
    posting: { title: string; company: string; description: string };
    all: readonly DraftFactRow[];
  },
) {
  const { roles, facts } = await draftRoles(deps, { kind: "resume", allowed: all });
  const key = requirementMapKey(requirementMapSource({ posting, facts }));
  const map = opportunity.requirementMapKey === key ? opportunity.requirementMap : null;
  return { key, map, facts, prompt: buildRequirementsPrompt({ posting, facts, roles }) };
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
  const posting = { title: job.title, company: job.company, description: job.description };
  const requirements = await requirementMapState(deps, { opportunity, posting, all });
  const { roles, facts: kindFacts } = await draftRoles(deps, {
    kind: output.kind,
    allowed: allowedFacts({ kind: output.kind, facts: all }),
  });
  const map =
    requirements.map &&
    restrictRequirementMap({ map: requirements.map, allowedKeys: new Set(kindFacts.map((f) => f.key)) });
  // A resume is drafted from the facts that prove a requirement, plus one per role (decision 73).
  const allowed = output.kind === "resume" && map !== null ? selectResumeFacts({ map, facts: kindFacts }) : kindFacts;
  const required = output.kind === "resume" && map !== null ? requiredResumeFacts({ map, facts: allowed }) : [];
  const prompt = buildDraftPrompt({
    kind: output.kind,
    opportunityType: opportunity.type,
    posting,
    candidateName: contact.fullName,
    facts: allowed,
    question: output.question,
    roles,
    map,
    required,
  });
  const roleHeaders = roles.map((r) => ({ key: r.key, header: roleHeader(r) }));
  const check = (body: string) =>
    checkDraft({
      body,
      facts: allowed,
      allowedKeys: allowed.map((f) => f.key),
      posting: { company: job.company, title: job.title },
      contact,
      roles: roleHeaders,
    });
  /** The model writes `[ROLE-n]`; the server writes the header, so its words are the role's own. */
  const expand = (text: string) => expandRoles({ body: cleanModelText(text), roles });
  return { opportunity, allowed, prompt, check, expand, requirements, required };
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

// ---------- Tailoring the base CV (decision 75) ----------

/**
 * Everything a tailored resume needs, or null when the user has no CV the parser can use, in
 * which case the resume is generated from facts as before. Reads the stored requirement map, so
 * the map step runs first.
 */
async function tailorContext(deps: Deps, { opportunityId }: { opportunityId: OpportunityId }) {
  const [cv] = await deps.db
    .select({ id: profileItems.id, body: profileItems.body })
    .from(profileItems)
    .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
  if (!cv || cv.body.trim() === "") return null;
  const [{ opportunity, job }, { contact }, all, allRoles] = await Promise.all([
    loadOpportunity(deps, opportunityId),
    loadContact(deps),
    loadDraftFacts(deps),
    loadDraftRoles(deps),
  ]);
  const { facts: kindFacts } = await draftRoles(deps, {
    kind: "resume",
    allowed: allowedFacts({ kind: "resume", facts: all }),
  });
  // The CV's roles keep the keys the facts carry; a role no usable fact is in has none.
  const keyOf = new Map(kindFacts.flatMap((f) => (f.roleId && f.roleKey ? [[f.roleId, f.roleKey] as const] : [])));
  const roles = allRoles.filter((r) => r.itemId === cv.id).map((r) => ({ ...r, key: keyOf.get(r.id) ?? null }));
  const parsed = parseBaseCv({ text: cv.body, roles });
  if (!isUsableBase({ lines: parsed, roleCount: roles.length })) return null;
  const { lines: base } = mapFactsToLines({ lines: parsed, facts: kindFacts });

  const posting = { title: job.title, company: job.company, description: job.description };
  const { map: stored } = await requirementMapState(deps, { opportunity, posting, all });
  const map = stored && restrictRequirementMap({ map: stored, allowedKeys: new Set(kindFacts.map((f) => f.key)) });
  // Decision 74 carries over: a line holding a REQUIRED fact can't be removed.
  const protectedKeys = new Set(map ? requiredResumeFacts({ map, facts: kindFacts }) : []);
  const requirementIds = new Set((map?.requirements ?? []).map((r) => r.id));
  return {
    hash: baseHash(cv.body),
    base,
    map,
    prompt: buildTailorPrompt({ posting, base, facts: kindFacts, map, protectedKeys }),
    validate: (ops: readonly TailorOp[]) =>
      validateEdits({
        base,
        ops,
        facts: kindFacts,
        protectedKeys,
        requirementIds,
        posting: { company: job.company, title: job.title },
        contact,
      }),
  };
}

/**
 * Save a tailoring and the body it derives: style hits on the changed lines only, citations
 * synced (kept markers keep their snapshot), review cleared.
 */
async function saveTailoring(
  db: DbOrTx,
  deps: Deps,
  {
    outputId,
    tailoring,
    patch = {},
  }: { outputId: OutputId; tailoring: Tailoring; patch?: Partial<typeof outputs.$inferInsert> },
): Promise<void> {
  const body = applyEdits(tailoring);
  await db
    .update(outputs)
    .set({
      ...patch,
      body,
      tailoring,
      reviewedAt: null,
      styleHits: checkStyle({ body: changedText(tailoring), kind: "resume" }),
    })
    .where(eq(outputs.id, outputId));
  await syncCitations(db, deps, outputId, body);
}

/**
 * Tailor the resume from the base CV: one call for an edit list, one retry when edits were
 * dropped or the reply can't be read, then save the base with the edits that passed. When neither
 * reply can be read the CV is saved as it is, never generated from facts.
 */
async function tailorResume(
  deps: Deps,
  ctx: TaskContext,
  {
    outputId,
    t,
    confirmOverCap,
    label,
  }: {
    outputId: OutputId;
    t: NonNullable<Awaited<ReturnType<typeof tailorContext>>>;
    confirmOverCap: boolean;
    label: string;
  },
): Promise<void> {
  const ai = (prompt: typeof t.prompt) =>
    runAi(deps, {
      tier: "writing",
      purpose: "draft",
      taskId: ctx.taskId,
      prompt,
      maxOutputTokens: TAILOR_MAX_TOKENS,
      confirmOverCap,
    });
  const read = (text: string) => {
    const parsed = parseTailorReply(text);
    return parsed && { ...t.validate(parsed.ops), unreadable: parsed.unreadable };
  };
  const first = await ai(t.prompt);
  let aiCallId = first.aiCallId;
  let result = read(first.text);
  if (result === null || result.unreadable > 0 || worthRetry(result.dropped)) {
    await ctx.step(`Checking ${label} against your facts`);
    const retry = await ai(
      buildTailorRetryPrompt({
        prompt: t.prompt,
        reply: cleanModelText(first.text),
        dropped: result?.dropped ?? [],
        unreadable: result?.unreadable ?? 0,
      }),
    );
    // An unreadable retry keeps the first reply's edits that passed.
    const second = read(retry.text);
    if (second !== null) {
      result = second;
      aiCallId = retry.aiCallId;
    }
  }
  if (result === null) await ctx.step(`No changes could be read, so ${label} is your CV as it is`);
  const tailoring: Tailoring = {
    baseHash: t.hash,
    base: t.base,
    changes: result?.changes ?? [],
    dropped: result ? result.dropped.length + result.unreadable : 0,
    map: t.map,
  };
  await deps.db.transaction(async (tx) => {
    // A fresh draft takes fresh snapshots of every fact it cites.
    await tx.delete(outputFacts).where(eq(outputFacts.outputId, outputId));
    await saveTailoring(tx, deps, {
      outputId,
      tailoring,
      patch: { aiCallId, generatedAt: deps.clock.now(), editedAt: null },
    });
  });
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
  const before = await draftContext(deps, { opportunityId: output.opportunityId, output });
  // Step 1a: read the posting's requirements, once per posting and fact set (decision 73).
  if (before.requirements.map === null) {
    await ctx.step("Reading what the job asks for");
    await buildRequirementMap(deps, {
      opportunityId: output.opportunityId,
      prompt: before.requirements.prompt,
      facts: before.requirements.facts,
      key: before.requirements.key,
      taskId: ctx.taskId,
      confirmOverCap,
    });
  }
  // A resume starts from the user's own CV when there is one the parser can use (decision 75).
  if (output.kind === "resume") {
    const t = await tailorContext(deps, { opportunityId: output.opportunityId });
    if (t !== null) return tailorResume(deps, ctx, { outputId, t, confirmOverCap, label });
  }
  const { opportunity, allowed, prompt, check, expand, required } =
    before.requirements.map === null
      ? await draftContext(deps, { opportunityId: output.opportunityId, output })
      : before;
  const ai = (p: typeof prompt) =>
    runAi(deps, {
      tier: "writing",
      purpose: "draft",
      taskId: ctx.taskId,
      prompt: p,
      maxOutputTokens: DRAFT_MAX_TOKENS[output.kind],
      confirmOverCap,
    });

  // Steps 2 to 4: draft, check, retry once with the violations and any REQUIRED fact left out
  // (decision 74), then quarantine what still fails. Role keys expand to headers before the check;
  // the retry shows the model what it wrote. A required fact still missing after the retry is accepted.
  const first = await ai(prompt);
  let body = expand(first.text);
  let aiCallId = first.aiCallId;
  let result = check(body);
  const cited = (text: string) => new Set<string>(parseCitations(text));
  const firstCited = cited(body);
  const missing = required.filter((k) => !firstCited.has(k));
  if (!result.ok || missing.length > 0) {
    await ctx.step(`Checking ${label} against your facts`);
    const retry = await ai(
      buildRetryPrompt({
        prompt,
        draft: cleanModelText(first.text),
        violations: result.ok ? [] : result.violations,
        missing,
      }),
    );
    body = expand(retry.text);
    aiCallId = retry.aiCallId;
    result = check(body);
    if (!result.ok) body = quarantineViolations({ body, violations: result.violations });
  }

  // Step 4a: one rewrite of the flagged sentences. A rewrite that fails checkDraft is discarded.
  const hits = checkStyle({ body, kind: output.kind });
  if (hits.length > 0) {
    await ctx.step(`Tidying the wording of ${label}`);
    const sentences = [...new Set(hits.map((h) => h.sentence))].map((sentence) => ({
      sentence,
      hits: hits.filter((h) => h.sentence === sentence),
    }));
    const reply = await ai(
      buildStyleRewritePrompt({
        kind: output.kind,
        opportunityType: opportunity.type,
        sentences,
        facts: allowed,
      }),
    );
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
  const citedFacts = parseCitations(body).flatMap((key) => {
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
        styleHits: checkStyle({ body, kind: output.kind }),
        tailoring: null,
      })
      .where(eq(outputs.id, outputId));
    await tx.delete(outputFacts).where(eq(outputFacts.outputId, outputId));
    if (citedFacts.length) {
      await tx
        .insert(outputFacts)
        .values(
          citedFacts.map((f) => ({ outputId, factKey: f.key, userId: deps.userId, factId: f.id, factText: f.text })),
        );
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
  for (const [i, output] of targets.entries()) {
    const { prompt, requirements } = await draftContext(deps, { opportunityId, output });
    estimate += estimateUsd({ model: config.models.writing, prompt, maxOutputTokens: DRAFT_MAX_TOKENS[output.kind] });
    // The first target reads the map when it is missing; the others reuse it.
    if (i === 0 && requirements.map === null) {
      estimate += estimateUsd({
        model: config.models.writing,
        prompt: requirements.prompt,
        maxOutputTokens: REQUIREMENTS_MAX_TOKENS,
      });
    }
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
