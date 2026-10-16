# Planner digest: plans A, B and C

This digest records where the three `plan_multi` plans agree and where they differ. Plan A is Opus 5, plan B is GPT 5.6 Sol, and plan C is GLM 5.2. Plan D (Opus 5.5) is in `plan-d-opus-5-5.md`.

## What all three agree on

- Layers: `domain` (pure functions), `adapters` (all I/O, each behind an interface with a stub), `db/repos` (the only place Drizzle runs), `services` (orchestration), `api/routes` (Zod at the edge), and `web`. The SPA imports only the shared contract file.
- Every table has a `user_id`. One user is created at startup.
- `tasks` has a partial unique index that allows only one queued or running sync. On boot, `running` tasks are marked interrupted.
- The fetch queue uses an honest user agent, per-host concurrency of 2, 400–900 ms jitter, a 10 s timeout, `Retry-After`, at most 3 retries, and per-source budgets (Remotive).
- Adapters throw when a payload has an unexpected shape. A source that suddenly returns nothing is marked `suspicious_empty`. Only a successful run closes jobs.
- Fact keys are `FACT-###`. Only confirmed facts reach prompts. Resume prompts exclude `answers_and_letters_only` facts.
- Drafting validates citations and runs an anti-invention check that rejects employer names, numbers or years not found in the facts. It retries once.
- Must-answer questions are detected by rules, filled from `settings.ans_*`, and never drafted.
- The gate is re-checked on the server for both "ready" and export.
- The API key is encrypted with AES-GCM and never returned (only a masked suffix).
- An import-boundary test enforces the layers.
- The first slice works without sources.

## Where they differ

| Topic | A (Opus 5) | B (GPT 5.6 Sol) | C (GLM 5.2) |
|---|---|---|---|
| Job vs opportunity tables | Separate `jobs` (posting data) and `opportunities` (user data, `job_id UNIQUE`) | Same split as A, plus a `job_sources` link table that keeps every source's attribution after a merge | One `jobs` table holding both posting and user columns. Two column-list constants keep them apart, and a test checks they don't overlap |
| Sync-invariant enforcement | `withSyncGuard(db)` wraps Drizzle and throws on writes to other tables, plus a byte-snapshot test | Sync repos have no user-data write functions, plus a row-compare test over every user table | Column constants, plus a test that sync only calls `*FromSync` repo functions, plus a byte-identical test |
| Provenance ("outdated") | `output_facts` rows store `fact_content_hash` | `output_fact_refs` rows store `fact_version` and a content snapshot. Facts carry a `version`, and deleting a referenced fact is blocked (`ON DELETE RESTRICT`) | A `facts_used uuid[]` column, outdated when the fact's `updated_at > generated_at`. Simplest, but it loses the old content and has no FK |
| Output history | One row per (opportunity, kind) | A `generation` integer keeps every version, and applying freezes the latest | One row per (job, kind) |
| Questions and answers | Separate `questions`, `answers` and `answer_facts` tables | Separate `questions`, `answers` and `answer_fact_refs` tables | Answer stored on the `questions` row, with `answer_facts uuid[]` |
| Auto-merge rule | Exact apply URL, or company + title **plus description similarity ≥ 0.6**. Otherwise a suggestion | Exact apply URL only. Company + title never auto-merges and becomes a suggestion | Exact apply URL. Company + title within 21 days becomes a suggestion |
| Stored CV | A `cv_imports` audit row with the raw text | `profile_documents` keeps the original file as `bytea` and the extracted text. Only one is active | Not stored |
| CV re-import | Match candidates against existing facts: exact matches are skipped, near matches are shown as "replaces FACT-012". Open question | Not specified beyond stable keys | Replaces unconfirmed CV facts. Confirmed facts are kept |
| Match results | A `job_matches` table with a profile fingerprint | Computed on the `jobs` row (not detailed) | `match_tier` and `match_reasons` columns on `jobs` |
| FX rates | A table of rates into the view currency. Open question | One `fx_rate` | `fx_rate_usd` for USD only. Other currencies show as posted |
| PDF | Headless Chromium (bigger image) or React-PDF. Open question | Pinned-font HTML template. Run a spike to choose the renderer | `window.print()` on a print route, with no server-side Chrome |
| Key secret | `APP_SECRET` env var | `APP_ENCRYPTION_KEY`, which Compose must require or generate | Generated `data/secret.key` (mode 0600). Falls back to plaintext with a warning |
| Slices | 38 small tasks | 13 bigger tasks, with the first value at task 7 | 22 tasks |
| Extras | `?` shortcut sheet, `s` to save, `d` to dismiss, an `exports` table | Separate `workspace_preferences` table for the selected files, optimistic board UI | A manual theme toggle (conflicts with decision 39), and C notes that no manual eligibility override exists |

## Weak spots found

- C: storing fact provenance as `uuid[]` has no FK and keeps no snapshot. The manual theme toggle goes beyond decision 39.
- A: 38 tasks is a lot of overhead for a solo build. The `exports` table is probably unnecessary.
- B: keeping every output generation plus `profile_documents` as `bytea` adds weight. Its first value only arrives at task 7 of 13.
