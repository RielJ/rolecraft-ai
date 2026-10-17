ALTER TABLE "ai_calls" DROP CONSTRAINT "ai_calls_purpose";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind";--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "origin" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "profile_items" ADD COLUMN "github_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_items" ADD COLUMN "github_private" boolean;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_purpose" CHECK (purpose IN ('split', 'eligibility', 'questions', 'draft', 'github'));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_origin" CHECK (origin IN ('text', 'github'));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_evidence" CHECK ((origin = 'github') = (evidence IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind" CHECK (kind IN ('refresh', 'split', 'draft', 'suggest_questions', 'github_read'));