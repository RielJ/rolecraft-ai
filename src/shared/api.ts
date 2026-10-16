import { z } from "zod";
import {
  FactStatus,
  FileKind,
  ItemUsage,
  MustAnswer,
  OpportunityStatus,
  OpportunityType,
  OutputKind,
  ProfileItemKind,
} from "./enums";

// ---------- Branded ids ----------

export const UserId = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;
export const ItemId = z.uuid().brand<"ItemId">();
export type ItemId = z.infer<typeof ItemId>;
export const FactId = z.uuid().brand<"FactId">();
export type FactId = z.infer<typeof FactId>;
export const JobId = z.uuid().brand<"JobId">();
export type JobId = z.infer<typeof JobId>;
export const OpportunityId = z.uuid().brand<"OpportunityId">();
export type OpportunityId = z.infer<typeof OpportunityId>;
export const OutputId = z.uuid().brand<"OutputId">();
export type OutputId = z.infer<typeof OutputId>;

/** A fact's citation key, `FACT-<no>`. */
export const FactKey = z
  .string()
  .regex(/^FACT-[1-9]\d*$/)
  .brand<"FactKey">();
export type FactKey = z.infer<typeof FactKey>;

// ---------- Errors ----------

export const ERROR_CODES = [
  "invalid_input",
  "not_found",
  "needs_input",
  "frozen",
  "not_exportable",
  "internal",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// ---------- Profile ----------

export const Contact = z.object({
  fullName: z.string().trim().max(200),
  email: z.string().trim().max(320),
  phone: z.string().trim().max(60),
  location: z.string().trim().max(200),
  links: z.array(z.string().trim().min(1).max(500)).max(20),
});
export type Contact = z.infer<typeof Contact>;

const AnswerText = z.string().trim().max(2000);
/** Reusable answers for must-answer questions (decision 24). Keys are MustAnswer values. */
export const StandardAnswers = z.object({
  salary: AnswerText.optional(),
  work_auth: AnswerText.optional(),
  notice: AnswerText.optional(),
  start_date: AnswerText.optional(),
  references: AnswerText.optional(),
});
export type StandardAnswers = z.infer<typeof StandardAnswers>;

export const FactDto = z.object({
  id: FactId,
  key: FactKey,
  text: z.string(),
  status: FactStatus,
  itemId: ItemId,
  itemKind: ProfileItemKind,
  itemTitle: z.string(),
  usage: ItemUsage,
});
export type FactDto = z.infer<typeof FactDto>;

export const ProfileDto = z.object({
  contact: Contact,
  standardAnswers: StandardAnswers,
  cv: z.object({ id: ItemId, text: z.string(), rev: z.number().int() }).nullable(),
  facts: z.array(FactDto),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const UpdateProfileInput = z.object({
  contact: Contact.optional(),
  standardAnswers: StandardAnswers.optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

export const PasteCvInput = z.object({ text: z.string().trim().min(1).max(100_000) });
export type PasteCvInput = z.infer<typeof PasteCvInput>;

export const UpdateFactInput = z.object({ text: z.string().trim().min(1).max(2000) });
export type UpdateFactInput = z.infer<typeof UpdateFactInput>;

// ---------- Jobs ----------

export const PasteJobInput = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(100_000),
});
export type PasteJobInput = z.infer<typeof PasteJobInput>;

export const AddJobResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), opportunityId: OpportunityId }),
  z.object({ kind: z.literal("existing"), opportunityId: OpportunityId }),
]);
export type AddJobResult = z.infer<typeof AddJobResult>;

export const BoardItemDto = z.object({
  opportunityId: OpportunityId,
  type: OpportunityType,
  status: OpportunityStatus,
  title: z.string(),
  company: z.string(),
  savedAt: z.string(),
  ready: z.boolean(),
});
export type BoardItemDto = z.infer<typeof BoardItemDto>;

// ---------- Workspace ----------

export const GateBlocker = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("must_answer"),
    outputId: OutputId,
    question: z.string(),
    category: MustAnswer,
  }),
  z.object({ kind: z.literal("placeholder"), outputId: OutputId, text: z.string() }),
  z.object({ kind: z.literal("not_drafted"), outputId: OutputId, outputKind: OutputKind }),
  z.object({ kind: z.literal("deleted_fact"), outputId: OutputId, factKey: FactKey }),
]);
export type GateBlocker = z.infer<typeof GateBlocker>;

export const GateResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), blockers: z.array(GateBlocker).min(1) }),
]);
export type GateResult = z.infer<typeof GateResult>;

export const CitationDto = z.object({
  key: FactKey,
  /** The fact text saved when the marker was first written. */
  text: z.string(),
  deleted: z.boolean(),
});
export type CitationDto = z.infer<typeof CitationDto>;

export const OutputDto = z.object({
  id: OutputId,
  kind: OutputKind,
  included: z.boolean(),
  question: z.string().nullable(),
  mustAnswer: MustAnswer.nullable(),
  body: z.string().nullable(),
  /** For must-answer questions: the profile answer used when `body` is null. */
  profileAnswer: z.string().nullable(),
  position: z.number().int(),
  editedAt: z.string().nullable(),
  citations: z.array(CitationDto),
});
export type OutputDto = z.infer<typeof OutputDto>;

export const WorkspaceDto = z.object({
  opportunity: z.object({
    id: OpportunityId,
    type: OpportunityType,
    status: OpportunityStatus.nullable(),
    frozen: z.boolean(),
    /** True only when ready was marked and the gate still passes on current data. */
    ready: z.boolean(),
  }),
  job: z.object({
    id: JobId,
    title: z.string(),
    company: z.string(),
    description: z.string(),
    applyUrl: z.string().nullable(),
  }),
  files: z.array(OutputDto),
  answers: z.array(OutputDto),
  gate: GateResult,
  facts: z.array(z.object({ key: FactKey, text: z.string() })),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

export const UpdateOutputInput = z
  .object({
    body: z.string().max(100_000).nullable().optional(),
    included: z.boolean().optional(),
  })
  .refine((v) => v.body !== undefined || v.included !== undefined, {
    message: "Send body, included, or both.",
  });
export type UpdateOutputInput = z.infer<typeof UpdateOutputInput>;

export const AddQuestionInput = z.object({ question: z.string().trim().min(1).max(1000) });
export type AddQuestionInput = z.infer<typeof AddQuestionInput>;

export const ReadyResult = z.object({ ready: z.literal(true) });
export type ReadyResult = z.infer<typeof ReadyResult>;

export const TextExport = z.object({ text: z.string() });
export type TextExport = z.infer<typeof TextExport>;

export const FileKindParam = FileKind;
