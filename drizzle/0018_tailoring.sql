ALTER TABLE "outputs" ADD COLUMN "tailoring" jsonb;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_tailoring_resume" CHECK (tailoring IS NULL OR kind = 'resume');