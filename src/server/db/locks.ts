/**
 * Transaction-level advisory lock keys. Each one is a named contract between the code paths
 * that take it; `pg_advisory_xact_*` locks end with the transaction, so a pooled connection never
 * keeps one.
 *
 * `MERGE_SYNC_LOCK`: every `asSync` transaction takes it shared, and a user merge takes it
 * exclusive before its `refresh_running` check (section 3.8). A merge therefore waits for any
 * source apply in flight, and no source applies between the merge's check and its commit.
 * Sync transactions share it, so they never wait on each other. Adding or removing a skill of
 * the user's own takes it exclusive too (decision 68), so no sync transaction writes a job between
 * that request reading the jobs and moving their skills stamp.
 */
export const MERGE_SYNC_LOCK = 4_826_391_001;
