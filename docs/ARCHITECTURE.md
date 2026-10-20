# hanapbuhay architecture

This file describes how hanapbuhay is built: the layers, the data model and the main flows. It describes the code as it is. The reasons behind each rule are in [DECISIONS.md](DECISIONS.md), cited here as "decision N". The Chrome extension is documented in [EXTENSION.md](EXTENSION.md).

## Layers

The SPA talks HTTP to the Hono routes. Routes call services. Services call `db`, `adapters` and `domain`. Every layer may import `shared`.

| Layer | Folder | Contains | May import |
|---|---|---|---|
| shared | `src/shared` | Zod schemas for the API, enums, labels, blocked hosts | `shared`, `zod` |
| domain | `src/domain` | Pure rules: dedup, eligibility, match, pay, skills, citations, gate, sync plan, fact diff, prompts, tailoring, project scan | `shared`, `domain` |
| adapters | `src/server/adapters` | All I/O: HTTP, job sources, AI, page reader, CV extraction, PDF, key file, git, GitHub, GitLab, folders, exchange rates | `shared`, `domain`, `adapters`, npm |
| db | `src/server/db` | Schema, app connection, sync-role session, lock ids, migrations | `shared`, `db`, npm; `domain` types only |
| services | `src/server/services` | Use cases. Each opens its own transactions and reaches adapters through the injected `Deps` | `shared`, `domain`, `db`, `adapters`, `services`, npm |
| http | `src/server/http` | The Hono app, guards and routes. A route validates input and calls one service | `shared`, `services`, `http`, npm |
| web | `src/web` | The SPA: routes, components, shadcn UI, TanStack Query hooks | `shared`, `web`, npm, `import type` from the server |
| root | `src/server/*.ts` | `main.ts` (composition root), `env.ts`, `healthcheck.ts` | every server layer |

### How the rules are enforced

- **`test/architecture.test.ts`** walks `src/**/*.{ts,tsx}`, reads each file's imports with `Bun.Transpiler.scanImports`, resolves `@/` and relative paths to a layer, and checks the `RULES` table above. `scanImports` drops type-only imports. So the SPA's `import type { AppType }` passes, and any value import from the server fails.
- The same test forbids `node:*` and `bun` imports in `shared` and `domain`, and `Date.now()`, `new Date()` with no argument and `Math.random()` in `domain`. Callers pass `now` in.
- `src/server/services/sync.ts` may not import `src/server/db/client.ts`. It gets its database handle only from `asSync()` (see [What sync may write](#what-sync-may-write)).
- `extension/test/architecture.test.ts` keeps extension code from importing the server. The extension shares only `src/shared` through the `@shared/*` alias.
- Postgres grants enforce the sync rule at runtime, and `test/sync-invariant.test.ts` pins them.
- Biome runs with `--error-on-warnings`, including `noExplicitAny`, `noNonNullAssertion` and `useExhaustiveDependencies`. TypeScript runs with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `bun run check` runs Biome, both `tsc` projects and all three test suites.

## Where validation lives

| Boundary | What validates | Result |
|---|---|---|
| HTTP request | `validate()` (`http/validate.ts`, a `zValidator` wrapper) with schemas from `src/shared/api.ts` and `src/shared/extension.ts` | 400 with the Zod issues. |
| Host and Origin | `http/local-guard.ts`, and `http/extension-guard.ts` for `/api/extension/*` | 403 `forbidden_origin` (decision 56). |
| Environment | `parseEnv` in `src/server/env.ts` | The process refuses to start. |
| Source payloads | A Zod schema per source adapter | A bad envelope fails the run. Bad items are skipped. |
| Fetched pages | `adapters/page-reader.ts`: JSON-LD `JobPosting`, then Readability | Too little text is `needs_paste`. |
| AI replies | `services/ai-replies.ts` and the domain reply parsers | One retry, then the task fails or keeps what passed. |
| Model claims | `checkDraft` and `checkStyle` | Unbacked sentences become `[[Check this: …]]` blanks. |
| Database | CHECK, FK, UNIQUE and partial unique indexes | See [Data model](#data-model). |
| Domain | Nothing | Trusts typed inputs and returns discriminated unions. |

Every enum lives once in `src/shared/enums.ts`. The Zod enum and the database CHECK both come from the same array: `oneOf()` in `schema.ts` builds each `IN (…)` list.

## How API types reach the SPA

- Request and response schemas live in `src/shared/api.ts`. Their types are `z.infer` of those schemas. Services return these DTO types already shaped for display: pay converted and formatted, hours in Philippine time, labels resolved. The SPA never imports domain code.
- `createApp` in `src/server/http/app.ts` chains every route module on one Hono app with `basePath("/api")`. `export type AppType = ReturnType<typeof createApp>`.
- `src/web/api.ts` builds the client with `hc<AppType>(location.origin)`. `src/web/queries.ts` wraps calls in TanStack Query hooks.
- Errors have one shape, `ApiErrorBody`: `{ error: { code, message, details? } }`. Services throw `AppError`, and `onError` in `app.ts` maps it. Status codes live in `services/context.ts`. The SPA's `ApiError` reads two codes specially: `needs_input` (409, `details` is `GateBlocker[]`, read as `.blockers`) and `over_cap` (402, read as `.overCap`). An unknown code reads as `internal`. Other codes the SPA shows by message include `refresh_running` (409), `frozen` (409), `not_exportable` (400) and `output_changed`.
- The extension does not use the Hono client. `extension/src/api/client.ts` calls `fetch` and parses every response with the shared Zod schema.

## Runtime shape

- **Dev:** `bun run dev` runs `bun --watch src/server/main.ts` on port 3000. `bun run dev:web` runs Vite on 5173 and proxies `/api` with `changeOrigin: false`, so the Origin check sees a matching Host.
- **Prod:** one Bun process. Hono serves `/api/*` and the built SPA from `HB_STATIC_DIR` with `serveStatic` and an `index.html` fallback. `compose.yaml` runs `postgres:18` and the app, both published on 127.0.0.1 only. The `appdata` volume holds the AI key file.
- **Boot** (`main.ts`): parse env, run migrations, ensure the single `users` row, seed the five built-in sources, mark `running` tasks as `interrupted`, build `Deps`, and serve.
- **Long work** runs as tasks (decision 36). `startTask` writes a `tasks` row and runs the work in this process. The SPA polls the row, and `ctx.step()` records progress text. Task kinds: `refresh`, `split`, `draft`, `suggest_questions`, `github_read`, `roles_read`.
- **AI** goes through `runAi` in `services/ai.ts`. It checks the monthly cap against an estimate (402 `over_cap` unless the caller confirms), calls the provider and writes one `ai_calls` row. Two tiers: `light` (split, eligibility, questions, roles, GitHub reads) and `writing` (requirement map, drafts, tailoring).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local `hanapbuhay` database | Postgres 16 or later (the sync role grant needs it). |
| `PORT`, `HB_HOST` | `3000`, `127.0.0.1` | The image sets `0.0.0.0`. |
| `HB_ALLOWED_HOSTS` | empty | Extra hostnames the Host check accepts. |
| `HB_STATIC_DIR`, `HB_DATA_DIR` | `./dist`, `./data` | Built SPA; AI key files. |
| `HB_CHROMIUM_PATH` | unset | Chromium for PDF export. |
| `HB_AI` | `live` | `live` (saved key), `pi` (decision 48) or `fake`. |
| `HB_PI_*` | `pi`, Haiku and Opus models | pi binary, model and thinking level per tier. |
| `HB_SOURCES`, `HB_GITHUB`, `HB_FX` | `live`, `public`, `live` | `fixture` reads recorded files from the matching `*_DIR`. `HB_GITHUB=gh` uses the gh CLI. |
| `HB_GITHUB_USER` | unset | Your GitHub login. Required with `HB_GITHUB=gh`. |
| `HB_PROJECTS_DIR` | unset | Folders for Find my projects (decision 79). |
| `HB_GITLAB_HOSTS`, `HB_GIT_EMAILS` | unset | Self-hosted GitLab hosts (decision 80); extra commit emails. |

With `HB_AI=pi`, both provider slots use the pi client, and `ai_calls.provider` records `anthropic`. Settings shows the pi models instead of the key form.

## Folder map

```
drizzle/          SQL migrations; 0004 and 0006 hold the hb_sync grants
src/shared/       api.ts enums.ts labels.ts extension.ts hosts.ts
src/domain/       pure rules, drafting-guide.md, co-located *.test.ts
src/server/       main.ts env.ts healthcheck.ts
  adapters/       http page-reader extract pdf key-store fx git github gitlab local-projects ...
    ai/           anthropic openai pi fake pricing
    sources/      5 built-in boards, 6 company-board ATSs, fixture
  db/             schema client sync-session locks migrate
  services/       one module per use case; extension-*.ts
  http/           app.ts guards validate.ts routes/ routes/extension/
src/web/          SPA
test/             service tests on real Postgres; budget/; fixtures/
e2e/ e2e-extension/   Playwright (HB_AI=fake, fixture sources)
extension/        the Chrome extension
eval/             eligibility, drafting, roles and GitHub eval sets
```

## Data model

There are 20 tables. Every table except `users` carries `user_id` referencing `users(id) ON DELETE CASCADE` (decision 28). There is one user row today. Enums are `text` with CHECK constraints built from `src/shared/enums.ts`. All timestamps are `timestamptz`.

### Profile

| Table | Purpose | Key invariants |
|---|---|---|
| `users` | Contact, targeting, minimum pay, standard answers, view currency and rates, AI provider, models and cap. | One row. `monthly_cap_usd > 0`. Only `ai_key_hint` is stored; the key is a 0600 file in `HB_DATA_DIR`. |
| `profile_items` | The CV and the add-ons (`experience`, `open_source`, `challenge`, `other`): text, link, skills, usage, `rev`, and project columns (`github_rev`, `github_private`, `folder`, project role). | One `cv` per user (partial unique index). A CV's usage is `everywhere`, and it has no `folder`. |
| `roles` | Jobs read from a CV or experience add-on (decision 71). | Cascade with the item. Title and company non-blank. |
| `facts` | One claim each. The prompt key is `FACT-<no>`, from a global identity column. | `pending` or `confirmed`; only confirmed facts are used (decision 1). `role_id` is `SET NULL`. `(origin = 'github') = (evidence IS NOT NULL)`. |
| `cv_files` | The uploaded CV PDF (decision 69). | One per user, PDF only, at most 5 MB. |
| `user_skills` | Skills added to or hidden from matching (decision 66). | Key `(user_id, key)`, so a skill is never both. |
| `hidden_companies` | Companies Matches hides, keyed by `company_key` (decision 65). | Primary key `(user_id, company_key)`. |

### Jobs

| Table | Purpose | Key invariants |
|---|---|---|
| `jobs` | One posting, deduplicated across sources: text, dedup keys, pay, hours, `skills`, `nice_skills`, `skills_stamp`, eligibility and phrase, `closed_at`, a `search` tsvector. | Unique `(user_id, apply_url_key, title_key)`. `nice_skills <@ skills`. A phrase unless `unclear`. `fillfactor = 50` (decision 68). |
| `sources` | Built-in and company boards, keywords, `last_*` run columns. | `board` set exactly for company boards. Unique `(user_id, kind, board)`. |
| `job_listings` | Where a job was seen, keyed `(source_id, external_id)`. | One primary listing per job, whose content fills the job. A job closes when all its listings are missing. |
| `role_drops` | Slim rows for postings the role filter dropped, shown under Filtered out (decision 53). | Each good run of a source replaces that source's rows. |
| `eligibility_overrides` | An excluded job the user moved back to Matches (decision 53). | Sync has no grant on it, so no Refresh undoes it. |

### Applications

| Table | Purpose | Key invariants |
|---|---|---|
| `opportunities` | A job the user touched: status, outcome, history, dismissal, notes, `ready_at`, `applied_snapshot`, contract fields, the cached requirement map. | One per job; the job FK is `RESTRICT`, so the prune keeps touched jobs. `(status = 'closed') = (outcome IS NOT NULL)`. On the board or dismissed, never both. |
| `outputs` | Files (`resume`, `letter`, `message`) and answers: body, `included`, question, `must_answer`, style hits, `reviewed_at`, `tailoring`. | One file per kind. A must-answer output has no `ai_call_id` or `generated_at`, so it is never drafted (decision 24). `tailoring` only on a resume. |
| `output_facts` | Cited facts, with a text snapshot. | `fact_id` is `SET NULL` on delete, which is how the gate finds a deleted fact. |

### System and extension

| Table | Purpose | Key invariants |
|---|---|---|
| `tasks` | Long work: kind, status, step, `input` (enough to retry), result. | One running `refresh` per user. |
| `ai_calls` | One row per AI call: tier, purpose, provider, model, tokens, cost. The month's spend sums these. | Tailoring records purpose `draft`. |
| `extension_pairings` | A paired extension: hashes of the code and token, the bound origin. | Claimed exactly when token hash and origin are set. |
| `application_sessions` | The Apply handoff to the panel (decision 57). | One `pending` or `claimed` session per user. |
| `application_preferences` | Saved prefill answers, global or per opportunity. | One row per category and scope. |

### What sync may write

Refresh runs as the Postgres role `hb_sync` (decision 34). `asSync()` in `db/sync-session.ts` opens a transaction, runs `SET LOCAL ROLE hb_sync`, takes `MERGE_SYNC_LOCK` shared, and then runs the caller's function. Migration 0004 creates the role `NOLOGIN` and grants it to the app role `WITH INHERIT FALSE, SET TRUE`.

| Table | `hb_sync` may |
|---|---|
| `jobs`, `job_listings` | SELECT, INSERT, UPDATE, DELETE |
| `sources` | SELECT; UPDATE only `last_run_at`, `last_ok_at`, `last_status`, `last_count`, `last_ok_count`, `last_dropped`, `last_error` |
| `ai_calls` | SELECT, INSERT |
| `role_drops` | INSERT, DELETE, SELECT `source_id` (migration 0006) |
| `users` | SELECT `id`, `target_titles`, `role_families`, `exclude_title_words`, `ai_provider`, `model_light`, `monthly_cap_usd`, `ai_eligibility_on_refresh` |
| `opportunities` | SELECT `job_id` |

No migration uses `ALTER DEFAULT PRIVILEGES`, so a new table is closed to sync until a migration grants it. The extension tables, `user_skills`, `cv_files` and `eligibility_overrides` have no grant. `test/sync-invariant.test.ts` checks that the grants are exactly this table, that other writes as `hb_sync` fail with 42501, and that six Refresh scenarios leave every user table byte-identical.

`MERGE_SYNC_LOCK` (`db/locks.ts`) is taken exclusive by a user merge (before its `refresh_running` check) and by adding or removing a user skill (decision 68). Refresh holds it shared per source transaction.

## Key flows

### Refresh (sync)

`POST /api/refresh` calls `startRefresh` in `services/sources.ts`. It ensures the built-in sources, starts a `refresh` task (409 `refresh_running` if one runs), loads the user's skill dictionary as the app role (sync cannot read `user_skills`), runs `runRefresh` in `services/sync.ts`, and ends with `fillRatesIfDue` as the app role. `GET /api/refresh` returns the latest run.

Per enabled source:

1. **Skip** a source whose last run is inside its `minIntervalMinutes` (15 to 60 by adapter, longer for Remotive). It records `skipped` and closes nothing.
2. **Fetch** outside any transaction, through `adapters/http.ts`: user agent `hanapbuhay/0.1 (personal use)`, 2 requests at a time per host, 400 to 900 ms between them, 10 s timeout, 3 attempts, `Retry-After` honored, 2 MB cap. Company boards return the whole board (`complete: true`). Built-in boards return a recent window (`complete: false`) and are filtered to the keywords locally.
3. **Filter** every posting with `roleFit` (decisions 44 and 53). Sure drops go to `role_drops` and `last_dropped`. `keep` and `unsure` continue.
4. **Normalize** with domain code: text, dedup keys, skills with the user's dictionary, seniority, minimum years, pay, hours, eligibility, content hash.
5. **Plan** with `planSourceRun`, a pure function. It returns `failed` or `rate_limited` (write the `last_*` columns only), `suspicious_empty` (zero postings after a run that had some: change nothing), or `ok` with upserts. The empty check counts postings before any filter.
6. **Apply** an `ok` plan in one `asSync` transaction: mark seen listings, rewrite a job when its primary listing's content changed, attach a listing to an exact-match job, or insert a job. A complete source marks listings it did not return as missing. An incomplete source marks a listing missing when the job expired or when `last_ok_at` is more than `STALE_DAYS` (30) past its `last_seen_at`, so a failing source closes nothing. `closed_at` is recomputed; a returning job reopens.

After all sources: re-read skills for open jobs whose `skills_stamp` is stale (decision 68), run the optional AI eligibility pass, and prune. The AI pass sends at most `AI_PASS_LIMIT` (25) new `unclear` jobs to the light tier when `ai_eligibility_on_refresh` is on and a key is set. `acceptAiVerdict` accepts a verdict only when its phrase is a verbatim substring of the description, at least `MIN_AI_PHRASE` long and with a letter in it. The pass is skipped if it would cross the cap. The prune deletes jobs closed more than `PRUNE_DAYS` (60) ago with no opportunity (decision 15).

**Exact-match merge** (decisions 10 and 46): two postings are one job when they share `apply_url_key` and `title_key`, or `company_key`, `title_key` and `description_key` within `AUTO_MERGE_DAYS` (28). Same company and title alone never merges. `likelyDuplicates` suggests a manual merge for the same company with title Jaccard ≥ 0.5, or the same title with description shingle Jaccard ≥ 0.8. `POST /api/jobs/:id/merge` keeps the job with an opportunity and refuses when both have one.

### Add by link

`POST /api/jobs/from-link` runs `addJobFromLink` in `services/jobs.ts` synchronously and returns `AddLinkResult`:

1. A host in `src/shared/hosts.ts` (LinkedIn, Indeed, JobStreet, Upwork and others) returns `needs_paste` with `blocked_host`. No request is sent (decision 61).
2. A link whose `apply_url_key` matches exactly one job returns `existing`, creating its opportunity if needed. Several matches mean a generic careers page, so the flow continues.
3. The page is fetched once. A failed fetch returns `needs_paste` with `fetch_failed`.
4. `readPage` prefers a JSON-LD `JobPosting` and falls back to Readability. No title, no company, or under `MIN_DESCRIPTION_CHARS` (600) returns `needs_paste` with `too_little_text` and whatever was found as prefill.
5. Otherwise `addJob` runs: derive the job's columns, look for the same posting with `findSamePosting`, and create the job (`origin = 'link'`), its opportunity and its file rows.

`POST /api/jobs/from-paste` uses the same `addJob` with `origin = 'paste'`. Pasted and linked jobs skip the role filter.

### CV to facts

1. **Input** (decision 5). A PDF goes through `unpdf` and a DOCX through `mammoth` (`adapters/extract.ts`). A PDF with under 200 characters of text is refused as having no text layer. PDF text is cleaned without changing a word (decision 49). A PDF of 5 MB or less is kept in `cv_files` (decision 69).
2. **Split** in a `split` task. Without an AI key, the rule splitter in `domain/split.ts` runs at no cost. With a key, the light tier splits; an unreadable reply is retried once, and a second one fails the task. Skills lines stay whole (decision 63), and each fact keeps its `section` only when the text contains it word for word (decision 62). The cap check sums one estimate for the batch (decision 81).
3. **Check** each candidate with `checkDraft`, with the item's own text as the only evidence. A number, name, skill or URL that the text lacks drops the candidate.
4. **Diff** with `diffFacts` (decision 47). A matching existing fact keeps its id, key, status and citations. A new candidate arrives `pending`. A vanished pending fact is deleted. A vanished confirmed fact stays and shows under "Not in your latest CV" with Keep and Delete. The apply step locks the item row, so a newer `rev` wins over a slower split. GitHub-origin facts are diffed only by GitHub reads, against `github_rev`.
5. **Confirm** on Profile. Only confirmed facts count.

A CV or experience add-on also has its roles read in the same task.

### Roles

Roles are records (decision 71). `domain/work-roles.ts` finds header blocks: up to 4 lines with no bullet text that name a title and a company. The light tier reads the role fields, and `checkRoles` keeps a field only when the role's own header block contains it. `services/roles.ts` links a fact to a role when the fact's section names exactly one role's company. Roles are editable on Profile, and a `roles_read` task reads them again for an item split before roles existed.

In a resume draft the model writes `[ROLE-n]`. `expandRoles` replaces it with `### Title | Company, Location | Start – End`, so the model never types a header. `checkDraft` reports `unknown_role` for a key that does not exist and `wrong_role` for a sentence that cites a fact of another role. Roles keep the CV's order.

### Drafting with citations

`POST /api/opportunities/:id/draft` checks the cap and starts a `draft` task. It refuses with 409 `frozen` on an applied job and never drafts a must-answer output. For each target output, `draftOne` in `services/workspace.ts` runs these steps:

1. **Requirement map** (decision 73). Once per posting and fact set, one writing-tier call lists up to `MAX_REQUIREMENTS` (16) requirements, each with a weight (`must`, `duty` or `nice`) and the confirmed facts that prove it, plus one `context` fact per role. It is stored on the opportunity under `requirement_map_key`, a hash of the posting and the facts. Unknown fact keys are dropped. A requirement with no facts is a gap that the draft never mentions.
2. **Resume from the base CV**, when the CV parses. See [Tailoring from the base CV](#tailoring-from-the-base-cv).
3. **Prompt** from the map, the selected facts as `FACT-n: text`, roles as `ROLE-n` and projects as `PROJECT-n`. A resume leaves out `letters_only` facts and keeps only the context fact of a role that proves nothing. Facts that prove a requirement, and facts with a number in a role that proves something, are REQUIRED (decision 74). A private repo's link is never shown to the model or exported.
4. **Check** with `checkDraft`. It returns one of 8 violation kinds: `unknown_fact`, `unsupported_token` (a number, date, amount, URL, email, dictionary skill or proper noun that the cited facts lack), `uncited_claim`, `unknown_role`, `wrong_role`, `unknown_project`, `wrong_project` and `claims_contribution`.
5. **Retry once** with the violations and any missing REQUIRED keys. Sentences that still fail become `[[Check this: …]]` blanks through `quarantineViolations`. A required fact still missing after the retry is accepted.
6. **Style rewrite** (decision 43). `checkStyle` flags dashes, banned phrases, long sentences, and in a resume `pronoun`, `repeated_opener` and `same_shape` (decision 72). One AI call rewrites only the flagged sentences, and a rewrite that fails `checkDraft` is discarded. Remaining hits are stored as warnings, which the gate ignores.
7. **Save** the body, `ai_call_id`, `generated_at` and fresh `output_facts` snapshots, and clear `reviewed_at`.

Edits through `PATCH /api/outputs/:id` are not checked for invented claims. A clean-text edit gets its fact markers back for the sentences the user left unchanged. Every edit re-runs `checkStyle` without AI, clears `reviewed_at` (decision 58) and drops the tailoring. `POST /api/outputs/:id/fill` answers blanks in one transaction. An answer to a missing-information blank marked "save as fact" becomes one confirmed fact, `label: answer`, with no split. `saveDraftingFacts` in `services/profile.ts` keeps these facts in an `other` add-on titled "Filled in while drafting" (`DRAFTING_ADDON_TITLE`). The add-on is created on first use, its `rev` does not change, and a line it already has is skipped. A later edit on Profile re-splits it like any add-on.

An output is outdated when a fact it cites was `edited`, `deleted`, `unconfirmed` or made `letters_only` (decision 26). Frozen outputs never show as outdated. Questions are added by hand or suggested by the light tier (`suggest_questions`). `classifyQuestion` marks salary, work authorization, notice, start date and references as must-answer (decision 24).

Files show as cards, never as marked-up text (decision 70). Copy text and the PDF strip markers. The preview PDF is not gated and shows blanks highlighted. A resume card warns that the resume likely runs past one page when it has more than `RESUME_ONE_PAGE_WORDS` (400) words (`resumeLikelyLong` in `src/shared/labels.ts`). The word count only estimates, so it is a warning, and Preview PDF shows the real length.

Filling a `[[Missing: …]]` blank can save the answer as a fact. `fillOutputBlanks` in `services/workspace.ts` passes each ticked answer to `saveDraftingFacts`, which adds it as one confirmed fact to the `other` add-on titled "Filled in while drafting" (`DRAFTING_ADDON_TITLE`), creating the add-on on first use. The line is not split or reviewed, since the user wrote it. A line the add-on already has is skipped.

### The drafting guide

The guide lives in `src/domain/drafting-guide.md`. `src/domain/guide.ts` imports it with `with { type: "text" }` (decision 72). `docs/drafting-guide.md` is only a pointer to it.

`guideFor` builds each system prompt from the shared sections ("How this guide is used", "Facts and limits", "Tailoring to the posting", "Shared rules", "Sounds like a person") plus the section for the kind: "Resume", "Cover letter", "Short message (job)", "Short message (contract proposal)" or "Application answer". Tailoring uses "Editing a base resume". Source references are stripped. A missing heading throws, and a test fails when a needed heading is renamed.

### Tailoring from the base CV

When the CV parses into usable lines (`parseBaseCv` and `isUsableBase` in `domain/base-cv.ts`), the resume starts as that CV (decision 75). `mapFactsToLines` ties facts to lines at `FACT_LINE_COVERAGE` (0.6) or more. One writing-tier call returns a list of `TailorOp` edits to numbered base lines:

| Op | Does |
|---|---|
| `summary` | Rewrites the Summary. |
| `order` | Reorders lines under one parent. |
| `reword` | Rewrites one line. |
| `remove` | Removes one line. |
| `add` | Adds a line after another. |
| `project` | Adds a project the CV lacks, with its lines (decision 82, at most 2). |

`validateEdits` drops an edit that introduces a tool, number or name its facts lack, cites the wrong role or project, claims a contribution as the user's own, starts with a pronoun, removes a line holding a REQUIRED fact (`protected`), or removes a project's last line (`only_description`, decision 77). One retry follows when edits were dropped or the reply was unreadable. If no reply can be read, the resume is the CV as it is, never generated from facts.

`outputs.tailoring` stores the base, its hash, the changes with their status and the map. The body is always derived: the base with every change the user has not undone. `POST /api/outputs/:id/changes` keeps or undoes changes and re-derives the body, citations and style hits in one transaction. A change id that no longer exists returns `output_changed`. Any direct edit drops the tailoring.

### The "Needs your input" gate

`checkGate` in `domain/gate.ts` is the only definition of the gate (decision 25). Only included outputs count. It returns `ok`, or blockers of four kinds:

| Blocker | When |
|---|---|
| `must_answer` | A must-answer output whose body, or else the matching standard answer, is empty. |
| `not_drafted` | An included file with no body. |
| `placeholder` | A `[[…]]` blank in an included body. |
| `deleted_fact` | The output cites a fact that was deleted. |

The server runs the gate in `markReady` (`POST /api/opportunities/:id/ready`), `exportPdf` and `exportText`. Each returns 409 `needs_input` with the blockers. Exporting an unticked output, or a PDF of a text-only kind, is 400 `not_exportable`. The workspace shows Ready only when `ready_at` is set and the gate still passes on current data. The extension's materials PDF goes through the same export path.

Marking a job Applied is not gated. `FROZEN_STATUSES` are `applied`, `interviewing`, `offer` and `closed`. `changeStatus` in `services/board.ts` writes `applied_snapshot` and copies the standard answers into must-answer bodies when a job moves from Saved into a frozen status. While frozen, every output write returns 409 `frozen` and no output shows as outdated (decision 26). Moving back to Saved unfreezes the outputs. The snapshot stays until the next move into a frozen status replaces it. `FOLLOW_UP_DAYS` (14) drives the "follow up or close?" hint on the board (decision 18).

### Eligibility rules

`classifyEligibility` in `domain/eligibility.ts` runs an ordered rule list and stops at the first hit (decision 7). Each hit returns a verdict and the matched phrase, which the UI shows.

| Order | Rule | Verdict |
|---|---|---|
| 1 | Philippines excluded | `excluded` |
| 2 | Philippines named | `ph` |
| 3 | Locked to a country or region | `excluded` |
| 4 | APAC | `apac` |
| 5 | Americas | `americas` |
| 6 | Worldwide | `worldwide` |
| then | Structured location from the source (`StructuredLocation`): an empty restriction list is `worldwide`, a list without PH is `excluded` | |
| else | No rule hit | `unclear`, no phrase |

Exclusion runs before inclusion. The AI pass can turn `unclear` into a verdict only with a verbatim phrase (see [Refresh](#refresh-sync)). Excluded jobs leave Matches and show under Filtered out. An override moves one back (decision 53).

### Match rules

`matchJob` in `domain/match.ts` computes the level on every read, so a confirmed fact or a new target shows on the next request (decision 9). `services/matches.ts` loads the targeting once per request and returns at most `MAX_MATCHES` (500) rows.

| Input | Rule |
|---|---|
| Title | Best token Jaccard against the target titles, seniority words removed. ≥ `TITLE_FIT` (0.6) is a fit, ≥ `TITLE_PARTIAL` (0.3) partial. |
| Skills | Required skills matched over required skills asked; nice-to-have skills counted apart and neutral when missing (decision 76). Reasons name up to `MAX_SKILLS_NAMED` (5). |
| Seniority | A gap of 2 or more steps on the ladder is a negative. |
| Years | `min_years > years + 1` is a negative. |
| Eligibility | `ph`, `worldwide`, `apac` are positive. `americas` caps at Possible. `excluded` is Weak, and Possible at most when overridden. |
| Role filter | `unsure` shows a "Role unclear" chip and caps at Possible. |

- **Strong:** title fit or partial, coverage ≥ `STRONG_COVERAGE` (0.6), no negative, not capped.
- **Weak:** no title fit, or coverage < `WEAK_COVERAGE` (0.3) with at least `WEAK_MIN_JOB_SKILLS` (3) skills, or excluded.
- **Possible:** everything else.

Within a level, Matches sorts by search rank, then the required-skill share, then the count, then newest (decision 63). Pay never changes the level. The pay filter converts to monthly in the view currency (173.33 hours, 21.67 days or 4.33 weeks a month) and never hides a job with no pay or no rate (decision 20).

`roleFit` in `domain/roles.ts` returns `keep`, `unsure` or `drop` from a rule table of families and head nouns (decision 44). Only `drop` happens at sync. `unsure` is computed on read.

### Skills

- `SKILLS` in `domain/features.ts` is the built-in dictionary of 108 skills, versioned by `BUILTIN_SKILLS_VERSION` (2). `compileSkills` adds the user's own added skills.
- The profile's skills are the skills named in confirmed facts, plus `added` skills, minus `hidden` ones (decision 66).
- A job's `skills` are read with the dictionary, and `nice_skills` are those named only in nice-to-have text (decision 76). On read, Matches keeps only skills still in the dictionary.
- `jobs.skills_stamp` records the dictionary a job was read with. Refresh re-reads only open jobs with a stale stamp.
- `PUT /api/profile/skills` (`setSkill`) updates open jobs in the same transaction, under `MERGE_SYNC_LOCK`. `strpos` on `lower(title || description)` narrows the jobs, and the exact regex decides (decision 68). Hiding is a read-time filter and writes no job.
- `test/budget/skills.test.ts` pins the budgets on 2,000 jobs: 300 ms to add a skill, 100 ms for an idle re-read.

### Exchange rates

Rates convert job pay into the view currency (decision 67). `users.fx_rates` maps each currency to view-currency units per 1 unit, with who set it. `normalizeRates` in `domain/fx.ts` reads an entry without `by` as typed by the user.

- **Sources** (`adapters/fx.ts`): ECB rates through Frankfurter, crossed to the view currency, then currency-api for the rest (decision 67).
- **Needed currencies** (`neededCurrencies`): the pay currencies of open jobs, the minimum-pay currency and currencies already fetched. Never the view currency.
- **When** (`fillDue`): when there was no fetch yet; after `FILL_EVERY_MS` (20 hours); when a needed currency has no rate and is not marked unsupported; or `RETRY_FAILED_MS` (1 hour) after a failure. Refresh ends with `fillRatesIfDue`. **Fill rates** in Settings skips the check.
- **Merge:** under a lock on the user row. A user-typed rate is never overwritten, and removing it returns the currency to automatic. A failed fetch keeps the rates, shows its error and never fails the Refresh. `users.fx_fetch` holds the last fetch status and is outside the sync grants.

### Projects: find, read and cite

**Find** (`services/projects.ts`, decisions 78, 79, 85, 86). Find my projects lists repos from up to three places, and nothing is saved by a scan:

- With `HB_GITHUB=gh`: the repos `HB_GITHUB_USER` owns, private ones included.
- Without gh: the public repos of `HB_GITHUB_USER`, the GitHub profile in the contact links, or a pasted profile. A profile that differs from either is refused. One search lists merged pull requests in other people's public repos as Contributions.
- With `HB_PROJECTS_DIR`: its subfolders, one level deep (`adapters/local-projects.ts`).

`scanRepos` in `domain/repo-scan.ts` moves rows to "Hidden by rules" with a reason: forks, the profile README repo, repos under `MIN_REPO_KB` (5), fewer than `MIN_OWN_COMMITS` (5) of your commits or under half, folders that are not git repos, and clones whose GitHub owner is someone else (`owned_by`, decision 85). Archived repos and repos with no push in `STALE_MONTHS` (18) show with a warning. Counted repos order by your commits, then size. Stars show but never change the order.

Without gh the API allows 60 calls an hour, so `countPlan` counts at most `COUNT_CAP` (30) repos and keeps `COUNT_RESERVE` (10) of the hour's remaining calls for reads and fills. Forks and the profile repo are counted last, the rest newest push first, and a rate-limit reply stops counting. When some repos go uncounted, the count note says "Counted commits for N of M repos" and suggests `HB_GITHUB=gh`. With gh there is no cap, and the note asks for a new scan when GitHub has not finished counting. A pull request under `TINY_PULL_LINES` (10) changed lines gets a note after you pick it. A local clone of a listed repo shows once, under GitHub. One source failing does not hide the other. Add lists again and adds only names it found, each as an `open_source` add-on.

**Read** (`services/github.ts`, decisions 55 and 81). A `github_read` task reads one project at a time. A folder wins over a GitHub link on the same add-on.

A read takes the README, manifests, file tree and up to `MAX_GITHUB_PICKS` (5) picked files within `GITHUB_TOKEN_CAP` (12,000) tokens, plus up to `MAX_GITHUB_COMMITS` (50) of your commits (by login, `git config` email, `HB_GIT_EMAILS` or the noreply address). The light tier groups your commits into up to `MAX_FEATURES` (6) features and reads the hunks of up to `MAX_FEATURE_COMMITS` (3) commits each, from a local clone, the API or a temporary clone. A project is your own when at least half its commits are yours. Facts come only from your commits, and secret and git-ignored files are never read. The proposals are diffed against the item's GitHub facts like a CV re-import (decision 47), and `checkSplitsCap` adds the read's estimate. `projectRoleOf` in `domain/project-role.ts` decides the role: the user's choice, then the last read, then the link (another account's repo or any pull request is a contribution).

**Cite** (decisions 77, 82, 83, 84). The drafter writes `[PROJECT-n]`, and the server writes the head (name, public link, stack) and moves it to `## Projects` (own) or `## Open Source Contributions`. An own project is one paragraph of 2 to 4 sentences. A contribution keeps up to 3 stack skills and 1 to 3 bullets. `checkDraft` keeps each fact under its own project's head (`wrong_project`) and refuses "built" or "owns" about a contribution (`claims_contribution`). A private project's link never appears in an export. The guide's rules from [research/projects.md](research/projects.md) decide when a project earns its place (decision 84).

### Chrome extension: server side

The extension's user guide, permissions and threat model are in [EXTENSION.md](EXTENSION.md). On the server:

- `/api/extension-web/*` serves the SPA (pairings, the Apply session) behind the normal guards.
- `/api/extension/*` serves the extension. `pair/claim` binds a `chrome-extension://` Origin. Every other route needs the bearer token, and CORS echoes only the paired origin (decision 56). Codes and sessions expire per decision 57.
- `domain/prefill.ts` fills fields from saved preferences and reviewed outputs only (decision 58). A `combobox` field is returned as `unsupported_control` and listed under "Left blank" (decision 59). Files go through the export gate.

## Open work

### Planned, not built

Each unbuilt item has a feature doc in [features/](features/), listed with its status in [MVP.md](MVP.md#features). They stay frozen until a real application needs them. Longer-term items are in the "Later" list of [DECISIONS.md](DECISIONS.md).

### Open risks

| Risk | Current state |
|---|---|
| The sync role needs `CREATEROLE`. Compose's Postgres user is a superuser, but an external Postgres may not allow it. | `migrate.ts` shows no special message. Migration 0004 fails with Postgres's own error. |
| `SET LOCAL ROLE` lasts only inside a transaction. A sync query outside `asSync` would run as the app role. | The import rule and the sync invariant test guard it. |
| `checkDraft` flags some true sentences, such as a product name the user typed. | They become blanks for the user to fix. The eval sets track false positives. |
| Eligibility rules miss exclusions phrased in new ways. | `eval/eligibility/` grows from real misses. The phrase is always shown. |
| Matching on read may slow past about 20,000 open jobs. | `src/domain/match.test.ts` scores 20,000 jobs in under a second, in memory only. The database load and DTO build for that many jobs are not measured. |
| Hono RPC type inference may slow the editor as routes grow. | Routes are chained per module. `AppType` is not split yet. |
| Skill updates scan job text with `strpos`. | Decision 68 names a `pg_trgm` index as the next step past about 6,000 open jobs. |
