import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Tailoring } from "@/domain/tailor";
import type {
  AiCallId,
  FactEvidence,
  FactId,
  FactKey,
  FxFetchStatus,
  FxRateEntry,
  ItemId,
  JobId,
  OpportunityId,
  OutputId,
  RequirementMap,
  RoleId,
  SourceId,
  StandardAnswers,
  StyleHit,
  TaskId,
  UserId,
} from "@/shared/api";
import { MAX_STORED_CV_BYTES } from "@/shared/api";
import {
  AI_PROVIDERS,
  AI_PURPOSES,
  AI_TIERS,
  type AiProvider,
  ATS_SOURCE_KINDS,
  DISMISS_REASONS,
  ELIGIBILITIES,
  ELIGIBILITY_SOURCES,
  FACT_ORIGINS,
  FACT_STATUSES,
  ITEM_USAGES,
  JOB_ORIGINS,
  JOB_SENIORITIES,
  MUST_ANSWERS,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TYPES,
  OUTCOMES,
  OUTPUT_KINDS,
  PAY_PERIODS,
  PROFILE_ITEM_KINDS,
  RATE_TYPES,
  type RoleFamily,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  type SourceKind,
  type SourceStatus,
  TASK_KINDS,
  TASK_STATUSES,
  USER_SENIORITIES,
  USER_SKILL_KINDS,
  type UserSkillKind,
} from "@/shared/enums";
import {
  APPLICATION_SESSION_STATUSES,
  type ApplicationSessionId,
  type ApplicationSessionStatus,
  type PairingId,
  PREFILL_CATEGORY_KEYS,
  PREFILL_VALUE_TYPES,
  type PreferenceId,
  type PrefillCategory,
  type TypedValue,
} from "@/shared/extension";

// Column names are snake_case via `casing: "snake_case"` (drizzle.config.ts and client.ts).

/** `<column> IN ('a','b')` built from the shared enum array, so Zod and the CHECK agree. */
function oneOf(column: string, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql.raw(`${column} IN (${list})`);
}

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/** Raw bytes. postgres.js reads bytea as a Buffer, which is a Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
});

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const userRef = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .$type<UserId>();

export type Money = { amount: number; currency: string; period: (typeof PAY_PERIODS)[number] };
export type HistoryEntry = {
  at: string;
  from: (typeof OPPORTUNITY_STATUSES)[number] | null;
  to: (typeof OPPORTUNITY_STATUSES)[number];
  outcome?: (typeof OUTCOMES)[number];
};
export type AppliedSnapshot = {
  title: string;
  company: string;
  description: string;
  applyUrl: string | null;
  at: string;
};
export type JobHours =
  | { phrase: string; tz: string; start: string; end: string }
  | { phrase: string; tz: string; overlapHours: number };

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom().$type<UserId>(),
    createdAt: createdAt(),
    fullName: text().notNull().default(""),
    email: text().notNull().default(""),
    phone: text().notNull().default(""),
    location: text().notNull().default("Philippines"),
    links: text().array().notNull().default(sql`'{}'::text[]`),
    targetTitles: text().array().notNull().default(sql`'{}'::text[]`),
    roleFamilies: text().array().notNull().default(sql`'{}'::text[]`).$type<RoleFamily[]>(),
    excludeTitleWords: text().array().notNull().default(sql`'{}'::text[]`),
    seniority: text().$type<(typeof USER_SENIORITIES)[number]>(),
    yearsExperience: smallint(),
    minPay: jsonb().$type<Money>(),
    standardAnswers: jsonb().$type<StandardAnswers>().notNull().default({}),
    viewCurrency: char({ length: 3 }).notNull().default("PHP"),
    // Q12: per currency, the rate (view-currency units per 1 unit) and when it was set.
    fxRates: jsonb().$type<Record<string, FxRateEntry>>().notNull().default({}),
    // Decision 67: the last automatic rate fetch. Null until one runs, and again after the view
    // currency changes. The sync role's column grants leave it out.
    fxFetch: jsonb().$type<FxFetchStatus>(),
    aiProvider: text().$type<AiProvider>(),
    aiKeyHint: text(),
    modelLight: text(),
    modelWriting: text(),
    monthlyCapUsd: numeric({ precision: 8, scale: 2 }),
    aiEligibilityOnRefresh: boolean().notNull().default(false),
  },
  () => [
    check("users_seniority", sql`seniority IS NULL OR ${oneOf("seniority", USER_SENIORITIES)}`),
    check("users_years", sql`years_experience BETWEEN 0 AND 60`),
    check("users_ai_provider", sql`ai_provider IS NULL OR ${oneOf("ai_provider", AI_PROVIDERS)}`),
    check("users_cap", sql`monthly_cap_usd > 0`),
  ],
);

export const profileItems = pgTable(
  "profile_items",
  {
    id: uuid().primaryKey().defaultRandom().$type<ItemId>(),
    userId: userRef(),
    kind: text().notNull().$type<(typeof PROFILE_ITEM_KINDS)[number]>(),
    title: text().notNull(),
    body: text().notNull(),
    happenedOn: date(),
    link: text(),
    skills: text().array().notNull().default(sql`'{}'::text[]`),
    usage: text().notNull().default("everywhere").$type<(typeof ITEM_USAGES)[number]>(),
    rev: integer().notNull().default(1),
    fileName: text(),
    /** Bumped by each GitHub read of `link` (decision 55); 0 until the first read. */
    githubRev: integer().notNull().default(0),
    /** The repo's visibility at the last read; null until read. */
    githubPrivate: boolean(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("profile_items_kind", oneOf("kind", PROFILE_ITEM_KINDS)),
    check("profile_items_usage", oneOf("usage", ITEM_USAGES)),
    check("profile_items_cv_usage", sql`kind <> 'cv' OR usage = 'everywhere'`),
    check("profile_items_file_name", sql`kind = 'cv' OR file_name IS NULL`),
    uniqueIndex("profile_items_one_cv").on(sql`user_id`).where(sql`kind = 'cv'`),
  ],
);

/**
 * A job on a CV or experience add-on (decision 71): read from the item's text, every field found
 * in it, then editable on Profile. Dates stay as the text writes them.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid().primaryKey().defaultRandom().$type<RoleId>(),
    userId: userRef(),
    itemId: uuid()
      .notNull()
      .references(() => profileItems.id, { onDelete: "cascade" })
      .$type<ItemId>(),
    /** The order the source lists them, most recent first. */
    position: integer().notNull(),
    title: text().notNull(),
    company: text().notNull(),
    location: text(),
    startText: text(),
    endText: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check("roles_title", sql`length(btrim(title)) > 0`),
    check("roles_company", sql`length(btrim(company)) > 0`),
    index("roles_item").on(t.itemId, t.position),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: uuid().primaryKey().defaultRandom().$type<FactId>(),
    no: integer().generatedAlwaysAsIdentity().unique(),
    userId: userRef(),
    itemId: uuid()
      .notNull()
      .references(() => profileItems.id, { onDelete: "cascade" })
      .$type<ItemId>(),
    text: text().notNull(),
    /** The job, project or heading the fact sits under, copied from the item's text; null when none. */
    section: text(),
    /** The role the fact sits under: its section names exactly one of the item's roles' companies. */
    roleId: uuid()
      .references(() => roles.id, { onDelete: "set null" })
      .$type<RoleId>(),
    status: text().notNull().default("pending").$type<(typeof FACT_STATUSES)[number]>(),
    /** `text` facts compare `seen_rev` with the item's `rev`, `github` facts with its `github_rev`. */
    seenRev: integer().notNull(),
    origin: text().notNull().default("text").$type<(typeof FACT_ORIGINS)[number]>(),
    evidence: jsonb().$type<FactEvidence>(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("facts_text", sql`length(btrim(text)) > 0`),
    check("facts_status", oneOf("status", FACT_STATUSES)),
    check("facts_origin", oneOf("origin", FACT_ORIGINS)),
    check("facts_evidence", sql`(origin = 'github') = (evidence IS NOT NULL)`),
    index("facts_user_status").on(t.userId, t.status),
    index("facts_item").on(t.itemId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom().$type<JobId>(),
    userId: userRef(),
    origin: text().notNull().$type<(typeof JOB_ORIGINS)[number]>(),
    title: text().notNull(),
    company: text().notNull(),
    titleKey: text().notNull(),
    companyKey: text().notNull(),
    applyUrl: text(),
    applyUrlKey: text(),
    locationText: text().notNull().default(""),
    description: text().notNull(),
    contentHash: text().notNull(),
    descriptionKey: text().notNull(),
    postedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    payMin: numeric({ precision: 14, scale: 2 }),
    payMax: numeric({ precision: 14, scale: 2 }),
    payCurrency: char({ length: 3 }),
    payPeriod: text().$type<(typeof PAY_PERIODS)[number]>(),
    payPhrase: text(),
    hours: jsonb().$type<JobHours>(),
    skills: text().array().notNull().default(sql`'{}'::text[]`),
    /** The `skills` the posting names only in its nice-to-have text (decision 76); the rest are required. */
    niceSkills: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * Which dictionary `skills` and `niceSkills` were read with: the built-in version and the user's own skill names
     * (decision 68, `skillsStamp`). Null, or any other value than the current one, means stale: the
     * next Refresh reads the job again.
     */
    skillsStamp: text(),
    seniority: text().$type<(typeof JOB_SENIORITIES)[number]>(),
    minYears: smallint(),
    eligibility: text().notNull().default("unclear").$type<(typeof ELIGIBILITIES)[number]>(),
    eligibilityPhrase: text(),
    eligibilityBy: text().notNull().default("rule").$type<(typeof ELIGIBILITY_SOURCES)[number]>(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp({ withTimezone: true }),
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', company), 'B') || setweight(to_tsvector('english', description), 'C')`,
    ),
  },
  (t) => [
    check("jobs_origin", oneOf("origin", JOB_ORIGINS)),
    check("jobs_pay_period", sql`pay_period IS NULL OR ${oneOf("pay_period", PAY_PERIODS)}`),
    check("jobs_seniority", sql`seniority IS NULL OR ${oneOf("seniority", JOB_SENIORITIES)}`),
    check("jobs_eligibility", oneOf("eligibility", ELIGIBILITIES)),
    check("jobs_eligibility_by", oneOf("eligibility_by", ELIGIBILITY_SOURCES)),
    check("jobs_pay_currency", sql`pay_min IS NULL OR pay_currency IS NOT NULL`),
    check("jobs_pay_range", sql`pay_min IS NULL OR pay_max IS NULL OR pay_max >= pay_min`),
    check("jobs_eligibility_phrase", sql`eligibility_phrase IS NOT NULL OR eligibility = 'unclear'`),
    check("jobs_nice_skills", sql`nice_skills <@ skills`),
    // Dedup key 1, DB-enforced. title_key keeps a generic careers URL from forcing two roles together.
    uniqueIndex("jobs_apply_url_key").on(t.userId, t.applyUrlKey, t.titleKey),
    index("jobs_company_title").on(t.userId, t.companyKey, t.titleKey, t.descriptionKey),
    index("jobs_search").using("gin", t.search),
    index("jobs_open").on(t.userId, t.firstSeenAt.desc()).where(sql`closed_at IS NULL`),
    index("jobs_closed").on(t.closedAt).where(sql`closed_at IS NOT NULL`),
    // The Board's "Filtered out" excluded jobs, newest first (decision 53).
    index("jobs_excluded")
      .on(t.userId, t.firstSeenAt.desc())
      .where(sql`eligibility = 'excluded' AND closed_at IS NULL`),
  ],
);

/** Built-in boards and company boards. Sync may update only the `last_*` columns (section 2). */
export const sources = pgTable(
  "sources",
  {
    id: uuid().primaryKey().defaultRandom().$type<SourceId>(),
    userId: userRef(),
    kind: text().notNull().$type<SourceKind>(),
    /** Company slug for ATS kinds, NULL for built-ins. */
    board: text(),
    label: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** NULL means use users.target_titles. */
    keywords: text().array(),
    createdAt: createdAt(),
    // Written only by sync (column grants in drizzle/0004_sync_role.sql).
    lastRunAt: timestamp({ withTimezone: true }),
    lastOkAt: timestamp({ withTimezone: true }),
    lastStatus: text().$type<SourceStatus>(),
    lastCount: integer(),
    lastOkCount: integer(),
    /** Sure drops from the role filter (section 3.7a). */
    lastDropped: integer(),
    lastError: text(),
  },
  (t) => [
    check("sources_kind", oneOf("kind", SOURCE_KINDS)),
    check("sources_last_status", sql`last_status IS NULL OR ${oneOf("last_status", SOURCE_STATUSES)}`),
    check("sources_board", sql`(${oneOf("kind", ATS_SOURCE_KINDS)}) = (board IS NOT NULL)`),
    unique("sources_user_kind_board").on(t.userId, t.kind, t.board).nullsNotDistinct(),
  ],
);

/** Where a job was seen. A job closes when all of its listings are missing. */
export const jobListings = pgTable(
  "job_listings",
  {
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" })
      .$type<SourceId>(),
    externalId: text().notNull(),
    userId: userRef(),
    jobId: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" })
      .$type<JobId>(),
    /** Attribution link back to the board. */
    listingUrl: text().notNull(),
    /** The listing whose content fills the job. */
    isPrimary: boolean().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
    /** Set when a run says it is gone. */
    missingSince: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.externalId] }),
    uniqueIndex("job_listings_one_primary").on(t.jobId).where(sql`is_primary`),
    index("job_listings_job").on(t.jobId),
  ],
);

/**
 * Postings the role filter dropped at sync, as slim rows (decisions 44 and 53). Each ok run of a
 * source replaces that source's rows, so they stay bounded by feed size. Sync may only insert and
 * delete them (drizzle/0006_filtered_sync_grants.sql).
 */
export const roleDrops = pgTable(
  "role_drops",
  {
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" })
      .$type<SourceId>(),
    externalId: text().notNull(),
    userId: userRef(),
    title: text().notNull(),
    company: text().notNull(),
    /** The posting on the board, for Add by link. */
    url: text().notNull(),
    /** The group it shows under: "Title: intern" for an exclude word, "Role: Sales" for a family. */
    reason: text().notNull(),
    /** When the board says it was posted, or else the run that saw it. Orders "newest". */
    seenAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.externalId] }),
    index("role_drops_reason").on(t.userId, t.reason, t.seenAt.desc()),
  ],
);

/**
 * An excluded job the user moved to Matches (decision 53). User-owned: the sync role has no grant
 * on it, so no sync undoes it. Not "touched" for the 60-day prune (decision 15); it goes with its job.
 */
export const eligibilityOverrides = pgTable("eligibility_overrides", {
  jobId: uuid()
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" })
    .$type<JobId>(),
  userId: userRef(),
  createdAt: createdAt(),
});

/**
 * Companies whose jobs Matches hides until the user shows them again. Keyed by `companyKey`, so
 * "Acme" and "Acme Inc." are one company; `name` is the spelling the user hid it under.
 */
export const hiddenCompanies = pgTable(
  "hidden_companies",
  {
    userId: userRef(),
    companyKey: text().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.companyKey] })],
);

/**
 * The user's own skill list (decision 66): `added` skills count for matching even when no fact
 * names them; `hidden` ones are found in facts but left out of matching. One row per skill, so a
 * skill is never both. Keyed by the lowercased name. The sync role has no grant on it: Refresh
 * reads it as the app role before it starts.
 */
export const userSkills = pgTable(
  "user_skills",
  {
    userId: userRef(),
    key: text().notNull(),
    name: text().notNull(),
    kind: text().notNull().$type<UserSkillKind>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    check("user_skills_kind", oneOf("kind", USER_SKILL_KINDS)),
    check("user_skills_name", sql`length(btrim(name)) BETWEEN 1 AND 60`),
  ],
);

/**
 * The CV's PDF as uploaded (decision 69), so the user can see it next to the text that was read.
 * One per user. Only PDFs of at most `MAX_STORED_CV_BYTES` are kept; any other upload, or a paste
 * that changes the text, deletes it. The sync role has no grant on it, not even to read.
 */
export const cvFiles = pgTable(
  "cv_files",
  {
    userId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" })
      .$type<UserId>(),
    fileName: text().notNull(),
    contentType: text().notNull().$type<"application/pdf">(),
    size: integer().notNull(),
    data: bytea().notNull(),
    createdAt: createdAt(),
  },
  () => [
    check("cv_files_content_type", sql`content_type = 'application/pdf'`),
    check("cv_files_size", sql`size BETWEEN 1 AND ${sql.raw(String(MAX_STORED_CV_BYTES))}`),
    check("cv_files_data_size", sql`octet_length(data) = size`),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid().primaryKey().defaultRandom().$type<OpportunityId>(),
    userId: userRef(),
    jobId: uuid()
      .notNull()
      .unique()
      .references(() => jobs.id, { onDelete: "restrict" })
      .$type<JobId>(),
    type: text().notNull().default("job").$type<(typeof OPPORTUNITY_TYPES)[number]>(),
    status: text().$type<(typeof OPPORTUNITY_STATUSES)[number]>(),
    outcome: text().$type<(typeof OUTCOMES)[number]>(),
    statusChangedAt: timestamp({ withTimezone: true }),
    history: jsonb().$type<HistoryEntry[]>().notNull().default([]),
    dismissedAt: timestamp({ withTimezone: true }),
    dismissReason: text().$type<(typeof DISMISS_REASONS)[number]>(),
    notes: text().notNull().default(""),
    readyAt: timestamp({ withTimezone: true }),
    appliedSnapshot: jsonb().$type<AppliedSnapshot>(),
    rateAmount: numeric({ precision: 12, scale: 2 }),
    rateType: text().$type<(typeof RATE_TYPES)[number]>(),
    rateCurrency: char({ length: 3 }),
    platform: text(),
    /** The posting's requirements and the facts behind each (decision 73), with the hash it was built for. */
    requirementMap: jsonb().$type<RequirementMap>(),
    requirementMapKey: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check("opportunities_type", oneOf("type", OPPORTUNITY_TYPES)),
    check("opportunities_status", sql`status IS NULL OR ${oneOf("status", OPPORTUNITY_STATUSES)}`),
    check("opportunities_outcome", sql`outcome IS NULL OR ${oneOf("outcome", OUTCOMES)}`),
    check("opportunities_dismiss_reason", sql`dismiss_reason IS NULL OR ${oneOf("dismiss_reason", DISMISS_REASONS)}`),
    check("opportunities_rate_type", sql`rate_type IS NULL OR ${oneOf("rate_type", RATE_TYPES)}`),
    check("opportunities_closed_outcome", sql`(status = 'closed') = (outcome IS NOT NULL)`),
    check("opportunities_touched", sql`status IS NOT NULL OR dismissed_at IS NOT NULL`),
    check("opportunities_board_not_dismissed", sql`status IS NULL OR dismissed_at IS NULL`),
    check("opportunities_dismiss_reason_needs_dismissal", sql`dismiss_reason IS NULL OR dismissed_at IS NOT NULL`),
    check(
      "opportunities_contract_fields",
      sql`type = 'contract' OR (rate_amount IS NULL AND rate_type IS NULL AND rate_currency IS NULL AND platform IS NULL)`,
    ),
    index("opportunities_board").on(t.userId, t.status).where(sql`status IS NOT NULL`),
  ],
);

export const outputs = pgTable(
  "outputs",
  {
    id: uuid().primaryKey().defaultRandom().$type<OutputId>(),
    userId: userRef(),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" })
      .$type<OpportunityId>(),
    kind: text().notNull().$type<(typeof OUTPUT_KINDS)[number]>(),
    included: boolean().notNull().default(true),
    question: text(),
    mustAnswer: text().$type<(typeof MUST_ANSWERS)[number]>(),
    position: integer().notNull().default(0),
    body: text(),
    aiCallId: uuid()
      .references(() => aiCalls.id, { onDelete: "set null" })
      .$type<AiCallId>(),
    /** Style warnings left after the one rewrite, re-checked on every edit (section 3.4, step 4a). */
    styleHits: jsonb().$type<StyleHit[]>().notNull().default([]),
    generatedAt: timestamp({ withTimezone: true }),
    editedAt: timestamp({ withTimezone: true }),
    /** Set by "Mark reviewed"; cleared when a draft rewrites the body. Gates generated answers in prefill. */
    reviewedAt: timestamp({ withTimezone: true }),
    /** A resume tailored from the base CV: the base and the changes the body is derived from (decision 75). */
    tailoring: jsonb().$type<Tailoring>(),
    createdAt: createdAt(),
  },
  (t) => [
    check("outputs_kind", oneOf("kind", OUTPUT_KINDS)),
    check("outputs_tailoring_resume", sql`tailoring IS NULL OR kind = 'resume'`),
    check("outputs_must_answer_value", sql`must_answer IS NULL OR ${oneOf("must_answer", MUST_ANSWERS)}`),
    check("outputs_question", sql`(kind = 'answer') = (question IS NOT NULL)`),
    check("outputs_must_answer_kind", sql`must_answer IS NULL OR kind = 'answer'`),
    // Never drafted (decision 24).
    check(
      "outputs_must_answer_not_generated",
      sql`must_answer IS NULL OR (ai_call_id IS NULL AND generated_at IS NULL)`,
    ),
    uniqueIndex("outputs_one_file").on(t.opportunityId, t.kind).where(sql`kind <> 'answer'`),
    index("outputs_opportunity").on(t.opportunityId, t.kind, t.position),
  ],
);

export const outputFacts = pgTable(
  "output_facts",
  {
    outputId: uuid()
      .notNull()
      .references(() => outputs.id, { onDelete: "cascade" })
      .$type<OutputId>(),
    factKey: text().notNull().$type<FactKey>(),
    userId: userRef(),
    factId: uuid()
      .references(() => facts.id, { onDelete: "set null" })
      .$type<FactId>(),
    factText: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.outputId, t.factKey] }), index("output_facts_fact").on(t.factId)],
);

/** Long work (decision 36). Tasks start immediately in-process; there is no queue in v1. */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom().$type<TaskId>(),
    userId: userRef(),
    kind: text().notNull().$type<(typeof TASK_KINDS)[number]>(),
    status: text().notNull().default("running").$type<(typeof TASK_STATUSES)[number]>(),
    step: text().notNull().default(""),
    /** Enough to retry. */
    input: jsonb().$type<unknown>().notNull(),
    result: jsonb().$type<unknown>(),
    error: text(),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("tasks_kind", oneOf("kind", TASK_KINDS)),
    check("tasks_status", oneOf("status", TASK_STATUSES)),
    // The "one running sync" rule.
    uniqueIndex("tasks_one_refresh").on(t.userId).where(sql`kind = 'refresh' AND status = 'running'`),
    index("tasks_recent").on(t.userId, t.createdAt.desc()),
  ],
);

/** One row per AI call: tokens and estimated cost (decision 31). */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid().primaryKey().defaultRandom().$type<AiCallId>(),
    userId: userRef(),
    taskId: uuid()
      .references(() => tasks.id, { onDelete: "set null" })
      .$type<TaskId>(),
    tier: text().notNull().$type<(typeof AI_TIERS)[number]>(),
    purpose: text().notNull().$type<(typeof AI_PURPOSES)[number]>(),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    /** NULL when the model is missing from pricing.ts. */
    costUsd: numeric({ precision: 10, scale: 6 }),
    createdAt: createdAt(),
  },
  (t) => [
    check("ai_calls_tier", oneOf("tier", AI_TIERS)),
    check("ai_calls_purpose", oneOf("purpose", AI_PURPOSES)),
    check("ai_calls_provider", oneOf("provider", AI_PROVIDERS)),
    index("ai_calls_month").on(t.userId, t.createdAt),
  ],
);

// ---------- Chrome extension (docs/plans/chrome-extension.md, migration 0008) ----------
// None of these tables get an hb_sync grant: sync can neither read nor write them.

/**
 * One pairing per "Connect extension" click. Waiting until claimed with the one-time code, then
 * active until revoked. Only hashes are stored; the code and the bearer token are shown once.
 */
export const extensionPairings = pgTable(
  "extension_pairings",
  {
    id: uuid().primaryKey().defaultRandom().$type<PairingId>(),
    userId: userRef(),
    /** `chrome-extension://<id>`, bound from the `Origin` header at claim. */
    extensionOrigin: text(),
    codeHash: text().notNull(),
    codeExpiresAt: timestamp({ withTimezone: true }).notNull(),
    tokenHash: text(),
    claimedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Claiming sets origin, token and claimed_at together.
    check("extension_pairings_claim", sql`(claimed_at IS NULL) = (token_hash IS NULL)`),
    check("extension_pairings_claim_origin", sql`(claimed_at IS NULL) = (extension_origin IS NULL)`),
    check("extension_pairings_used", sql`last_used_at IS NULL OR claimed_at IS NOT NULL`),
    check(
      "extension_pairings_origin",
      sql`extension_origin IS NULL OR extension_origin ~ '^chrome-extension://[a-p]{32}$'`,
    ),
    uniqueIndex("extension_pairings_code").on(t.codeHash),
    uniqueIndex("extension_pairings_token").on(t.tokenHash),
    index("extension_pairings_user").on(t.userId, t.createdAt.desc()),
  ],
);

/**
 * The workspace Apply handoff: a short-lived session the extension discovers and binds to a tab.
 * At most one is live (pending or claimed) per user; creating one expires the others first.
 */
export const applicationSessions = pgTable(
  "application_sessions",
  {
    id: uuid().primaryKey().defaultRandom().$type<ApplicationSessionId>(),
    userId: userRef(),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" })
      .$type<OpportunityId>(),
    applyUrl: text().notNull(),
    /** `applyUrlKey(applyUrl)` from src/domain/dedup.ts. */
    applyUrlKey: text().notNull(),
    status: text().notNull().default("pending").$type<ApplicationSessionStatus>(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    claimedByPairingId: uuid()
      .references(() => extensionPairings.id, { onDelete: "set null" })
      .$type<PairingId>(),
    claimedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("application_sessions_status", oneOf("status", APPLICATION_SESSION_STATUSES)),
    check("application_sessions_pending", sql`status <> 'pending' OR claimed_at IS NULL`),
    check("application_sessions_claimed", sql`status NOT IN ('claimed', 'completed') OR claimed_at IS NOT NULL`),
    check("application_sessions_completed", sql`(status = 'completed') = (completed_at IS NOT NULL)`),
    check("application_sessions_pairing", sql`claimed_by_pairing_id IS NULL OR claimed_at IS NOT NULL`),
    uniqueIndex("application_sessions_one_live").on(t.userId).where(sql`status IN ('pending', 'claimed')`),
    index("application_sessions_opportunity").on(t.opportunityId),
  ],
);

/**
 * Saved answers for prefill categories: one global default and one per-job override per category.
 * Written only on an explicit save from the panel. No salary category exists (CHECK below).
 */
export const applicationPreferences = pgTable(
  "application_preferences",
  {
    id: uuid().primaryKey().defaultRandom().$type<PreferenceId>(),
    userId: userRef(),
    /** NULL for the global default. */
    opportunityId: uuid()
      .references(() => opportunities.id, { onDelete: "cascade" })
      .$type<OpportunityId>(),
    category: text().notNull().$type<PrefillCategory>(),
    typedValue: jsonb().$type<TypedValue>().notNull(),
    displayText: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("application_preferences_category", oneOf("category", PREFILL_CATEGORY_KEYS)),
    check(
      "application_preferences_typed_value",
      sql`jsonb_typeof(typed_value) = 'object' AND ${oneOf("typed_value->>'valueType'", PREFILL_VALUE_TYPES)}`,
    ),
    check("application_preferences_display_text", sql`length(btrim(display_text)) > 0`),
    uniqueIndex("application_preferences_global").on(t.userId, t.category).where(sql`opportunity_id IS NULL`),
    uniqueIndex("application_preferences_job")
      .on(t.userId, t.opportunityId, t.category)
      .where(sql`opportunity_id IS NOT NULL`),
    index("application_preferences_opportunity").on(t.opportunityId),
  ],
);
