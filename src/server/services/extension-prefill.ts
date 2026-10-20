import { and, eq, gt } from "drizzle-orm";
import { findPlaceholders, stripMarkers } from "@/domain/citations";
import { matchPrefill, type PrefillAnswer } from "@/domain/prefill";
import {
  type DraftInput,
  DraftTaskInput,
  type MarkReviewedInput,
  type OutputDto,
  type OutputId,
  type StandardAnswers,
  type TaskDto,
  type TaskId,
  type UpdateOutputInput,
} from "@/shared/api";
import type {
  ApplicationSessionId,
  ExtensionOutputDto,
  ExtensionOutputList,
  PairingId,
  PrefillRequest,
  PrefillResponse,
} from "@/shared/extension";
import { type GithubRepoRef, isPrivateGithubUrl, stripPrivateGithubUrls } from "@/shared/github-link";
import { applicationSessions, tasks } from "../db/schema";
import { type Deps, notFound } from "./context";
import { preferencesFor } from "./extension-preferences";
import { type ClaimedSession, requireClaimedSession } from "./extension-sessions";
import { privateGithubRepos } from "./github";
import { loadContact } from "./profile";
import { getTask } from "./tasks";
import { draft, exportPdf, listOutputs, markReviewed, outputOpportunity, updateOutput } from "./workspace";

// The prefill payload and the panel's materials (docs/EXTENSION.md). Every
// call starts from a session the calling pairing has claimed (`requireClaimedSession`), and
// everything it reads or changes belongs to that session's opportunity; anything else is 404.
//
// Salary is cut at the source here, before the matcher sees anything: `standardAnswers.salary`
// is dropped and `mustAnswer = 'salary'` outputs are not loaded. The matcher blocks it again.

type SessionRef = { sessionId: ApplicationSessionId; pairingId: PairingId };

/** The DTO caps (src/shared/extension.ts). */
const MAX_QUESTION = 1000;
const MAX_OUTPUTS = 100;
const MAX_FILL_TEXT = 10_000;

function session(deps: Deps, { sessionId, pairingId }: SessionRef): Promise<ClaimedSession> {
  return requireClaimedSession(deps, { id: sessionId, pairingId });
}

function toExtensionOutput(o: OutputDto): ExtensionOutputDto {
  return {
    id: o.id,
    kind: o.kind,
    included: o.included,
    question: o.question === null ? null : o.question.slice(0, MAX_QUESTION),
    mustAnswer: o.mustAnswer,
    generatedAt: o.generatedAt,
    editedAt: o.editedAt,
    reviewedAt: o.reviewedAt,
    outdated: o.outdated.length > 0,
  };
}

/** `standardAnswers` without `salary`: the prefill path never holds it. */
function withoutSalary({ salary: _salary, ...rest }: StandardAnswers): StandardAnswers {
  return rest;
}

/** A stored body as the panel shows and fills it: as exported, without citation markers or private GitHub URLs. */
function fillText(raw: string, repos: readonly GithubRepoRef[]): string {
  return stripPrivateGithubUrls({ text: stripMarkers(raw), repos }).trim();
}

/**
 * Answer outputs as the matcher reads them: no salary ones, no `[[placeholder]]` bodies, and the
 * body as `fillText` gives it.
 */
function prefillAnswers(outputs: readonly OutputDto[], repos: readonly GithubRepoRef[]): PrefillAnswer[] {
  return outputs.flatMap((o): PrefillAnswer[] => {
    if (o.kind !== "answer" || o.mustAnswer === "salary") return [];
    const raw = o.body ?? "";
    if (findPlaceholders(raw).length > 0) return [];
    const body = fillText(raw, repos);
    if (body === "" || body.length > MAX_FILL_TEXT) return [];
    return [{ ...toExtensionOutput(o), body }];
  });
}

/** `POST sessions/:id/prefill`: what each scanned field gets, from profile, preferences and answers. */
export async function prefillSession(
  deps: Deps,
  { request, ...ref }: SessionRef & { request: PrefillRequest },
): Promise<PrefillResponse> {
  const { opportunityId } = await session(deps, ref);
  const [{ contact, standardAnswers }, preferences, outputs, repos] = await Promise.all([
    loadContact(deps),
    preferencesFor(deps, { opportunityId }),
    listOutputs(deps, { opportunityId }),
    privateGithubRepos(deps),
  ]);
  return matchPrefill({
    nonce: request.nonce,
    fields: request.fields,
    profile: {
      contact: { ...contact, links: contact.links.filter((link) => !isPrivateGithubUrl({ link, repos })) },
      standardAnswers: withoutSalary(standardAnswers),
      // Facts carry no category in the database, so none map to a field yet.
      facts: [],
    },
    jobPreferences: preferences.job,
    globalPreferences: preferences.global,
    answers: prefillAnswers(outputs, repos),
  });
}

/** `GET sessions/:id/outputs`: the session's files and answers, without bodies, in workspace order (first 100). */
export async function sessionOutputs(deps: Deps, ref: SessionRef): Promise<ExtensionOutputList> {
  const { opportunityId } = await session(deps, ref);
  const outputs = await listOutputs(deps, { opportunityId });
  return { outputs: outputs.slice(0, MAX_OUTPUTS).map(toExtensionOutput) };
}

/** The session, after checking `outputId` belongs to its opportunity (404 otherwise). */
async function sessionOutput(deps: Deps, ref: SessionRef & { outputId: OutputId }): Promise<ClaimedSession> {
  const claimed = await session(deps, ref);
  if ((await outputOpportunity(deps, { outputId: ref.outputId })) !== claimed.opportunityId) {
    throw notFound("That file or answer");
  }
  return claimed;
}

function pick(outputs: readonly OutputDto[], outputId: OutputId): ExtensionOutputDto {
  const found = outputs.find((o) => o.id === outputId);
  if (!found) throw notFound("That file or answer");
  return toExtensionOutput(found);
}

/** `PATCH sessions/:id/outputs/:outputId`: edit from the panel. A new body clears the review. */
export async function editSessionOutput(
  deps: Deps,
  { input, ...ref }: SessionRef & { outputId: OutputId; input: UpdateOutputInput },
): Promise<ExtensionOutputDto> {
  await sessionOutput(deps, ref);
  const ws = await updateOutput(deps, { outputId: ref.outputId, ...input });
  return pick([...ws.files, ...ws.answers], ref.outputId);
}

/**
 * `POST sessions/:id/outputs/:outputId/reviewed`: "Mark reviewed" from the panel. `body` is the
 * text the panel showed, which is the fill text, so the stored body is compared in that form.
 */
export async function reviewSessionOutput(
  deps: Deps,
  { input, ...ref }: SessionRef & { outputId: OutputId; input: MarkReviewedInput },
): Promise<ExtensionOutputDto> {
  await sessionOutput(deps, ref);
  const repos = await privateGithubRepos(deps);
  const ws = await markReviewed(deps, {
    outputId: ref.outputId,
    body: input.body,
    shown: (stored) => fillText(stored, repos),
  });
  return pick([...ws.files, ...ws.answers], ref.outputId);
}

/** `GET sessions/:id/outputs/:outputId/pdf`: the resume or letter PDF, through the export gate. */
export async function sessionOutputPdf(
  deps: Deps,
  ref: SessionRef & { outputId: OutputId },
): Promise<{ bytes: Uint8Array; filename: string }> {
  await sessionOutput(deps, ref);
  return exportPdf(deps, { outputId: ref.outputId });
}

/** `POST sessions/:id/draft`: the workspace draft, for the session's opportunity only. */
export async function draftForSession(deps: Deps, { input, ...ref }: SessionRef & { input: DraftInput }) {
  const { opportunityId } = await session(deps, ref);
  return draft(deps, { opportunityId, ...input });
}

/**
 * `GET tasks/:id`: a draft task of an opportunity this pairing holds a live session for. Any other
 * task, including another job's draft, is 404 to the extension.
 */
export async function extensionTask(
  deps: Deps,
  { taskId, pairingId }: { taskId: TaskId; pairingId: PairingId },
): Promise<TaskDto> {
  const { task, input } = await getTaskWithInput(deps, taskId);
  const parsed = DraftTaskInput.safeParse(input);
  if (task.kind !== "draft" || !parsed.success) throw notFound("That task");
  const [held] = await deps.db
    .select({ id: applicationSessions.id })
    .from(applicationSessions)
    .where(
      and(
        eq(applicationSessions.userId, deps.userId),
        eq(applicationSessions.opportunityId, parsed.data.opportunityId),
        eq(applicationSessions.claimedByPairingId, pairingId),
        eq(applicationSessions.status, "claimed"),
        gt(applicationSessions.expiresAt, deps.clock.now()),
      ),
    )
    .limit(1);
  if (!held) throw notFound("That task");
  return task;
}

/** A task of this user (404 otherwise) with its stored input. */
async function getTaskWithInput(deps: Deps, taskId: TaskId): Promise<{ task: TaskDto; input: unknown }> {
  const task = await getTask(deps, { taskId });
  const [row] = await deps.db
    .select({ input: tasks.input })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, deps.userId)));
  return { task, input: row?.input };
}
