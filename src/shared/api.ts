import { z } from "zod";
import {
  AddonKind,
  AiProvider,
  Eligibility,
  FactStatus,
  FileKind,
  ItemUsage,
  MustAnswer,
  OpenStatus,
  OpportunityStatus,
  OpportunityType,
  Outcome,
  OutdatedReason,
  OutputKind,
  ProfileItemKind,
  RateType,
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
  "unreadable_file",
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
  /** False when the item's latest split no longer produced it (`seen_rev < rev`): "Not in your latest CV". */
  inLatest: z.boolean(),
});
export type FactDto = z.infer<typeof FactDto>;

/** The CV or an add-on, with its latest split task so a reload can resume progress or offer Retry. */
export const ProfileItemDto = z.object({
  id: ItemId,
  kind: ProfileItemKind,
  title: z.string(),
  body: z.string(),
  /** `YYYY-MM-DD` or null. */
  happenedOn: z.string().nullable(),
  link: z.string().nullable(),
  skills: z.array(z.string()),
  usage: ItemUsage,
  rev: z.number().int(),
  /** CV only: the uploaded file's name. */
  fileName: z.string().nullable(),
  splitTask: TaskDto.nullable(),
});
export type ProfileItemDto = z.infer<typeof ProfileItemDto>;

export const ProfileDto = z.object({
  contact: Contact,
  standardAnswers: StandardAnswers,
  cv: ProfileItemDto.nullable(),
  addons: z.array(ProfileItemDto),
  facts: z.array(FactDto),
  /** Skills named in confirmed fact text: what matching counts. */
  skillsFound: z.array(z.string()),
  /** Whether an AI key is saved, so the split uses AI instead of the rule splitter. */
  aiReady: z.boolean(),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const UpdateProfileInput = z.object({
  contact: Contact.optional(),
  standardAnswers: StandardAnswers.optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

const CvText = z.string().trim().min(1).max(100_000);

export const PasteCvInput = z.object({ text: CvText, confirmOverCap: z.boolean().optional() });
export type PasteCvInput = z.infer<typeof PasteCvInput>;

/** Largest CV file accepted for upload. */
export const MAX_CV_BYTES = 10 * 1024 * 1024;

/** `POST /api/profile/cv/file` as multipart form data. The file is read once and not kept. */
export const UploadCvForm = z.object({
  file: z
    .instanceof(File, { message: "Choose a PDF or DOCX file." })
    .refine((f) => f.size > 0, "That file is empty. Choose another, or paste the text.")
    .refine((f) => f.size <= MAX_CV_BYTES, "That file is over 10 MB. Save a smaller copy, or paste the text."),
  confirmOverCap: z.enum(["true", "false"]).optional(),
});
export type UploadCvForm = z.infer<typeof UploadCvForm>;

/** An add-on (decision 2). Saving it splits it into pending facts. */
export const AddonInput = z.object({
  kind: AddonKind,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  happenedOn: z.iso.date().nullable().optional(),
  link: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable()
    .optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  usage: ItemUsage.optional(),
  confirmOverCap: z.boolean().optional(),
});
export type AddonInput = z.infer<typeof AddonInput>;

/** What a split task needs to run again (stored in `tasks.input`). */
export const SplitTaskInput = z.object({ itemId: ItemId });
export type SplitTaskInput = z.infer<typeof SplitTaskInput>;

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

export const AddLinkInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export type AddLinkInput = z.infer<typeof AddLinkInput>;

export const NEEDS_PASTE_REASONS = ["blocked_host", "too_little_text", "fetch_failed"] as const;
export const NeedsPasteReason = z.enum(NEEDS_PASTE_REASONS);
export type NeedsPasteReason = z.infer<typeof NeedsPasteReason>;

/** Section 3.2: a link either makes a job, finds one, or opens the paste form with what was read. */
export const AddLinkResult = z.discriminatedUnion("kind", [
  ...AddJobResult.options,
  z.object({
    kind: z.literal("needs_paste"),
    url: z.string(),
    prefill: z.object({ title: z.string().optional(), company: z.string().optional() }),
    reason: NeedsPasteReason,
  }),
]);
export type AddLinkResult = z.infer<typeof AddLinkResult>;

/** A job that may be the same as this one (section 3.8), with what sets the two apart. */
export const PossibleDuplicate = z.object({
  jobId: JobId,
  title: z.string(),
  company: z.string(),
  /** Set when the other job is on the board, so the hint can link to it. */
  opportunityId: OpportunityId.nullable(),
  /** One line per job: requirements, location or pay that differ. */
  diff: z.object({ job: z.string(), other: z.string() }),
});
export type PossibleDuplicate = z.infer<typeof PossibleDuplicate>;

/** The job as the header shows it: values arrive converted and worded (section 1, "How API types reach the SPA"). */
export const JobFacts = z.object({
  locationText: z.string(),
  eligibility: z.object({
    verdict: Eligibility,
    label: z.string(),
    /** The phrase that decided it (decision 7); null only when unclear. */
    phrase: z.string().nullable(),
  }),
  /** Null when the posting states no hours. */
  hours: z.object({ phrase: z.string(), manila: z.string() }).nullable(),
  /** Null when the posting states no pay ("not stated", decision 20). */
  pay: z
    .object({
      posted: z.string(),
      /** Monthly in the view currency, or null when shown as posted. */
      converted: z.string().nullable(),
      /** The currency to set a rate for, when that is why there is no conversion. */
      missingRate: z.string().nullable(),
    })
    .nullable(),
  expiresAt: z.iso.datetime().nullable(),
  possibleDuplicates: z.array(PossibleDuplicate),
});
export type JobFacts = z.infer<typeof JobFacts>;

// ---------- Board (decisions 16 to 19) ----------

/** A contract's terms (decision 16). Every field is optional until the user fills it in. */
export const ContractTerms = z.object({
  rateAmount: z.number().nullable(),
  rateType: RateType.nullable(),
  /** ISO 4217 code, e.g. USD. */
  rateCurrency: z.string().nullable(),
  platform: z.string().nullable(),
});
export type ContractTerms = z.infer<typeof ContractTerms>;

/** Where an opportunity sits on the board. Closed always carries its outcome. */
export const BoardStatus = z.discriminatedUnion("status", [
  z.object({ status: OpenStatus }),
  z.object({ status: z.literal("closed"), outcome: Outcome }),
]);
export type BoardStatus = z.infer<typeof BoardStatus>;

/** `POST /api/opportunities/:id/status`. Closed without an outcome is a 400. */
export const ChangeStatusInput = BoardStatus;
export type ChangeStatusInput = BoardStatus;

export const BoardItemDto = z.object({
  opportunityId: OpportunityId,
  type: OpportunityType,
  status: OpportunityStatus,
  outcome: Outcome.nullable(),
  title: z.string(),
  company: z.string(),
  savedAt: z.string(),
  /** When the status last changed. */
  statusChangedAt: z.string(),
  ready: z.boolean(),
  notes: z.string(),
  contract: ContractTerms.nullable(),
  /** Set on Applied rows with no change for FOLLOW_UP_DAYS or more: the quiet "follow up or close?" hint. */
  followUp: z.object({ days: z.number().int() }).nullable(),
});
export type BoardItemDto = z.infer<typeof BoardItemDto>;

/** Largest rate the column (`numeric(12,2)`) holds, rounded down to a readable bound. */
export const MAX_RATE = 999_999_999;

export const ContractTermsInput = z.object({
  rateAmount: z
    .number()
    .positive("The rate must be more than zero.")
    .max(MAX_RATE, "That rate is too large.")
    .nullable()
    .optional(),
  rateType: RateType.nullable().optional(),
  rateCurrency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code, such as USD or PHP.")
    .nullable()
    .optional(),
  platform: z.string().trim().max(100).nullable().optional(),
});
export type ContractTermsInput = z.infer<typeof ContractTermsInput>;

/** `PATCH /api/opportunities/:id`: notes, job or contract, contract terms. Allowed on frozen jobs too. */
export const UpdateOpportunityInput = z
  .object({
    notes: z.string().max(20_000).optional(),
    type: OpportunityType.optional(),
    contract: ContractTermsInput.optional(),
  })
  .refine((v) => v.notes !== undefined || v.type !== undefined || v.contract !== undefined, {
    message: "Send notes, type, contract, or a mix.",
  })
  .refine((v) => v.type !== "job" || v.contract === undefined, {
    message: "Jobs have no rate or platform. Switch it to a contract first.",
    path: ["contract"],
  });
export type UpdateOpportunityInput = z.infer<typeof UpdateOpportunityInput>;

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

// ---------- Task requests ----------

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

/** An ISO 4217 code such as PHP or USD. */
export const CurrencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a three-letter currency code, such as PHP or USD.");

/** One stored rate (Q12): view-currency units per 1 unit, and when the user set it. */
export const FxRateEntry = z.object({ rate: z.number().positive(), setAt: z.iso.datetime() });
export type FxRateEntry = z.infer<typeof FxRateEntry>;

const FxRateValue = z.number().positive("A rate must be more than zero.").max(1_000_000, "That rate is too large.");

export const SettingsDto = z.object({
  money: z.object({
    viewCurrency: z.string(),
    /** Sorted by currency. */
    fxRates: z.array(FxRateEntry.extend({ currency: z.string() })),
    /** Currencies of open jobs' pay that have no rate yet, so their pay shows as posted. */
    missingRates: z.array(z.string()),
  }),
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

/** The smallest monthly cap. Caps are stored to the cent, so anything that rounds below this is refused. */
export const MIN_CAP_USD = 0.01;

/** True when `usd` is still at least the minimum after rounding to cents, as the database stores it. */
export const isValidCap = (usd: number): boolean => Number(usd.toFixed(2)) >= MIN_CAP_USD;

export const UpdateSettingsInput = z.object({
  /** Blank means "use the default for the provider". */
  modelLight: ModelName.optional(),
  modelWriting: ModelName.optional(),
  monthlyCapUsd: z
    .number()
    .refine(isValidCap, `The smallest cap is $${MIN_CAP_USD.toFixed(2)}. Leave it empty for no cap.`)
    .max(999_999)
    .nullable()
    .optional(),
  eligibilityOnRefresh: z.boolean().optional(),
  /** Changing it clears the rates, which are relative to it, unless `fxRates` comes too. */
  viewCurrency: CurrencyCode.optional(),
  /** Sets each listed rate (dated now); null removes one. Unlisted rates stay. */
  fxRates: z.record(CurrencyCode, FxRateValue.nullable()).optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

export const WorkspaceDto = z.object({
  opportunity: z.object({
    id: OpportunityId,
    type: OpportunityType,
    status: OpportunityStatus.nullable(),
    outcome: Outcome.nullable(),
    frozen: z.boolean(),
    /** True only when ready was marked and the gate still passes on current data. */
    ready: z.boolean(),
    notes: z.string(),
    /** Null for jobs; the terms (possibly blank) for contracts. */
    contract: ContractTerms.nullable(),
  }),
  job: z
    .object({
      id: JobId,
      title: z.string(),
      company: z.string(),
      description: z.string(),
      applyUrl: z.string().nullable(),
    })
    .extend(JobFacts.shape),
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
