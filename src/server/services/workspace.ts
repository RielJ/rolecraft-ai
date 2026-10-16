import { and, asc, eq, inArray, max } from "drizzle-orm";
import { factKey, parseCitations, stripMarkers } from "@/domain/citations";
import { checkGate, type GateOutput } from "@/domain/gate";
import { classifyQuestion } from "@/domain/must-answer";
import type {
  AddQuestionInput,
  FactKey,
  GateResult,
  OpportunityId,
  OutputDto,
  OutputId,
  StandardAnswers,
  UpdateOutputInput,
  WorkspaceDto,
} from "@/shared/api";
import { FROZEN_STATUSES, type OpportunityStatus, PDF_KINDS } from "@/shared/enums";
import { outputKindLabel } from "@/shared/labels";
import type { DbOrTx } from "../db/client";
import { facts, jobs, opportunities, outputFacts, outputs } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";
import { loadContact } from "./profile";

type OutputRow = typeof outputs.$inferSelect;
type Citation = { factKey: FactKey; factText: string; deleted: boolean };

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
        })
        .from(outputFacts)
        .where(inArray(outputFacts.outputId, ids))
    : [];
  return rows.map((row) => ({
    row,
    citations: cites
      .filter((c) => c.outputId === row.id)
      .map((c) => ({ factKey: c.factKey, factText: c.factText, deleted: c.factId === null })),
  }));
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
    editedAt: row.editedAt?.toISOString() ?? null,
    citations: citations.map((c) => ({ key: c.factKey, text: c.factText, deleted: c.deleted })),
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
  const [{ standardAnswers }, loaded, confirmed] = await Promise.all([
    loadContact(deps),
    loadOutputs(deps.db, opportunityId),
    deps.db
      .select({ no: facts.no, text: facts.text })
      .from(facts)
      .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")))
      .orderBy(asc(facts.no)),
  ]);
  const gate = checkGate({ outputs: loaded.map(toGateOutput), standardAnswers });
  const dtos = loaded.map((o) => toOutputDto(o, standardAnswers));
  return {
    opportunity: {
      id: opportunity.id,
      type: opportunity.type,
      status: opportunity.status,
      frozen: isFrozen(opportunity.status),
      ready: opportunity.readyAt !== null && gate.ok,
    },
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      description: job.description,
      applyUrl: job.applyUrl,
    },
    files: dtos.filter((o) => o.kind !== "answer"),
    answers: dtos.filter((o) => o.kind === "answer"),
    gate,
    facts: confirmed.map((f) => ({ key: factKey(f.no), text: f.text })),
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
  const { contact, standardAnswers } = await loadContact(deps);
  const body = output.body ?? (output.mustAnswer ? standardAnswers[output.mustAnswer] : undefined) ?? "";
  return { output, contact, text: stripMarkers(body).trim() };
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
