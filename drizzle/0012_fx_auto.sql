ALTER TABLE "users" ADD COLUMN "fx_fetch" jsonb;--> statement-breakpoint
-- Decision 67: every rate stored before this was typed by the user. Keys already present win, so
-- running it twice changes nothing; jsonb_object_agg over no rows is NULL, hence the COALESCE.
UPDATE "users" SET "fx_rates" = COALESCE(
	(SELECT jsonb_object_agg(e.key, '{"by":"user","rateDate":null}'::jsonb || e.value) FROM jsonb_each("users"."fx_rates") AS e),
	'{}'::jsonb
);
