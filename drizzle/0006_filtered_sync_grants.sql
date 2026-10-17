-- Slice 13 grants for hb_sync (decision 53, PLAN.md section 2 pattern from 0004_sync_role.sql).
-- Each ok source run replaces that source's role drops: DELETE ... WHERE source_id = $1, then INSERT.
-- A DELETE with a WHERE clause needs SELECT on the columns it reads, so source_id alone is readable.
-- eligibility_overrides gets no grant at all: the sync role can neither read nor write it.
-- test/sync-invariant.test.ts pins these grants exactly.
GRANT INSERT, DELETE ON role_drops TO hb_sync;
--> statement-breakpoint
GRANT SELECT (source_id) ON role_drops TO hb_sync;
