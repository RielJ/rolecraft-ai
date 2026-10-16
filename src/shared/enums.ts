import { z } from "zod";

// Each enum is mirrored by a CHECK constraint in src/server/db/schema.ts,
// which builds its IN (...) list from the same array.

export const PROFILE_ITEM_KINDS = ["cv", "experience", "open_source", "challenge", "other"] as const;
export const ProfileItemKind = z.enum(PROFILE_ITEM_KINDS);
export type ProfileItemKind = z.infer<typeof ProfileItemKind>;

/** Add-on kinds (decision 2): every item kind except the single CV. */
export const ADDON_KINDS = [
  "experience",
  "open_source",
  "challenge",
  "other",
] as const satisfies readonly ProfileItemKind[];
export const AddonKind = z.enum(ADDON_KINDS);
export type AddonKind = z.infer<typeof AddonKind>;

export const ITEM_USAGES = ["everywhere", "letters_only"] as const;
export const ItemUsage = z.enum(ITEM_USAGES);
export type ItemUsage = z.infer<typeof ItemUsage>;

export const FACT_STATUSES = ["pending", "confirmed"] as const;
export const FactStatus = z.enum(FACT_STATUSES);
export type FactStatus = z.infer<typeof FactStatus>;

export const USER_SENIORITIES = ["junior", "mid", "senior", "lead", "staff", "principal"] as const;
export const JOB_SENIORITIES = ["intern", "junior", "mid", "senior", "lead", "staff", "principal", "manager"] as const;

export const JOB_ORIGINS = ["source", "link", "paste"] as const;
export const JobOrigin = z.enum(JOB_ORIGINS);
export type JobOrigin = z.infer<typeof JobOrigin>;

export const PAY_PERIODS = ["hour", "day", "week", "month", "year"] as const;
export const PayPeriod = z.enum(PAY_PERIODS);
export type PayPeriod = z.infer<typeof PayPeriod>;

export const ELIGIBILITIES = ["ph", "worldwide", "apac", "americas", "excluded", "unclear"] as const;
export const Eligibility = z.enum(ELIGIBILITIES);
export type Eligibility = z.infer<typeof Eligibility>;
export const ELIGIBILITY_SOURCES = ["rule", "ai"] as const;

export const OPPORTUNITY_TYPES = ["job", "contract"] as const;
export const OpportunityType = z.enum(OPPORTUNITY_TYPES);
export type OpportunityType = z.infer<typeof OpportunityType>;

export const OPPORTUNITY_STATUSES = ["saved", "applied", "interviewing", "offer", "closed"] as const;
export const OpportunityStatus = z.enum(OPPORTUNITY_STATUSES);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

/** Statuses whose outputs are read-only: what you sent stays what you sent (decision 26, Q7). */
export const FROZEN_STATUSES = [
  "applied",
  "interviewing",
  "offer",
  "closed",
] as const satisfies readonly OpportunityStatus[];

export const OUTCOMES = ["accepted", "rejected", "no_response", "withdrawn"] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

export const DISMISS_REASONS = ["wrong_stack", "too_senior", "pay", "location", "other"] as const;

export const RATE_TYPES = ["hourly", "fixed"] as const;
export const RateType = z.enum(RATE_TYPES);
export type RateType = z.infer<typeof RateType>;

/** Board statuses other than Closed, which needs an outcome (decision 17). */
export const OPEN_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
] as const satisfies readonly OpportunityStatus[];
export const OpenStatus = z.enum(OPEN_STATUSES);
export type OpenStatus = z.infer<typeof OpenStatus>;

export const OUTPUT_KINDS = ["resume", "letter", "message", "answer"] as const;
export const OutputKind = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof OutputKind>;

export const FILE_KINDS = ["resume", "letter", "message"] as const satisfies readonly OutputKind[];
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

/** Files that export to PDF (decision 22). Every output can be copied as text. */
export const PDF_KINDS = ["resume", "letter"] as const satisfies readonly FileKind[];

export const MUST_ANSWERS = ["salary", "work_auth", "notice", "start_date", "references"] as const;
export const MustAnswer = z.enum(MUST_ANSWERS);
export type MustAnswer = z.infer<typeof MustAnswer>;

// ---------- AI and tasks (decisions 29 to 31, 36) ----------

export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export const AiProvider = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof AiProvider>;

/** Light: facts, eligibility, questions. Writing: files and answers (decision 30). */
export const AI_TIERS = ["light", "writing"] as const;
export const AiTier = z.enum(AI_TIERS);
export type AiTier = z.infer<typeof AiTier>;

export const AI_PURPOSES = ["split", "eligibility", "questions", "draft"] as const;
export const AiPurpose = z.enum(AI_PURPOSES);
export type AiPurpose = z.infer<typeof AiPurpose>;

export const TASK_KINDS = ["refresh", "split", "draft", "suggest_questions"] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;

export const TASK_STATUSES = ["running", "done", "failed", "interrupted"] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** What `checkStyle` flags (section 3.4, step 4a). */
export const STYLE_RULES = ["dash", "banned_phrase", "adjective_triplet", "long_sentence"] as const;
export const StyleRule = z.enum(STYLE_RULES);
export type StyleRule = z.infer<typeof StyleRule>;

/** Why a cited fact makes its output outdated (section 2, Provenance). */
export const OUTDATED_REASONS = ["edited", "deleted", "unconfirmed", "letters_only"] as const;
export const OutdatedReason = z.enum(OUTDATED_REASONS);
export type OutdatedReason = z.infer<typeof OutdatedReason>;

// ---------- Sources and sync (PLAN.md section 2, `sources`; section 3.1) ----------

/** Built-in boards: keyword boards and feeds that return a window of recent postings. */
export const BUILTIN_SOURCE_KINDS = ["jobicy", "himalayas", "remoteok", "weworkremotely", "remotive"] as const;
/** Company boards on an ATS: the whole board comes back on every run. */
export const ATS_SOURCE_KINDS = ["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workable"] as const;
export const SOURCE_KINDS = [...BUILTIN_SOURCE_KINDS, ...ATS_SOURCE_KINDS] as const;
export const SourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKind>;
export type AtsSourceKind = (typeof ATS_SOURCE_KINDS)[number];

export const SOURCE_STATUSES = ["ok", "failed", "rate_limited", "suspicious_empty", "skipped"] as const;
export const SourceStatus = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** Role families for the role filter (section 3.7a). */
export const ROLE_FAMILIES = [
  "engineering",
  "design",
  "product",
  "data",
  "qa",
  "devops",
  "security",
  "sales",
  "marketing",
  "support",
  "ops",
  "people",
  "finance",
] as const;
export const RoleFamily = z.enum(ROLE_FAMILIES);
export type RoleFamily = z.infer<typeof RoleFamily>;
