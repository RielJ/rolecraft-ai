# Plan: instant skill edits and incremental skill reading (slice 17, decision 68, migration 0013)

Decided with the user in a grilling session on 2026-10-18. Builds on slice 15 (`3aaf70b`, skills for matching) and slice 16 (`504113f`, exchange rates).

## Problem

Slice 15 re-reads every open job's skills on every Refresh: it loads about 2,000 descriptions (about 16 MB) and runs 152 regexes over each. On the dev database that took about 1.1 s even when nothing had changed. Real job text costs about 915 ms of regex work for 11 MB, and that grows with the number of jobs. Adding one of your own skills shows on Matches only for jobs already holding it, and the rest wait for the next Refresh.

## Research

- **An inverted index finds the jobs that might contain a term.** `jobs.search` is already a GIN-indexed `tsvector` over title, company and description. `search @@ phraseto_tsquery('english','github actions')` ran in 1.7 ms on the dev database.
- **Aho-Corasick / FlashText** scans each text once for every keyword. Its cost stays nearly flat as keywords are added; the FlashText paper measured it 82× faster than regex at 15,000 terms. It is held in reserve, used only if the budgets below are missed.
- **pgvector won't make this faster.** Embeddings measure how similar two texts are in meaning; they can't say whether a job requires Kubernetes. They also need a model run per text. This is a separate, possible later feature: ranking jobs by similarity to the profile.
- **Correction (found while building): the index misses matches.** On the dev database it missed 397 of 6,936 job-skill matches (5.7%), because the parser turns slash-joined words ("React/Redux", "AWS/GCP") into single tokens. The user chose a substring scan instead (`strpos(lower(text), literal)`, 73–79 ms), which can't miss a match. Moving the stamp also needed migration 0014, `fillfactor = 50`, so updates stay HOT. See decision 68. The note below is the original, wrong premise.
- **The tsvector can only narrow candidates; it can't confirm a match.** The `english` parser turns `C++` and `C#` both into `c`, and `.NET` into `net`. Searching the index with the same parser returns every job that might match, plus some that don't. The existing exact regex makes the final decision. A skill made only of stopwords (for example "IT") gives an empty query, so it falls back to scanning every open job.

## Decisions

1. **Adding or hiding a skill updates Matches at once.** That is the only interactive wait. A Refresh may take seconds, and pasting a job is already fast.
2. **Matching stays exact-word**: a skill matches only when its dictionary name or an alias appears in the text. No semantic matching.
3. **Engine: incremental reading, narrowed by the index.** Keep the current, tested regexes. Replace them with an Aho-Corasick scanner only if a measurement misses the budgets.
4. **Adding a skill of your own** runs inside the `PUT /api/profile/skills` request:
   - query the GIN index for candidate open jobs
   - run the skill's exact regex on those candidates only
   - `UPDATE jobs.skills` for the jobs that match
   - Run as the app role. The hb_sync grants don't change.
5. **Removing a skill of your own** strips it from `jobs.skills` in the same request, with a single UPDATE on the jobs whose array contains it. The read-time filter stays as a safety net.
6. **Hiding a built-in skill** stays a read-time filter. No job writes.
7. **Each job gets a stamp:** `jobs.skills_stamp` holds a hash of the built-in dictionary version and the user's skill set (custom names).
   - A Refresh re-reads only open jobs whose stamp differs from the current one, and writes the new stamp.
   - New jobs get the current stamp when they are saved.
   - Adding or removing a skill updates the matching jobs. The same transaction moves every job that still holds the old stamp to the new one.
   - A built-in dictionary change (its version constant is bumped in code) makes every job's stamp stale, so the next Refresh re-reads all of them once.
8. **Refresh race.** A Refresh that is running when you add a skill saves its new jobs with the old stamp, so the next Refresh re-reads them. A missing skill lasts at most one Refresh.
9. **Quick-check before each regex.** Each pattern stores a lowercase literal, its longest required piece. Lowercase the text once, and skip the regex when `text.includes(literal)` is false. An equivalence test must show identical output with and without the check.
10. **Budgets** (asserted in tests; dev database with about 2,000 open jobs):
    - Adding one custom skill: ≤ 300 ms end to end.
    - The re-read step of a Refresh where neither the dictionary nor the user's skills changed: ≤ 100 ms.
11. **Not in this slice:**
    - Section skipping (About us, Benefits, EEO): a separate, later slice for accuracy, with a dry-run diff over all open jobs.
    - pgvector, Aho-Corasick and any change to which skills count as a match.

## Tasks

1. **Stamp column and version** (sequential: migration):
   - `jobs.skills_stamp text` (nullable). `null` means stale.
   - Generate migration `0013` with `bun run db:generate -- --name skills_stamp`.
   - Grant hb_sync `SELECT`/`UPDATE` on the new column only if the jobs table grants are per column. Today they cover the whole table, so check `test/sync-invariant.test.ts` and pin the result.
   - `BUILTIN_SKILLS_VERSION` constant in `src/domain/features.ts`.
   - Pure `skillsStamp({ version, customNames })` in `src/domain/user-skills.ts`: a stable hash of the sorted names. Test: the same set in a different order gives the same stamp; any change to the set gives a different one.
2. **Incremental `rereadSkills`:**
   - Select only open jobs where `skills_stamp IS DISTINCT FROM $current`.
   - Write the new skills and the stamp. Inserts and updates in `runRefresh` write the current stamp.
   - Tests:
     - A second Refresh with nothing changed reads 0 jobs.
     - Bumping the version re-reads every job.
     - A job saved with an old stamp is re-read.
3. **Quick-check in extraction** (`src/domain/features.ts`):
   - `compileSkills` stores a literal for each pattern; `extractSkills` lowercases once and calls `includes` before running each regex.
   - Equivalence test: the fixture texts (`test/fixtures/skill-texts.ts`), plus a list of tricky strings (C++, C#, .NET, Node.js, CI/CD, and a non-ASCII case), give identical output with the quick-check on and off.
   - A one-off scratch run over the dev database's open descriptions must show 0 differences. Report the run and delete the script.
4. **Instant add and remove** (`src/server/services/profile.ts` `setSkill`, plus a new helper in `src/server/services/user-skills.ts`):
   - **Add:** build the tsquery from the skill's name and aliases (`phraseto_tsquery('english', …)`, OR-ed together). If every query is empty, use all open jobs. Load `id, title, description, skills` for the candidates, run the exact regex, and update the matching jobs' skills.
   - **Remove:** use `array_remove` on the jobs that contain the name.
   - **Both:** move the old stamp to the new one. All of it runs in one transaction with `setSkill`'s row write.
   - Tests:
     - A custom skill appears on Matches right after PUT, with no Refresh.
     - Removing it clears `jobs.skills` at once.
     - A stopword-only skill still works, through the full-scan fallback.
     - C++ doesn't match a job that only says "C".
     - Jobs saved with the old stamp are re-read on the next Refresh (the race).
5. **Budgets:**
   - A DB timing test seeds 2,000 open jobs of about 8 KB each. It asserts that adding a skill takes ≤ 300 ms, and that a Refresh's re-read step with nothing changed takes ≤ 100 ms.
   - Then measure on the dev database (a real Refresh, then adding and removing one custom skill) and report the numbers.
6. **UI copy:** the Profile skills note "applies on the next Refresh" goes away for custom skills, and their matches show at once. Check `e2e/profile.spec.ts`, and extend it to assert that a Matches row gains the skill without a Refresh.
7. **Docs:**
   - Decision 68, "Skill edits apply at once; Refresh reads only what changed": cover the index-narrowing plus exact-regex approach, the stamp and the race, the quick-check, the budgets, and why not pgvector.
   - Update decision 66 where it says stored jobs pick up skills on the next Refresh.
   - Update PLAN.md §3.7.

## Verify

- `bun run check`, `bun run build`, `HB_E2E_PORT=3101 bunx playwright test`.
- Dev-database measurements: report the add-skill time, the re-read time of a Refresh with nothing changed, and the number of jobs re-read.
