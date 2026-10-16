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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AiCallId,
  FactId,
  FactKey,
  ItemId,
  JobId,
  OpportunityId,
  OutputId,
  StandardAnswers,
  StyleHit,
  TaskId,
  UserId,
} from "@/shared/api";
import {
  AI_PROVIDERS,
  AI_PURPOSES,
  AI_TIERS,
  type AiProvider,
  DISMISS_REASONS,
  ELIGIBILITIES,
  ELIGIBILITY_SOURCES,
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
  TASK_KINDS,
  TASK_STATUSES,
  USER_SENIORITIES,
} from "@/shared/enums";

// Column names are snake_case via `casing: "snake_case"` (drizzle.config.ts and client.ts).

/** `<column> IN ('a','b')` built from the shared enum array, so Zod and the CHECK agree. */
function oneOf(column: string, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql.raw(`${column} IN (${list})`);
}

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
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
    roleFamilies: text().array().notNull().default(sql`'{}'::text[]`),
    excludeTitleWords: text().array().notNull().default(sql`'{}'::text[]`),
    seniority: text().$type<(typeof USER_SENIORITIES)[number]>(),
    yearsExperience: smallint(),
    minPay: jsonb().$type<Money>(),
    standardAnswers: jsonb().$type<StandardAnswers>().notNull().default({}),
    viewCurrency: char({ length: 3 }).notNull().default("PHP"),
    fxRates: jsonb().$type<Record<string, number>>().notNull().default({}),
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
    status: text().notNull().default("pending").$type<(typeof FACT_STATUSES)[number]>(),
    seenRev: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("facts_text", sql`length(btrim(text)) > 0`),
    check("facts_status", oneOf("status", FACT_STATUSES)),
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
    // Dedup key 1, DB-enforced. title_key keeps a generic careers URL from forcing two roles together.
    uniqueIndex("jobs_apply_url_key").on(t.userId, t.applyUrlKey, t.titleKey),
    index("jobs_company_title").on(t.userId, t.companyKey, t.titleKey, t.descriptionKey),
    index("jobs_search").using("gin", t.search),
    index("jobs_open").on(t.userId, t.firstSeenAt.desc()).where(sql`closed_at IS NULL`),
    index("jobs_closed").on(t.closedAt).where(sql`closed_at IS NOT NULL`),
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
    createdAt: createdAt(),
  },
  (t) => [
    check("outputs_kind", oneOf("kind", OUTPUT_KINDS)),
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
