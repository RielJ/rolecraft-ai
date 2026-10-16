import { z } from "zod";

// Each enum is mirrored by a CHECK constraint in src/server/db/schema.ts,
// which builds its IN (...) list from the same array.

export const PROFILE_ITEM_KINDS = ["cv", "experience", "open_source", "challenge", "other"] as const;
export const ProfileItemKind = z.enum(PROFILE_ITEM_KINDS);
export type ProfileItemKind = z.infer<typeof ProfileItemKind>;

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

export const ELIGIBILITIES = ["ph", "worldwide", "apac", "americas", "excluded", "unclear"] as const;
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
