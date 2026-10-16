CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no" integer GENERATED ALWAYS AS IDENTITY (sequence name "facts_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"seen_rev" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_no_unique" UNIQUE("no"),
	CONSTRAINT "facts_text" CHECK (length(btrim(text)) > 0),
	CONSTRAINT "facts_status" CHECK (status IN ('pending', 'confirmed'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"title_key" text NOT NULL,
	"company_key" text NOT NULL,
	"apply_url" text,
	"apply_url_key" text,
	"location_text" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"description_key" text NOT NULL,
	"posted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"pay_min" numeric(14, 2),
	"pay_max" numeric(14, 2),
	"pay_currency" char(3),
	"pay_period" text,
	"pay_phrase" text,
	"hours" jsonb,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"seniority" text,
	"min_years" smallint,
	"eligibility" text DEFAULT 'unclear' NOT NULL,
	"eligibility_phrase" text,
	"eligibility_by" text DEFAULT 'rule' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', company), 'B') || setweight(to_tsvector('english', description), 'C')) STORED,
	CONSTRAINT "jobs_origin" CHECK (origin IN ('source', 'link', 'paste')),
	CONSTRAINT "jobs_pay_period" CHECK (pay_period IS NULL OR pay_period IN ('hour', 'day', 'week', 'month', 'year')),
	CONSTRAINT "jobs_seniority" CHECK (seniority IS NULL OR seniority IN ('intern', 'junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'manager')),
	CONSTRAINT "jobs_eligibility" CHECK (eligibility IN ('ph', 'worldwide', 'apac', 'americas', 'excluded', 'unclear')),
	CONSTRAINT "jobs_eligibility_by" CHECK (eligibility_by IN ('rule', 'ai')),
	CONSTRAINT "jobs_pay_currency" CHECK (pay_min IS NULL OR pay_currency IS NOT NULL),
	CONSTRAINT "jobs_pay_range" CHECK (pay_min IS NULL OR pay_max IS NULL OR pay_max >= pay_min),
	CONSTRAINT "jobs_eligibility_phrase" CHECK (eligibility_phrase IS NOT NULL OR eligibility = 'unclear')
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text DEFAULT 'job' NOT NULL,
	"status" text,
	"outcome" text,
	"status_changed_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text,
	"notes" text DEFAULT '' NOT NULL,
	"ready_at" timestamp with time zone,
	"applied_snapshot" jsonb,
	"rate_amount" numeric(12, 2),
	"rate_type" text,
	"rate_currency" char(3),
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_jobId_unique" UNIQUE("job_id"),
	CONSTRAINT "opportunities_type" CHECK (type IN ('job', 'contract')),
	CONSTRAINT "opportunities_status" CHECK (status IS NULL OR status IN ('saved', 'applied', 'interviewing', 'offer', 'closed')),
	CONSTRAINT "opportunities_outcome" CHECK (outcome IS NULL OR outcome IN ('accepted', 'rejected', 'no_response', 'withdrawn')),
	CONSTRAINT "opportunities_dismiss_reason" CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('wrong_stack', 'too_senior', 'pay', 'location', 'other')),
	CONSTRAINT "opportunities_rate_type" CHECK (rate_type IS NULL OR rate_type IN ('hourly', 'fixed')),
	CONSTRAINT "opportunities_closed_outcome" CHECK ((status = 'closed') = (outcome IS NOT NULL)),
	CONSTRAINT "opportunities_touched" CHECK (status IS NOT NULL OR dismissed_at IS NOT NULL),
	CONSTRAINT "opportunities_board_not_dismissed" CHECK (status IS NULL OR dismissed_at IS NULL),
	CONSTRAINT "opportunities_dismiss_reason_needs_dismissal" CHECK (dismiss_reason IS NULL OR dismissed_at IS NOT NULL),
	CONSTRAINT "opportunities_contract_fields" CHECK (type = 'contract' OR (rate_amount IS NULL AND rate_type IS NULL AND rate_currency IS NULL AND platform IS NULL))
);
--> statement-breakpoint
CREATE TABLE "output_facts" (
	"output_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"fact_id" uuid,
	"fact_text" text NOT NULL,
	CONSTRAINT "output_facts_output_id_fact_key_pk" PRIMARY KEY("output_id","fact_key")
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"question" text,
	"must_answer" text,
	"position" integer DEFAULT 0 NOT NULL,
	"body" text,
	"generated_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outputs_kind" CHECK (kind IN ('resume', 'letter', 'message', 'answer')),
	CONSTRAINT "outputs_must_answer_value" CHECK (must_answer IS NULL OR must_answer IN ('salary', 'work_auth', 'notice', 'start_date', 'references')),
	CONSTRAINT "outputs_question" CHECK ((kind = 'answer') = (question IS NOT NULL)),
	CONSTRAINT "outputs_must_answer_kind" CHECK (must_answer IS NULL OR kind = 'answer'),
	CONSTRAINT "outputs_must_answer_not_generated" CHECK (must_answer IS NULL OR generated_at IS NULL)
);
--> statement-breakpoint
CREATE TABLE "profile_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"happened_on" date,
	"link" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"usage" text DEFAULT 'everywhere' NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"file_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_items_kind" CHECK (kind IN ('cv', 'experience', 'open_source', 'challenge', 'other')),
	CONSTRAINT "profile_items_usage" CHECK (usage IN ('everywhere', 'letters_only')),
	CONSTRAINT "profile_items_cv_usage" CHECK (kind <> 'cv' OR usage = 'everywhere'),
	CONSTRAINT "profile_items_file_name" CHECK (kind = 'cv' OR file_name IS NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"full_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"location" text DEFAULT 'Philippines' NOT NULL,
	"links" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"role_families" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_title_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"seniority" text,
	"years_experience" smallint,
	"min_pay" jsonb,
	"standard_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"view_currency" char(3) DEFAULT 'PHP' NOT NULL,
	"fx_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_provider" text,
	"ai_key_hint" text,
	"model_light" text,
	"model_writing" text,
	"monthly_cap_usd" numeric(8, 2),
	"ai_eligibility_on_refresh" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_seniority" CHECK (seniority IS NULL OR seniority IN ('junior', 'mid', 'senior', 'lead', 'staff', 'principal')),
	CONSTRAINT "users_years" CHECK (years_experience BETWEEN 0 AND 60),
	CONSTRAINT "users_ai_provider" CHECK (ai_provider IS NULL OR ai_provider IN ('anthropic', 'openai')),
	CONSTRAINT "users_cap" CHECK (monthly_cap_usd > 0)
);
--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_item_id_profile_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."profile_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_facts" ADD CONSTRAINT "output_facts_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_facts" ADD CONSTRAINT "output_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_facts" ADD CONSTRAINT "output_facts_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_items" ADD CONSTRAINT "profile_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facts_user_status" ON "facts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "facts_item" ON "facts" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_apply_url_key" ON "jobs" USING btree ("user_id","apply_url_key","title_key");--> statement-breakpoint
CREATE INDEX "jobs_company_title" ON "jobs" USING btree ("user_id","company_key","title_key","description_key");--> statement-breakpoint
CREATE INDEX "jobs_search" ON "jobs" USING gin ("search");--> statement-breakpoint
CREATE INDEX "jobs_open" ON "jobs" USING btree ("user_id","first_seen_at" DESC NULLS LAST) WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "jobs_closed" ON "jobs" USING btree ("closed_at") WHERE closed_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "opportunities_board" ON "opportunities" USING btree ("user_id","status") WHERE status IS NOT NULL;--> statement-breakpoint
CREATE INDEX "output_facts_fact" ON "output_facts" USING btree ("fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outputs_one_file" ON "outputs" USING btree ("opportunity_id","kind") WHERE kind <> 'answer';--> statement-breakpoint
CREATE INDEX "outputs_opportunity" ON "outputs" USING btree ("opportunity_id","kind","position");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_items_one_cv" ON "profile_items" USING btree (user_id) WHERE kind = 'cv';