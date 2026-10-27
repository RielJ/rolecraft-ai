import { ApplicationSessionId, FieldDescriptor, FieldId, ScanNonce } from "@shared/extension";
import {
  AnswerReferenceDto,
  CreateQuestionInput,
  QuestionLookupInput,
  QuestionLookupResult,
  SaveAnswerReferenceInput,
} from "@shared/extension-answers";
import { z } from "zod";

const TabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ANSWER_PANEL_REQUESTS = [
  z.strictObject({ kind: z.literal("questions_lookup"), sessionId: ApplicationSessionId, input: QuestionLookupInput }),
  z.strictObject({ kind: z.literal("question_create"), sessionId: ApplicationSessionId, input: CreateQuestionInput }),
  z.strictObject({
    kind: z.literal("answer_reference_save"),
    sessionId: ApplicationSessionId,
    input: SaveAnswerReferenceInput,
  }),
  z.strictObject({
    kind: z.literal("answer_read"),
    sessionId: ApplicationSessionId,
    tabId: TabId,
    nonce: ScanNonce,
    field: FieldDescriptor,
  }),
] as const;
export const AnswerPanelRequest = z.discriminatedUnion("kind", ANSWER_PANEL_REQUESTS);
export type AnswerPanelRequest = z.infer<typeof AnswerPanelRequest>;
export const ANSWER_PANEL_RESULTS = [
  z.object({ kind: z.literal("questions"), data: QuestionLookupResult }),
  z.object({ kind: z.literal("answer_reference"), reference: AnswerReferenceDto }),
  z.object({ kind: z.literal("answer_read"), fieldId: FieldId, body: z.string().max(10_000) }),
] as const;

// Separate from generic RuntimeMessage to keep captured text out of unsolicited messages.
export const ReadAnswerRequest = z.strictObject({
  kind: z.literal("read_answer"),
  nonce: ScanNonce,
  field: FieldDescriptor,
});
export const ReadAnswerResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer_text"), nonce: ScanNonce, fieldId: FieldId, body: z.string().max(10_000) }),
  z.strictObject({ kind: z.literal("answer_unavailable"), nonce: ScanNonce, fieldId: FieldId }),
]);
export type ReadAnswerResult = z.infer<typeof ReadAnswerResult>;
