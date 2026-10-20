ALTER TABLE "ai_calls" DROP CONSTRAINT "ai_calls_purpose";--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "requirement_map" jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "requirement_map_key" text;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_purpose" CHECK (purpose IN ('split', 'eligibility', 'questions', 'draft', 'github', 'roles', 'requirements'));