import { and, desc, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import { cleanForEdit, toPlainText } from "@/domain/file-text";
import { classifyQuestion } from "@/domain/must-answer";
import { answerReferences, jobs, opportunities, outputs } from "@/server/db/schema";
import { AppError, type Deps, notFound } from "@/server/services/context";
import { requireClaimedSession } from "@/server/services/extension-sessions";
import { listOutputs } from "@/server/services/workspace";
import type { OpportunityId, OutputDto } from "@/shared/api";
import { FROZEN_STATUSES } from "@/shared/enums";
import type { ApplicationSessionId, ExtensionOutputDto, PairingId } from "@/shared/extension";
import {
  type AnswerReferenceDto,
  AnswerText,
  CreateQuestionInput,
  QuestionLookupInput,
  type QuestionLookupResult,
  questionKey,
  SaveAnswerReferenceInput,
} from "@/shared/extension-answers";

type SessionRef = { sessionId: ApplicationSessionId; pairingId: PairingId };

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError({ code: "invalid_input", message: "That question or answer cannot be used here." });
  }
  return parsed.data;
}

/** Add only a draftable question, once per exact normalized question in this job. */
export async function createSessionQuestion(
  deps: Deps,
  { input, sessionId, pairingId }: SessionRef & { input: CreateQuestionInput },
): Promise<ExtensionOutputDto> {
  const { opportunityId } = await requireClaimedSession(deps, { id: sessionId, pairingId });
  const { field } = parseInput(CreateQuestionInput, input);
  const question = field.label.trim();
  if (classifyQuestion(question) !== null || classifyQuestion(field.name ?? "") !== null) {
    throw new AppError({ code: "invalid_input", message: "This question is yours to answer, not the model's." });
  }
  // addQuestion accepts a Db, not a transaction. Keep its small insert and frozen guard here so
  // the opportunity lock covers both deduplication and insertion, including suggested questions.
  const outputId = await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: opportunities.status })
      .from(opportunities)
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)))
      .for("update");
    if (!locked) throw notFound("That job");
    if (FROZEN_STATUSES.some((status) => status === locked.status)) {
      throw new AppError({
        code: "frozen",
        message: "This job is marked applied, so its files and answers stay as you sent them.",
      });
    }
    const existing = await tx
      .select({ id: outputs.id, kind: outputs.kind, question: outputs.question, position: outputs.position })
      .from(outputs)
      .where(and(eq(outputs.opportunityId, opportunityId), eq(outputs.userId, deps.userId)));
    const found = existing.find(
      (output) =>
        output.kind === "answer" && output.question !== null && questionKey(output.question) === questionKey(question),
    );
    if (found) return found.id;
    const [created] = await tx
      .insert(outputs)
      .values({
        userId: deps.userId,
        opportunityId,
        kind: "answer",
        question,
        mustAnswer: null,
        included: true,
        position: Math.max(0, ...existing.map((output) => output.position)) + 1,
      })
      .returning({ id: outputs.id });
    if (!created) throw new Error("question insert returned no row");
    return created.id;
  });
  const jobOutputs = await listOutputs(deps, { opportunityId });
  const output = jobOutputs.find((output) => output.id === outputId);
  if (!output) throw notFound("That answer");
  return toExtensionOutput(output);
}

function toExtensionOutput(output: OutputDto): ExtensionOutputDto {
  return {
    id: output.id,
    kind: output.kind,
    included: output.included,
    question: output.question?.slice(0, 1000) ?? null,
    mustAnswer: output.mustAnswer,
    generatedAt: output.generatedAt,
    editedAt: output.editedAt,
    reviewedAt: output.reviewedAt,
    outdated: output.outdated.length > 0,
  };
}

function referenceDto(row: typeof answerReferences.$inferSelect, company: string): AnswerReferenceDto {
  return {
    id: row.id,
    question: row.question,
    body: cleanForEdit(row.body),
    company: company.slice(0, 500),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function sourceCompany(deps: Deps, opportunityId: OpportunityId): Promise<string> {
  const [source] = await deps.db
    .select({ company: jobs.company })
    .from(opportunities)
    .innerJoin(jobs, and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, deps.userId)))
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  if (!source) throw notFound("That job");
  return source.company;
}

/** Read current-job drafts and exact saved references. Neither becomes a new output or model request. */
export async function sessionQuestionAnswers(
  deps: Deps,
  { input, sessionId, pairingId }: SessionRef & { input: QuestionLookupInput },
): Promise<QuestionLookupResult> {
  const { opportunityId } = await requireClaimedSession(deps, { id: sessionId, pairingId });
  const { fields } = parseInput(QuestionLookupInput, input);
  await sourceCompany(deps, opportunityId);
  if (fields.length === 0) return { questions: [] };
  const ownAnswers = await deps.db
    .select({ id: outputs.id })
    .from(outputs)
    .where(and(eq(outputs.userId, deps.userId), eq(outputs.opportunityId, opportunityId), eq(outputs.kind, "answer")));
  const ids = new Set(ownAnswers.map((output) => output.id));
  const current = ownAnswers.length ? await listOutputs(deps, { opportunityId }) : [];
  const keys = [...new Set(fields.map((field) => questionKey(field.label)))];
  // One query for all fields, with the cap applied inside each exact question's partition.
  // A global LIMIT would let one question's recent saves starve the other questions.
  const ranked = deps.db
    .select({
      ...getTableColumns(answerReferences),
      company: jobs.company,
      rank: sql<number>`row_number() over (
        partition by ${answerReferences.questionKey}
        order by ${answerReferences.updatedAt} desc, ${answerReferences.id} desc
      )`.as("reference_rank"),
    })
    .from(answerReferences)
    .innerJoin(
      opportunities,
      and(eq(opportunities.id, answerReferences.opportunityId), eq(opportunities.userId, deps.userId)),
    )
    .innerJoin(jobs, and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, deps.userId)))
    .where(and(eq(answerReferences.userId, deps.userId), inArray(answerReferences.questionKey, keys)))
    .as("ranked_references");
  const rows = await deps.db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, 3))
    .orderBy(desc(ranked.updatedAt), desc(ranked.id));
  const references = new Map<string, AnswerReferenceDto[]>();
  for (const reference of rows) {
    const group = references.get(reference.questionKey) ?? [];
    group.push(referenceDto(reference, reference.company));
    references.set(reference.questionKey, group);
  }
  return {
    questions: fields.map((field) => {
      const key = questionKey(field.label);
      const output = current.find(
        (output) => ids.has(output.id) && output.question !== null && questionKey(output.question) === key,
      );
      // Workspace plain text already removes private links. Keep [[blanks]] for panel review,
      // unlike automatic prefill, and strip markers again at this outbound boundary.
      const body = output?.plain === null || output?.plain === undefined ? "" : toPlainText(cleanForEdit(output.plain));
      return {
        fieldId: field.fieldId,
        question: field.label,
        answer:
          output && body.trim() !== "" && body.length <= 10_000
            ? { outputId: output.id, body, outdated: output.outdated.length > 0 }
            : null,
        references: references.get(key) ?? [],
      };
    }),
  };
}

/** An explicit save changes only the reference for this source job and exact question. */
export async function saveSessionAnswerReference(
  deps: Deps,
  { input, sessionId, pairingId }: SessionRef & { input: SaveAnswerReferenceInput },
): Promise<AnswerReferenceDto> {
  const { opportunityId } = await requireClaimedSession(deps, { id: sessionId, pairingId });
  const parsed = parseInput(SaveAnswerReferenceInput, input);
  const company = await sourceCompany(deps, opportunityId);
  const question = parsed.field.label.trim();
  const body = parseInput(AnswerText, cleanForEdit(parsed.body));
  const values = { question, body, updatedAt: deps.clock.now() };
  const [saved] = await deps.db
    .insert(answerReferences)
    .values({ ...values, userId: deps.userId, opportunityId, questionKey: questionKey(question) })
    .onConflictDoUpdate({
      target: [answerReferences.userId, answerReferences.opportunityId, answerReferences.questionKey],
      set: values,
    })
    .returning();
  if (!saved) throw new Error("answer reference upsert returned no row");
  return referenceDto(saved, company);
}
