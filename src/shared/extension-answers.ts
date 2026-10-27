import { z } from "zod";
import { OutputId } from "./api";
import { FieldDescriptor, FieldId, isSalaryLabel, MAX_PREFILL_FIELDS, PREFILL_CATEGORIES } from "./extension";

/** Deliberately exact: whitespace/case differences match, but company names and wording do not disappear. */
export function questionKey(question: string): string {
  return question.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const PRIVATE_QUESTION =
  /\b(?:password|passcode|captcha|social security|ssn|passport|bank account|credit card|medical|disabilit\w*|gender|ethnic\w*|race|hispanic|latino|military|veteran|religion|sex|sexual|lgbt\w*|marital|pregnan\w*|date of birth|birth date|authori[sz](?:ation|ed)|right to work|work permit|eligible to work|legally|eligibility|nationality|visa|sponsor\w*|citizenship|criminal|convict\w*)\b/i;
const PERSONAL_ANSWER =
  /\b(?:current (?:company|employer)|e-?mail|phone|address|linkedin|github|websites?|portfolio|notice period|start date|when can you start|earliest start|available to start|references?|referees?|legally|eligible to work|right to work|work permit|authori[sz]ed to work|relocat\w*)\b/i;

function fieldMetadata(field: FieldDescriptor): string {
  return `${field.label} ${field.name ?? ""}`.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
}

/** Only explicit saves can read these text controls. Standard categories keep their existing preference UI. */
export function isReferenceField(field: FieldDescriptor): boolean {
  const label = field.label.trim();
  const metadata = fieldMetadata(field);
  if (field.control !== "text" && field.control !== "textarea") return false;
  if ([...label].length < 5 || field.adapterCategory !== null) return false;
  if (isSalaryLabel(metadata) || PRIVATE_QUESTION.test(metadata)) return false;
  if (field.autocomplete !== null && !["", "off", "on"].includes(field.autocomplete)) return false;
  const key = questionKey(label)
    .replace(/\s*\*$/, "")
    .trim();
  return !Object.values(PREFILL_CATEGORIES).some((spec) =>
    spec.labelSynonyms.some((synonym) => questionKey(synonym) === key),
  );
}

/** Factual personal details must be supplied by the user, never guessed by the model. */
export function canDraftField(field: FieldDescriptor): boolean {
  return isReferenceField(field) && !PERSONAL_ANSWER.test(fieldMetadata(field));
}

export const AnswerField = FieldDescriptor.refine(isReferenceField, {
  message: "This field cannot be saved as an answer reference.",
});
export const DraftAnswerField = AnswerField.refine(canDraftField, { message: "This question is yours to answer." });
export const AnswerReferenceId = z.uuid().brand<"AnswerReferenceId">();
export type AnswerReferenceId = z.infer<typeof AnswerReferenceId>;
export const AnswerText = z.string().trim().min(1).max(10_000);
export const AnswerReferenceDto = z.object({
  id: AnswerReferenceId,
  question: z.string().max(500),
  body: AnswerText,
  company: z.string().max(500),
  updatedAt: z.iso.datetime(),
});
export type AnswerReferenceDto = z.infer<typeof AnswerReferenceDto>;

export const QuestionLookupInput = z.strictObject({ fields: z.array(AnswerField).max(MAX_PREFILL_FIELDS) });
export type QuestionLookupInput = z.infer<typeof QuestionLookupInput>;
export const QuestionAnswerDto = z.object({
  fieldId: FieldId,
  question: z.string().max(500),
  answer: z.object({ outputId: OutputId, body: z.string().max(10_000), outdated: z.boolean() }).nullable(),
  references: z.array(AnswerReferenceDto).max(3),
});
export type QuestionAnswerDto = z.infer<typeof QuestionAnswerDto>;
export const QuestionLookupResult = z.object({ questions: z.array(QuestionAnswerDto).max(MAX_PREFILL_FIELDS) });
export type QuestionLookupResult = z.infer<typeof QuestionLookupResult>;
export const CreateQuestionInput = z.strictObject({ field: DraftAnswerField });
export type CreateQuestionInput = z.infer<typeof CreateQuestionInput>;
export const SaveAnswerReferenceInput = z.strictObject({ field: AnswerField, body: AnswerText });
export type SaveAnswerReferenceInput = z.infer<typeof SaveAnswerReferenceInput>;
