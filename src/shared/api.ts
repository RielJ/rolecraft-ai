import { z } from "zod";
import {
  AddonKind,
  AiProvider,
  DismissReason,
  Eligibility,
  FactOrigin,
  FactStatus,
  FileKind,
  ItemUsage,
  MatchLevel,
  MustAnswer,
  OpenStatus,
  OpportunityStatus,
  OpportunityType,
  Outcome,
  OutdatedReason,
  OutputKind,
  PayPeriod,
  ProfileItemKind,
  RateType,
  RoleFamily,
  SkillChipSource,
  SourceKind,
  SourceStatus,
  StyleRule,
  TaskKind,
  TaskStatus,
  UserSeniority,
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
export const SourceId = z.uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;
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
  "source_exists",
  /** Dismissing a job that is on the board: close it there instead. */
  "on_board",
  /** Undoing a save after work started on the job. */
  "has_work",
  /** Merging two jobs that are both on the board (section 3.8): close one instead. */
  "both_on_board",
  "unreadable_file",
  /** GitHub's request limit is used up (decision 55). */
  "github_rate_limited",
  /** gh is signed in as someone other than HB_GITHUB_USER. */
  "github_account",
  "github_unavailable",
  /** Extension call without a valid bearer token or pairing code (docs/plans/chrome-extension.md). */
  "unauthorized",
  /** Request `Origin` is not the app (SPA routes) or not the paired extension (extension routes). */
  "forbidden_origin",
  /** Claiming an application session from a tab whose URL key differs, without `confirmMismatch`. */
  "url_mismatch",
  /** The application session is past its 15 minutes, superseded, or completed. */
  "session_expired",
  /** "Mark reviewed" sent a body other than the stored one: an edit or redraft landed since it was shown. */
  "output_changed",
  /** Hiding a skill from matching that no confirmed fact names (decision 66): remove it instead. */
  "not_in_facts",
  /** Adding a skill past the 100 a user can add (decision 66). */
  "too_many_skills",
  /** Fill rates could not reach any rate source (decision 67). */
  "rates_unavailable",
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

/**
 * Where a fact read from GitHub came from (decision 55): a file or a commit that was actually read,
 * with its link. `private` facts show a lock badge, and their links never reach an exported file.
 */
export const FactEvidence = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    url: z.string(),
    repo: z.string(),
    private: z.boolean(),
  }),
  z.object({
    kind: z.literal("commit"),
    sha: z.string(),
    url: z.string(),
    repo: z.string(),
    private: z.boolean(),
  }),
]);
export type FactEvidence = z.infer<typeof FactEvidence>;

export const FactDto = z.object({
  id: FactId,
  key: FactKey,
  text: z.string(),
  /** The job, project or heading the fact sits under, copied from the item's text. Null when none. */
  section: z.string().nullable(),
  status: FactStatus,
  itemId: ItemId,
  itemKind: ProfileItemKind,
  itemTitle: z.string(),
  usage: ItemUsage,
  /**
   * False when the item's latest split no longer produced it (`seen_rev < rev`): "Not in your
   * latest CV". For a fact read from GitHub, the latest read instead.
   */
  inLatest: z.boolean(),
  /** `text`: split from the item's own text. `github`: read from the item's GitHub link. */
  origin: FactOrigin,
  /** Set exactly when `origin` is `github`. */
  evidence: FactEvidence.nullable(),
});
export type FactDto = z.infer<typeof FactDto>;

/** What the last finished GitHub read did (the `github_read` task's result). */
export const GithubReadSummary = z.object({
  /** The account whose commits were read, and where that name came from. */
  user: z.string(),
  userFrom: z.enum(["HB_GITHUB_USER", "profile link"]),
  via: z.enum(["public", "gh", "fixture"]),
  private: z.boolean(),
  /** Repo text read, in estimated tokens, against the cap. */
  tokens: z.number().int(),
  cap: z.number().int(),
  filesRead: z.array(z.string()),
  commitsRead: z.number().int(),
  added: z.number().int(),
  unchanged: z.number().int(),
  removed: z.number().int(),
  vanished: z.number().int(),
  /** Proposals dropped in code: the evidence they cite was not read, or they say what it does not. */
  dropped: z.array(z.object({ text: z.string(), reason: z.string() })),
});
export type GithubReadSummary = z.infer<typeof GithubReadSummary>;

/** A GitHub link on an add-on (decision 55). Null on the item when its link is anything else. */
export const ItemGithubDto = z.object({
  kind: z.enum(["repo", "pull"]),
  /** `owner/repo` or `owner/repo#N`. */
  label: z.string(),
  /** From the last read; null until the first. */
  private: z.boolean().nullable(),
  readTask: TaskDto.nullable(),
  lastRead: GithubReadSummary.nullable(),
});
export type ItemGithubDto = z.infer<typeof ItemGithubDto>;

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
  github: ItemGithubDto.nullable(),
});
export type ProfileItemDto = z.infer<typeof ProfileItemDto>;

/** Drop repeats that differ only in case; the first spelling wins. */
const uniqueCaseless = (values: string[]) => [...new Map(values.map((v) => [v.toLowerCase(), v])).values()];

const ExcludeWord = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^,]+$/, "One word or phrase per entry, without commas.");

/** An ISO 4217 code such as PHP or USD. */
export const CurrencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a three-letter currency code, such as PHP or USD.");

/** `users.min_pay` (PLAN.md section 2): an amount per period in one currency. */
export const Money = z.object({
  amount: z.number().positive("Minimum pay must be more than zero.").max(1e9, "That amount is too large."),
  currency: CurrencyCode,
  period: PayPeriod,
});
export type Money = z.infer<typeof Money>;

/**
 * What the role filter reads (section 3.7a), plus what matching reads about you (section 3.7).
 * No families picked means only exclude words drop. Null seniority, years or pay means not set.
 */
export const Targeting = z.object({
  /** Keywords for built-in boards whose own keywords are blank ("frontend engineer"). */
  targetTitles: z.array(z.string().trim().min(1).max(100)).max(30).transform(uniqueCaseless),
  roleFamilies: z
    .array(RoleFamily)
    .max(RoleFamily.options.length)
    .transform((families) => [...new Set(families)]),
  excludeTitleWords: z.array(ExcludeWord).max(50).transform(uniqueCaseless),
  seniority: UserSeniority.nullable(),
  yearsExperience: z
    .number()
    .int("Years of experience is a whole number.")
    .min(0, "Years of experience cannot be negative.")
    .max(60, "Years of experience is at most 60.")
    .nullable(),
  /** The default for the Matches pay filter (decision 20). */
  minPay: Money.nullable(),
});
export type Targeting = z.infer<typeof Targeting>;

export const ProfileDto = z.object({
  contact: Contact,
  standardAnswers: StandardAnswers,
  targeting: Targeting,
  cv: ProfileItemDto.nullable(),
  addons: z.array(ProfileItemDto),
  facts: z.array(FactDto),
  /** Built-in skills named in confirmed fact text. */
  skillsFound: z.array(z.string()),
  /**
   * Profile's "Skills used for matching" (decision 66): found in facts, added by the user, and
   * hidden from matching. Matching counts the first two.
   */
  skillChips: z.array(z.object({ name: z.string(), source: SkillChipSource, builtin: z.boolean() })),
  /** Every built-in skill name, for the Add skill picker. */
  skillCatalog: z.array(z.string()),
  /** Whether an AI key is saved, so the split uses AI instead of the rule splitter. */
  aiReady: z.boolean(),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const UpdateProfileInput = z.object({
  contact: Contact.optional(),
  standardAnswers: StandardAnswers.optional(),
  targeting: Targeting.partial().optional(),
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

/** What a GitHub read needs to run again (stored in `tasks.input`). */
export const GithubReadTaskInput = z.object({ itemId: ItemId });
export type GithubReadTaskInput = z.infer<typeof GithubReadTaskInput>;

/**
 * `PUT /api/profile/skills`: add a skill to matching, hide one found in facts, or clear either
 * (`none`). The name is cleaned and checked on the server (`normalizeSkillName`).
 */
export const SetSkillInput = z.object({
  name: z.string().max(500),
  state: z.enum(["added", "hidden", "none"]),
});
export type SetSkillInput = z.infer<typeof SetSkillInput>;

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
  /** Where the other job came from: the board it was seen on, "added by link" or "pasted". */
  source: z.string(),
  /** One line per job: requirements, location or pay that differ. */
  diff: z.object({ job: z.string(), other: z.string() }),
  /** Whether the two can be merged; blocked when both are on the board (section 3.8). */
  merge: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }),
    z.object({ kind: z.literal("blocked"), reason: z.string() }),
  ]),
});
export type PossibleDuplicate = z.infer<typeof PossibleDuplicate>;

/** `POST /api/jobs/:id/merge`: merge the job into `into` (section 3.8). */
export const MergeInput = z.object({ into: JobId });
export type MergeInput = z.infer<typeof MergeInput>;

/** The job that was kept, and its opportunity when it has one. */
export const MergeResult = z.object({ jobId: JobId, opportunityId: OpportunityId.nullable() });
export type MergeResult = z.infer<typeof MergeResult>;

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
  /** When the source says the job was posted; null when it gave no date (pasted jobs, most feeds). */
  postedAt: z.string().nullable(),
  /** When a refresh or paste first found the job: the card's fallback when `postedAt` is null. */
  firstSeenAt: z.string(),
  /** When the status last changed. */
  statusChangedAt: z.string(),
  /** The eligibility verdict and the posting's location words: the card's "where it hires" line. */
  eligibility: Eligibility,
  locationText: z.string(),
  /** Monthly in the view currency, compact ("₱289K–₱385K a month"), or as posted; null when none. */
  pay: z.string().nullable(),
  ready: z.boolean(),
  /**
   * The latest draft task, while it runs or after it failed; null once it finished or if none
   * ran. Matches' "Save and write files" drafts in the background, so the card says so.
   */
  drafting: z.enum(["running", "failed"]).nullable(),
  notes: z.string(),
  contract: ContractTerms.nullable(),
  /** Set on Applied rows with no change for FOLLOW_UP_DAYS or more: the quiet "follow up or close?" hint. */
  followUp: z.object({ days: z.number().int() }).nullable(),
});
export type BoardItemDto = z.infer<typeof BoardItemDto>;

/** `GET /api/board/metrics`: the Board's metrics line (decisions 51 and 52), from `src/domain/metrics.ts`. */
export const BoardMetricsDto = z.object({
  windowDays: z.number().int(),
  /** Applications sent in the window. */
  applied: z.number().int(),
  /** Of those, how many reached Interviewing (or Offer). */
  interviewing: z.number().int(),
  /** `interviewing / applied`, 0 to 1; null with no applications. */
  rate: z.number().nullable(),
  /** Jobs marked ready in the window. */
  readyCount: z.number().int(),
  /** Median Saved to Ready in milliseconds, idle time included; null with no Ready times. */
  medianSavedToReadyMs: z.number().nullable(),
});
export type BoardMetricsDto = z.infer<typeof BoardMetricsDto>;

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
  /** Set by "Mark reviewed"; cleared when a draft or an edit rewrites the body. Gates generated answers in prefill. */
  reviewedAt: z.string().nullable(),
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

/** What a suggest-questions task needs to run again (stored in `tasks.input`). */
export const SuggestQuestionsTaskInput = z.object({ opportunityId: OpportunityId });
export type SuggestQuestionsTaskInput = z.infer<typeof SuggestQuestionsTaskInput>;

/** What a finished suggest-questions task found and added. */
export const SuggestQuestionsResult = z.object({ found: z.number().int(), added: z.number().int() });
export type SuggestQuestionsResult = z.infer<typeof SuggestQuestionsResult>;

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

/** Who wrote a stored rate: the user, or one of the public sources (decision 67). */
export const FX_RATE_BY = ["user", "ecb", "currency-api"] as const;
export const FxRateBy = z.enum(FX_RATE_BY);
export type FxRateBy = z.infer<typeof FxRateBy>;

/**
 * One stored rate (Q12, decision 67): view-currency units per 1 unit, when it was written (typed
 * or fetched), by whom, and the source's rate date (null for a rate the user typed).
 */
export const FxRateEntry = z.object({
  rate: z.number().positive(),
  /** For a fetched rate, the fetch time. */
  setAt: z.iso.datetime(),
  by: FxRateBy,
  rateDate: z.iso.date().nullable(),
});
export type FxRateEntry = z.infer<typeof FxRateEntry>;

/** The last automatic fetch attempt, from the Fill rates button or a Refresh (decision 67). */
export const FxFetchStatus = z.object({
  at: z.iso.datetime(),
  /** Null when every currency a source publishes was filled. */
  error: z.string().nullable(),
  /** Currencies neither source publishes. */
  unsupported: z.array(z.string()),
});
export type FxFetchStatus = z.infer<typeof FxFetchStatus>;

const FxRateValue = z.number().positive("A rate must be more than zero.").max(1_000_000, "That rate is too large.");

export const SettingsDto = z.object({
  money: z.object({
    viewCurrency: z.string(),
    /** Sorted by currency. */
    fxRates: z.array(FxRateEntry.extend({ currency: z.string() })),
    /** Currencies of open jobs' pay that have no rate yet, so their pay shows as posted. */
    missingRates: z.array(z.string()),
    /** The last automatic fetch, or null when none ran since the view currency was set. */
    fetch: FxFetchStatus.nullable(),
  }),
  ai: z.object({
    /** `pi`: AI runs through the local pi CLI and its own sign-in (decision 48); no key is used. */
    via: z.enum(["key", "pi"]),
    /** The models pi runs, when `via` is `pi`. */
    piModels: z.object({ light: z.string(), writing: z.string() }).nullable(),
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

/** What one Fill rates run did (decision 67). */
export const FillRatesResult = z.object({
  filled: z.array(z.object({ currency: z.string(), rate: z.number(), by: z.enum(["ecb", "currency-api"]) })),
  /** Rates the user typed, which a fill never overwrites. */
  kept: z.array(z.string()),
  /** Currencies no source publishes. */
  unsupported: z.array(z.string()),
  /** Currencies whose source failed this time. */
  unavailable: z.array(z.string()),
  /** The view currency changed while the rates were fetched, so nothing was written. */
  viewChanged: z.boolean(),
});
export type FillRatesResult = z.infer<typeof FillRatesResult>;

export const FillRatesResponse = z.object({ settings: SettingsDto, fill: FillRatesResult });
export type FillRatesResponse = z.infer<typeof FillRatesResponse>;

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
  /** The latest "Suggest questions" task for this job: progress text, Retry, and what it added. */
  suggestTask: TaskDto.extend({ result: SuggestQuestionsResult.nullable() }).nullable(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

const OutputBody = z.string().max(100_000);

export const UpdateOutputInput = z
  .object({
    body: OutputBody.nullable().optional(),
    included: z.boolean().optional(),
  })
  .refine((v) => v.body !== undefined || v.included !== undefined, {
    message: "Send body, included, or both.",
  });
export type UpdateOutputInput = z.infer<typeof UpdateOutputInput>;

/**
 * "Mark reviewed": the body the user was shown. The server marks the output reviewed only if the
 * stored body still reads the same, so an edit or redraft that landed meanwhile is never marked.
 */
export const MarkReviewedInput = z.object({ body: OutputBody });
export type MarkReviewedInput = z.infer<typeof MarkReviewedInput>;

export const AddQuestionInput = z.object({ question: z.string().trim().min(1).max(1000) });
export type AddQuestionInput = z.infer<typeof AddQuestionInput>;

export const ReadyResult = z.object({ ready: z.literal(true) });
export type ReadyResult = z.infer<typeof ReadyResult>;

export const TextExport = z.object({ text: z.string() });
export type TextExport = z.infer<typeof TextExport>;

export const FileKindParam = FileKind;

// ---------- Sources and refresh (section 3.1) ----------

export const SourceDto = z.object({
  id: SourceId,
  kind: SourceKind,
  /** Company slug for company boards, null for built-ins. */
  board: z.string().nullable(),
  label: z.string(),
  enabled: z.boolean(),
  /** Null means the profile's target titles. */
  keywords: z.array(z.string()).nullable(),
  /** Built-in boards filter on keywords; company boards return the whole board. */
  builtin: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastStatus: SourceStatus.nullable(),
  lastCount: z.number().int().nullable(),
  lastDropped: z.number().int().nullable(),
  lastError: z.string().nullable(),
});
export type SourceDto = z.infer<typeof SourceDto>;

export const SourceList = z.object({ sources: z.array(SourceDto) });
export type SourceList = z.infer<typeof SourceList>;

/** `POST /api/sources`: a company's careers link. The board is checked before it is saved. */
export const AddSourceInput = z.object({ url: z.string().trim().min(1).max(2000) });
export type AddSourceInput = z.infer<typeof AddSourceInput>;

const Keyword = z.string().trim().min(1).max(100);

export const UpdateSourceInput = z
  .object({
    enabled: z.boolean().optional(),
    /** Null goes back to the profile's target titles. */
    keywords: z.array(Keyword).max(30).nullable().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.keywords !== undefined, { message: "Send enabled, keywords, or both." });
export type UpdateSourceInput = z.infer<typeof UpdateSourceInput>;

/** One source's part of a refresh (section 3.1 step 10). */
export const RefreshSourceResult = z.object({
  sourceId: SourceId,
  label: z.string(),
  status: SourceStatus,
  /** Postings the source returned, before the keyword and role filters. */
  fetched: z.number().int(),
  /** Postings the role filter dropped as surely not your role. */
  dropped: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  closed: z.number().int(),
  reopened: z.number().int(),
  error: z.string().nullable(),
});
export type RefreshSourceResult = z.infer<typeof RefreshSourceResult>;

/**
 * The optional AI eligibility pass (section 3.1 step 8, decision 31):
 * - `not_run`: the setting is off, or no AI is set up. Results from before slice 10 have no reason.
 * - `skipped`: this month's spend plus the pass's estimate would cross the cap. Nobody is there to
 *   confirm during a refresh, so it does not run.
 * - `ran`: `checked` jobs went to the light model; `decided` got a verdict with a verbatim phrase;
 *   `unbacked` answered without one and stayed unclear; `left` were over the 25-job limit.
 *   `stopped` says why it ended early, when it did.
 */
export const AiPassResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_run"), reason: z.enum(["off", "no_ai"]).optional() }),
  z.object({
    kind: z.literal("skipped"),
    reason: z.literal("over_cap"),
    jobs: z.number().int(),
    estimateUsd: z.number(),
    monthUsd: z.number(),
    capUsd: z.number(),
  }),
  z.object({
    kind: z.literal("ran"),
    checked: z.number().int(),
    decided: z.number().int(),
    unbacked: z.number().int(),
    left: z.number().int(),
    stopped: z.object({ reason: z.enum(["over_cap", "ai_failed"]), message: z.string() }).nullable(),
  }),
]);
export type AiPassResult = z.infer<typeof AiPassResult>;

export const RefreshResult = z.object({
  sources: z.array(RefreshSourceResult),
  /** Closed jobs older than 60 days with no board entry, deleted. */
  pruned: z.number().int(),
  aiPass: AiPassResult,
  /** Stored open jobs whose skills changed when read again with the current dictionary (decision 66). */
  skillsReread: z.number().int().default(0),
});
export type RefreshResult = z.infer<typeof RefreshResult>;

/** `GET /api/refresh`: the newest refresh, for the top bar's progress and summary. */
export const RefreshDto = z.object({
  task: TaskDto.nullable(),
  /** Set once the task is done. */
  result: RefreshResult.nullable(),
  /** When the newest refresh that finished without failing ended. Null before any (decision 11). */
  lastRefreshedAt: z.string().nullable(),
  /** Open jobs Matches can show before its filters: untouched, and not excluded unless overridden. */
  openJobs: z.number().int().nonnegative(),
});
export type RefreshDto = z.infer<typeof RefreshDto>;

// ---------- Matches (section 3.7, section 4 Matches) ----------

const StringBool = z.enum(["true", "false"]).transform((v) => v === "true");

/** The Source filter's groups: company boards (ATS), job sites (built-ins), and jobs you added. */
export const MATCH_SOURCE_GROUPS = ["boards", "sites", "added"] as const;
export const MatchSourceGroup = z.enum(MATCH_SOURCE_GROUPS);
export type MatchSourceGroup = z.infer<typeof MatchSourceGroup>;

/** `GET /api/matches` filters. Query strings, so booleans arrive as "true" or "false". */
export const MatchQuery = z.object({
  /** Postgres full-text search over title, company and description. */
  q: z.string().trim().max(200).optional(),
  /** Show jobs that do not hire from the Philippines. Hidden by default (section 3.6). */
  excluded: StringBool.optional(),
  /** Show "Role unclear" jobs. Shown by default (section 3.7a). */
  unsure: StringBool.optional(),
  /**
   * Hide jobs whose monthly pay in the view currency is under this (decision 20). Missing means
   * the minimum pay saved on Profile; 0 turns the filter off.
   */
  payAtLeast: z.coerce.number().min(0).max(1e9).optional(),
  /**
   * Show only these companies, matched by `companyKey` so "Acme" and "Acme Inc." are one. A
   * repeated query parameter, so one value arrives as a string. A picked hidden company shows.
   */
  company: z
    .union([z.string().trim().min(1).max(200), z.array(z.string().trim().min(1).max(200)).max(50)])
    .transform((v) => (typeof v === "string" ? [v] : v))
    .optional(),
  /**
   * Where the job came from: any company board, any job site, added by you (pasted or a link), or
   * one job site's source id.
   */
  source: z.union([MatchSourceGroup, SourceId]).optional(),
});
export type MatchQuery = z.infer<typeof MatchQuery>;
/** The query string as the SPA sends it. */
export type MatchQueryInput = z.input<typeof MatchQuery>;

export const MatchReason = z.object({ sign: z.enum(["positive", "negative", "neutral"]), text: z.string() });
export type MatchReason = z.infer<typeof MatchReason>;

/**
 * Where a job was seen: source labels, primary first. `via` is the board's name when its terms
 * ask for attribution (RemoteOK, We Work Remotely, Remotive), shown as "via <name>" with the link.
 */
export const SeenOn = z.array(z.object({ label: z.string(), listingUrl: z.string(), via: z.string().nullable() }));

/** One row of the Matches list. */
export const MatchItem = z.object({
  id: JobId,
  title: z.string(),
  company: z.string(),
  /** The company as the Company filter and hidden companies match it: "Acme Inc." is `acme`. */
  companyKey: z.string(),
  locationText: z.string(),
  firstSeenAt: z.string(),
  applyUrl: z.string().nullable(),
  seenOn: SeenOn,
  level: MatchLevel,
  /** The role filter's reason when it is unsure (section 3.7a), shown as the "Role unclear" chip. */
  roleUnclear: z.string().nullable(),
  eligibility: Eligibility,
  /** How many of the posting's known skills your confirmed facts name; `asked` is 0 when it names none. */
  skills: z.object({ matched: z.number().int(), asked: z.number().int() }),
  /** Monthly in the view currency, or as posted; null when the posting states none. */
  pay: z.string().nullable(),
});
export type MatchItem = z.infer<typeof MatchItem>;

export const MatchList = z.object({
  jobs: z.array(MatchItem),
  counts: z.object({
    /** Open jobs not yet saved or dismissed, before any filter. */
    open: z.number().int(),
    /** Of those, hidden because they exclude the Philippines and `excluded` is off. */
    excluded: z.number().int(),
    /**
     * Open jobs not yet saved or dismissed that exclude the Philippines, whatever the filters
     * (decision 53). A job the user moved to Matches from Filtered out no longer counts.
     */
    excludedOpen: z.number().int(),
    /** Hidden because the role is unclear and `unsure` is off. */
    unsure: z.number().int(),
    /** Hidden by the pay filter. */
    belowPay: z.number().int(),
    /** Not matching the search. */
    search: z.number().int(),
    /** Hidden because their company is hidden and not picked in the Company filter. */
    hiddenCompany: z.number().int(),
    /**
     * Outside the Company or Source filter. Every other count here, `excludedOpen` included,
     * counts only jobs inside those filters.
     */
    picked: z.number().int(),
  }),
  /**
   * Choices for the Company and Source filters, with how many jobs each would show. Each one is
   * counted with every other filter applied, so a count is what picking it leaves on screen.
   */
  facets: z.object({
    /** Most jobs first. `name` is the most common spelling; `key` is what the filter sends. */
    companies: z.array(z.object({ key: z.string(), name: z.string(), count: z.number().int(), hidden: z.boolean() })),
    sources: z.object({
      groups: z.record(MatchSourceGroup, z.number().int()),
      /** Each job site with at least one job here, most jobs first. */
      sites: z.array(z.object({ id: SourceId, label: z.string(), count: z.number().int() })),
    }),
  }),
  /** Companies the user hid, A to Z. */
  hiddenCompanies: z.array(z.object({ key: z.string(), name: z.string() })),
  viewCurrency: z.string(),
  /** The pay filter in force: monthly, in the view currency. */
  payFilter: z.object({
    /** Null when no filter applies. */
    atLeast: z.number().nullable(),
    /** "profile" when it is the minimum pay saved on Profile, "page" when set on Matches. */
    from: z.enum(["profile", "page"]).nullable(),
    /** The saved minimum pay's currency when it has no rate, so it cannot filter. */
    missingRate: z.string().nullable(),
  }),
});
export type MatchList = z.infer<typeof MatchList>;

/** `POST` and `DELETE /api/hidden-companies`: hide or show one company's jobs in Matches. */
export const CompanyInput = z.object({ company: z.string().trim().min(1).max(200) });
export type CompanyInput = z.infer<typeof CompanyInput>;
/** Their answer: every hidden company, A to Z. */
export const HiddenCompanies = MatchList.shape.hiddenCompanies;

/** `GET /api/matches/:id`: the reading pane. */
export const MatchDetail = z.object({
  id: JobId,
  title: z.string(),
  company: z.string(),
  description: z.string(),
  applyUrl: z.string().nullable(),
  seenOn: SeenOn,
  level: MatchLevel,
  reasons: z.array(MatchReason),
  roleUnclear: z.string().nullable(),
  facts: JobFacts,
  /** Set once the job is saved or dismissed. */
  opportunityId: OpportunityId.nullable(),
});
export type MatchDetail = z.infer<typeof MatchDetail>;

export const DismissInput = z.object({ reason: DismissReason.nullable() });
export type DismissInput = z.infer<typeof DismissInput>;

/** `POST /api/jobs/:id/undo`: put a job back in Matches after a save or dismiss. */
export const UndoInput = z.object({ action: z.enum(["save", "dismiss"]) });
export type UndoInput = z.infer<typeof UndoInput>;

export const SavedJob = z.object({ opportunityId: OpportunityId });
export type SavedJob = z.infer<typeof SavedJob>;

// ---------- Filtered out (decision 53) ----------

/** Each group of the Board's "Filtered out" section shows at most this many items, newest first. */
export const FILTERED_GROUP_LIMIT = 50;

/** `GET /api/filtered`. The search matches title or company across every item, not just the shown ones. */
export const FilteredQuery = z.object({ q: z.string().trim().max(200).optional() });
export type FilteredQuery = z.infer<typeof FilteredQuery>;

/** A real job whose eligibility rule said it does not hire from the Philippines. */
export const ExcludedItem = z.object({
  kind: z.literal("excluded"),
  jobId: JobId,
  title: z.string(),
  company: z.string(),
  phrase: z.string().nullable(),
  seenAt: z.string(),
});
export type ExcludedItem = z.infer<typeof ExcludedItem>;

/** A slim row the role filter dropped at sync (decision 44). */
export const RoleDropItem = z.object({
  kind: z.literal("role_drop"),
  sourceId: SourceId,
  externalId: z.string(),
  title: z.string(),
  company: z.string(),
  url: z.string(),
  /** The source's label. */
  source: z.string(),
  seenAt: z.string(),
});
export type RoleDropItem = z.infer<typeof RoleDropItem>;

const groupOf = <K extends string, T extends z.ZodType>(kind: K, item: T) =>
  z.object({
    kind: z.literal(kind),
    /** "US only", "Title: sales", "Role: Design". */
    reason: z.string(),
    /** Items in the group that match the search; `items` holds the newest of them. */
    count: z.number().int(),
    items: z.array(item),
  });

export const FilteredGroup = z.discriminatedUnion("kind", [
  groupOf("excluded", ExcludedItem),
  groupOf("role_drop", RoleDropItem),
]);
export type FilteredGroup = z.infer<typeof FilteredGroup>;

export const FilteredList = z.object({
  /** Every filtered-out item, whatever the search. */
  total: z.number().int(),
  /** Excluded groups first, then role drops; largest group first within each. */
  groups: z.array(FilteredGroup),
});
export type FilteredList = z.infer<typeof FilteredList>;

/** `POST /api/filtered/overrides`: show an excluded job in Matches from now on. */
export const OverrideInput = z.object({ jobId: JobId });
export type OverrideInput = z.infer<typeof OverrideInput>;
export const OverrideResult = z.object({ jobId: JobId });
export type OverrideResult = z.infer<typeof OverrideResult>;

// ---------- First run (section 4, Setup checklist) ----------

/** The setup steps, in the order the checklist lists them. Any order works for the user. */
export const SETUP_STEPS = ["ai", "cv", "facts", "preferences", "sources", "first_refresh"] as const;
export const SetupStepId = z.enum(SETUP_STEPS);
export type SetupStepId = z.infer<typeof SetupStepId>;

/** `GET /api/setup`: each step derived from data, so nothing is stored to keep in sync. */
export const SetupDto = z.object({
  steps: z.array(z.object({ id: SetupStepId, done: z.boolean() })),
  /** True when every step is done; the checklist is hidden then. */
  done: z.boolean(),
  /** `pi` when AI runs through the local pi CLI (decision 48): the AI step needs no key. */
  aiVia: z.enum(["key", "pi"]),
  /**
   * False until any refresh task exists. Until then the top bar's Refresh opens the sources
   * panel instead of starting a sync.
   */
  refreshStarted: z.boolean(),
});
export type SetupDto = z.infer<typeof SetupDto>;

/** `GET /api/health`: the process is up and Postgres answers. */
export const HealthDto = z.object({ ok: z.boolean(), db: z.enum(["ok", "unreachable"]) });
export type HealthDto = z.infer<typeof HealthDto>;
