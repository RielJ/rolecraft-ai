-- The sync role (PLAN.md section 2, "What sync may write"). services/sync.ts runs every statement
-- as hb_sync through `asSync` (src/server/db/sync-session.ts), which issues SET LOCAL ROLE inside a
-- transaction. Nothing here uses ALTER DEFAULT PRIVILEGES, so a table added later is unwritable by
-- sync until someone grants it on purpose. test/sync-invariant.test.ts pins these grants exactly.
DO $$ BEGIN CREATE ROLE hb_sync NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- PG16+ membership options: the app role may SET ROLE hb_sync but does not inherit its grants.
GRANT hb_sync TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hb_sync;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs, job_listings TO hb_sync;
--> statement-breakpoint
GRANT SELECT ON sources TO hb_sync;
--> statement-breakpoint
GRANT UPDATE (last_run_at, last_ok_at, last_status, last_count, last_ok_count, last_dropped, last_error) ON sources TO hb_sync;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai_calls TO hb_sync;
--> statement-breakpoint
GRANT SELECT (id, target_titles, role_families, exclude_title_words, ai_provider, model_light, monthly_cap_usd, ai_eligibility_on_refresh) ON users TO hb_sync;
--> statement-breakpoint
GRANT SELECT (job_id) ON opportunities TO hb_sync;
