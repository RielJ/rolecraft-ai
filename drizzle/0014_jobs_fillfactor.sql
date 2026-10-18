-- Decision 68. Leave half of each jobs page free so that updates to skills and skills_stamp stay
-- HOT (heap-only tuple): no index covers those columns, so the new row version goes on the same
-- page and Postgres does not write a new jobs_search GIN entry for every lexeme of the job. On the
-- dev database, moving the stamp on 1,993 open jobs took 250-400 ms at fillfactor 100 and 5-8 ms
-- at 50. Existing pages keep their rows until each row is next updated off its page.
ALTER TABLE "jobs" SET (fillfactor = 50);
