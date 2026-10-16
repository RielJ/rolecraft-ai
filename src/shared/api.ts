import { z } from "zod";
import {
  AiProvider,
  FactStatus,
  FileKind,
  ItemUsage,
  MustAnswer,
  OpportunityStatus,
  OpportunityType,
  OutdatedReason,
  OutputKind,
  ProfileItemKind,
  StyleRule,
  TaskKind,
  TaskStatus,
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
export const TaskId = z.uuid().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;
export const AiCallId = z.uuid().brand<"AiCallId">();
export type AiCallId = z.infer<typeof AiCallId>;

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
  "must_answer",
  "over_cap",
  "no_ai_key",
  "key_rejected",
  "ai_unavailable",
  "refresh_running",
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

/** `details` of a `402 over_cap` answer. Amounts are USD. */
export const OverCapDetails = z.object({
  monthUsd: z.number(),
  capUsd: z.number(),
  estimateUsd: z.number(),
});
export type OverCapDetails = z.infer<typeof OverCapDetails>;

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

export const StyleHit = z.object({
  sentence: z.string(),
  /** The text that tripped the rule, as it appears in the sentence. */
  phrase: z.string(),
  rule: StyleRule,
});
export type StyleHit = z.infer<typeof StyleHit>;

/** One cited fact that changed since it was cited. `newText` is null when the fact was deleted. */
export const OutdatedChange = z.object({
  factKey: FactKey,
  reason: OutdatedReason,
  oldText: z.string(),
  newText: z.string().nullable(),
});
export type OutdatedChange = z.infer<typeof OutdatedChange>;

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
  generatedAt: z.string().nullable(),
  editedAt: z.string().nullable(),
  citations: z.array(CitationDto),
  /** Style warnings (decision 43). They never block export. */
  styleHits: z.array(StyleHit),
  /** Empty when nothing it cites has changed, and always empty on frozen jobs. */
  outdated: z.array(OutdatedChange),
});
export type OutputDto = z.infer<typeof OutputDto>;

// ---------- Tasks ----------

export const TaskDto = z.object({
  id: TaskId,
  kind: TaskKind,
  status: TaskStatus,
  step: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type TaskDto = z.infer<typeof TaskDto>;

export const ConfirmOverCapInput = z.object({ confirmOverCap: z.boolean().optional() });
export type ConfirmOverCapInput = z.infer<typeof ConfirmOverCapInput>;

/** What a draft task needs to run again (stored in `tasks.input`). */
export const DraftTaskInput = z.object({
  opportunityId: OpportunityId,
  outputIds: z.array(OutputId).min(1),
});
export type DraftTaskInput = z.infer<typeof DraftTaskInput>;

export const DraftInput = z
  .object({
    kinds: z.array(OutputKind).min(1).optional(),
    outputId: OutputId.optional(),
    confirmOverCap: z.boolean().optional(),
  })
  .refine((v) => v.kinds === undefined || v.outputId === undefined, {
    message: "Send kinds or outputId, not both.",
  });
export type DraftInput = z.infer<typeof DraftInput>;

// ---------- Settings ----------

export const SettingsDto = z.object({
  ai: z.object({
    provider: AiProvider.nullable(),
    /** The last four characters of the saved key, or null. The key itself never leaves the server. */
    keyHint: z.string().nullable(),
    /** The user's choice, or null for the provider's default. */
    modelLight: z.string().nullable(),
    modelWriting: z.string().nullable(),
    /** Models used when the user has not picked one, per provider. */
    defaults: z.record(AiProvider, z.object({ light: z.string(), writing: z.string() })),
    monthlyCapUsd: z.number().nullable(),
    eligibilityOnRefresh: z.boolean(),
  }),
  spend: z.object({
    monthUsd: z.number(),
    calls: z.number().int(),
    /** Calls whose model is missing from the price list, so their cost is unknown. */
    unpricedCalls: z.number().int(),
  }),
});
export type SettingsDto = z.infer<typeof SettingsDto>;

export const SaveAiKeyInput = z.object({
  provider: AiProvider,
  key: z.string().trim().min(8).max(500),
});
export type SaveAiKeyInput = z.infer<typeof SaveAiKeyInput>;

const ModelName = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z0-9._:/-]*$/, "Model names use letters, digits, dots, dashes, colons and slashes.");

export const UpdateSettingsInput = z.object({
  /** Blank means "use the default for the provider". */
  modelLight: ModelName.optional(),
  modelWriting: ModelName.optional(),
  monthlyCapUsd: z.number().positive().max(999_999).nullable().optional(),
  eligibilityOnRefresh: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

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
  /** Whether an AI key is saved, so drafting can run. */
  aiReady: z.boolean(),
  /** The latest draft task for this job, so a reload can resume progress or offer Retry. */
  draftTask: TaskDto.extend({ outputIds: z.array(OutputId) }).nullable(),
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
