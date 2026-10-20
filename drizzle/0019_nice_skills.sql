ALTER TABLE "jobs" ADD COLUMN "nice_skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_nice_skills" CHECK (nice_skills <@ skills);