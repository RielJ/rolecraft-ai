CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"tier" text NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_tier" CHECK (tier IN ('light', 'writing')),
	CONSTRAINT "ai_calls_purpose" CHECK (purpose IN ('split', 'eligibility', 'questions', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step" text DEFAULT '' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tasks_kind" CHECK (kind IN ('refresh', 'split', 'draft', 'suggest_questions')),
	CONSTRAINT "tasks_status" CHECK (status IN ('running', 'done', 'failed', 'interrupted'))
);
--> statement-breakpoint
ALTER TABLE "outputs" DROP CONSTRAINT "outputs_must_answer_not_generated";--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "ai_call_id" uuid;--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "style_hits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_month" ON "ai_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_refresh" ON "tasks" USING btree ("user_id") WHERE kind = 'refresh' AND status = 'running';--> statement-breakpoint
CREATE INDEX "tasks_recent" ON "tasks" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_must_answer_not_generated" CHECK (must_answer IS NULL OR (ai_call_id IS NULL AND generated_at IS NULL));