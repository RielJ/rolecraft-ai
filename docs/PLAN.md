# hanapbuhay: implementation plan

This plan builds on `docs/DECISIONS.md` and does not reopen any of its decisions (1 to 42, plus 43 to 47 added during synthesis). It combines four independent plans. Plan D (Opus 5.5) is the base because it was the simplest of the four and enforces its rules most strongly. Ideas from plans A (Opus 5), B (GPT 5.6 Sol) and C (GLM 5.2) are merged in where they were better. The source plans are in `docs/plans/`, and `docs/plans/abc-digest.md` compares A, B and C.

## How the four plans were combined

| Topic | Chosen | From | Rejected, and why |
|---|---|---|---|
| Sync never writes user data | A Postgres role `hb_sync` with no write grants on user tables, set per transaction with `SET LOCAL ROLE`. An exact-grants test, a `42501` test and a byte-identical test back it up | D | A's write-blocking wrapper, B's missing repo functions and C's column-list test are all checks in app code. A bug can get around them, but it cannot get around a Postgres grant |
| Touched jobs never pruned | `opportunities.job_id ... ON DELETE RESTRICT` | D (B similar) | C's single `jobs` table cannot use a foreign key as a backstop |
| Posting vs user data | `jobs` + `job_listings` (where it was seen) + `opportunities` | D, with B's attribution idea | C's single table mixes data that sync owns with data the user owns |
| Provenance | `output_facts` with a text snapshot and `fact_id ON DELETE SET NULL` | D (B's snapshot idea) | C's `uuid[]` has no FK and no snapshot. B's `ON DELETE RESTRICT` stops the user from deleting their own facts |
| Questions and answers | `outputs` rows with `kind = 'answer'` | D | A and B use three tables for something that behaves like a file |
| Match level | Computed on read, never stored | D | A's `job_matches` and C's columns can go stale when facts change |
| Output history | One row per output; asks before regenerating an edited one | D, A, C | B keeps every generation, which is extra weight with no v1 reader |
| Size | 11 tables, 11 slices | D | A has 38 tasks, B 13 (first value at task 7), C 22 |

## Checked before adopting

- **The sync role works under a superuser.** On Postgres 18, a superuser that runs `SET LOCAL ROLE hb_sync` gets `permission denied` when updating `opportunities` and when updating a `sources` column that isn't granted. Updates to the granted `last_status` column succeed. A prune with its `NOT EXISTS` condition missing is rejected by the RESTRICT foreign key, so the whole statement fails and nothing is deleted. `current_user` goes back to `postgres` after the transaction.
- **The architecture test can allow the SPA's type import.** In Bun 1.3.13, `Bun.Transpiler.scanImports` leaves out `import type { AppType }` and still reports value imports.

## Decisions made during synthesis

All twelve questions are answered. The Status column holds the user's answer. Where an answer changed a default, the sections below were edited to match: Q5a (natural writing, 3.4 and slice 2), Q9 (role filter, 3.7a and slices 6 and 7), Q10 (sources in setup, section 4 and slice 11) and Q11 (exact-match merge, 2, 3.2, 3.8 and slice 5). New decisions 43 to 47 in `DECISIONS.md` record them.

| # | Question | Default | Status |
|---|---|---|---|
| Q1 | Architecture: should services call Drizzle directly (no repository layer)? | Yes. The Postgres role enforces the sync rule | **decided: no repo layer; the Postgres role enforces it** |
| Q2 | PDF renderer | Headless Chromium rendering the same HTML as the preview | **decided: headless Chromium** |
| Q3 | Where the AI key lives | A 0600 file in the app data volume, not in Postgres | **decided: 0600 file** |
| Q4 | Add by link for sites that forbid automation | Skip the fetch and go straight to paste | **decided: skip the fetch** |
| Q5 | A cited fact gets deleted | Blocks the gate | **decided: blocks the gate. Markers stay inside the app only; PDF and Copy as text never show them** |
| Q5a | Outputs must not read as AI-written | Voice rules in the prompt; `checkStyle` flags AI tells, one targeted rewrite, leftovers are editor warnings | **decided: rewrite once, then warn (does not block export)** |
| Q6 | Is Copy as text gated? | Yes, same as PDF | **decided: gated like PDF** |
| Q7 | Applied files and answers | Read-only | **decided: read-only** |
| Q8 | CV re-import | Exact diff: keep unchanged, add new as pending, list vanished confirmed facts for Keep or Delete | **decided: line diff, ask about removals** |
| Q9 | Company boards | Keep every posting; filter only built-in boards by keywords | **decided: every source goes through a three-level role filter (keep / unsure, kept and tagged / sure drop), plus exclude words. See 3.7a** |
| Q10 | Built-in sources on first run | All five on | **decided: all five on, and the setup's first-refresh step lets you turn each off before syncing** |
| Q11 | Duplicate and staleness windows | Auto-merge by company + title within 28 days; feeds close a job after 30 days without a sighting | **decided: auto-merge only exact postings (apply URL + title, or company + title + same description within 28 days); same title alone is only a suggestion. Feeds close after 30 days. Narrows decision 10** |
| Q12 | FX rate shape | A flat map entered by hand, relative to the view currency | **decided: typed in Settings, per currency, with the date set** |

Section 6 has the trade-offs for each question.

---

## What this plan cuts, and why each cut is safe

| Cut | Replaced by | Why it is safe |
|---|---|---|
| Repository layer | Services call Drizzle directly | Drizzle is already a typed query API. The sync invariant is enforced by Postgres grants, not by which repo function you call. Tests run against real Postgres, so nothing needs a repo to mock. |
| Monorepo packages | One package with folders | The architecture test (section 1) enforces the same boundaries packages would, with one `package.json` and one `tsconfig.json`. |
| `questions`, `answers`, `answer_facts`, per-job file ticks | `outputs` rows with `kind = 'answer'` and an `included` flag | Files and answers need the same things: text, citations, outdated checks, the gate. CHECK constraints keep answer-only columns on answers. |
| `status_events` table | `opportunities.history jsonb` plus `status_changed_at` | History is only ever read for one opportunity at a time. The 14-day hint reads the column. If cross-job reporting arrives, a migration can unpack the array. |
| `job_matches` table and profile fingerprints | Match level computed on read by a pure function | It cannot go stale after a fact changes. A few thousand open jobs score in milliseconds. |
| `job_revisions` | `opportunities.applied_snapshot` | The only reader of an old posting is the user after applying. The snapshot is taken at that moment. |
| `source_runs` table | `last_*` columns on `sources` plus the refresh task's `result` | The suspicious-empty guard needs only the last good count. Per-run detail lives in the task result. |
| HTTP response cache | A minimum interval per source (30 min default, 6 h for Remotive) | A skipped source closes nothing, so skipping is always safe, and it respects Remotive's budget without a cache. |
| Stored HTML | Descriptions converted to plain text with paragraph and list breaks at ingest | There is no sanitizer and no XSS surface. Losing bold text in postings costs little. |
| `settings` and `profile` tables | Columns on the single `users` row | Both are 1:1 with the user, now and after accounts arrive. |
| Separate CV import table, stored CV file | `profile_items` row with `kind = 'cv'` holding the extracted text | Only the text is ever used. The user still has their file. |
| Fact-number counter | `facts.no` identity column, key `FACT-<no>` | Identity numbers are never reused, so a deleted `FACT-12` can never be confused with a new one. |
| Encrypted API key and its secret | The key lives in a 0600 file in the app's data volume, never in Postgres | A database dump can never leak the key, and there is no secret to manage. See open question 3. |
| Duplicate-suggestion table | Likely duplicates computed on read for the job in the reading pane | The hint is one quiet line. Nothing else reads it. |
| Add-by-link as a long task | A synchronous request with a 10 s timeout | It is one fetch. A task row would add polling for no gain. |
| Router code generation | Code-based TanStack Router routes in one file | There are seven routes. |
| Board drag and drop | A status menu and keyboard keys | No DnD library and no extra accessibility work. Status changes are rare. |
| Structured resume model | One text format for every output: a small Markdown subset with `[FACT-n]` markers | One editor, one citation parser, one gate, one template. |
| Output history | One row per output. Regenerating an edited output asks first | Regeneration only happens on click (decision 26). |
| `queued` task state | Tasks start immediately in-process | There is no queue in v1. pg-boss can add one later behind `startTask`. |
| A separate "failed check" state for drafts | Sentences that fail the anti-invention check become `[[...]]` placeholders | The existing gate (decision 25) then blocks export until the user fixes them. No new concept. |

---

## 1. Architecture

### Layers

```
web (React SPA)  ──HTTP──▶  http (Hono routes, Zod at the edge)
                                  │
                                  ▼
                            services (use cases, transactions, tasks)
                            │          │            │
                            ▼          ▼            ▼
                         db (Drizzle  adapters     domain (pure)
                         schema,      (I/O: HTTP,
                         clients)     AI, PDF, files)
                                  
shared (Zod schemas, enums, labels): imported by everything, imports only zod
```

| Layer | Folder | Contains | May import |
|---|---|---|---|
| shared | `src/shared` | Zod schemas for API requests and responses, enums, display labels | `zod` only |
| domain | `src/domain` | Pure functions: normalization, dedup keys, eligibility rules, match rules, pay and hours conversion, citation and anti-invention checks, gate, sync planning, fact diffing, prompt builders | `shared`, `domain` |
| adapters | `src/server/adapters` | Everything that touches the outside world: polite HTTP fetch, job source clients, AI providers, page reader, CV text extraction, PDF renderer, key file | `shared`, `domain`, npm libraries |
| db | `src/server/db` | Drizzle schema, the app connection, the sync-role session helper, migration runner | `shared`, `domain` (types only) |
| services | `src/server/services` | Use cases. Each opens its own transaction, calls domain functions, calls adapters through an injected `deps` object | `shared`, `domain`, `db`, `adapters` |
| http | `src/server/http` | Hono app and routes. Validates input, calls one service function, maps the result to a status code | `shared`, `services` |
| web | `src/web` | SPA: routes, components, shadcn UI | `shared`, plus `import type { AppType }` from `src/server/http/app.ts` |

Two extra rules:

- `src/server/services/sync.ts` may not import `src/server/db/client.ts`. It gets its database handle only from `asSync()` in `src/server/db/sync-session.ts`, which switches the transaction to the `hb_sync` role.
- `src/domain` may not import `node:*`, `bun`, `drizzle-orm`, `hono` or anything under `src/server`. It may not read `Date.now()`; callers pass `now`.

### How the rules are enforced

- **`test/architecture.test.ts`.** About 50 lines. It walks `src/**/*.{ts,tsx}` (skipping `*.test.ts`), runs `new Bun.Transpiler({ loader: "tsx" }).scanImports(source)`, resolves each relative path to its layer, and checks a rules table. `scanImports` drops type-only imports, so the SPA's `import type { AppType }` passes and any value import from the server fails. The test also fails if a domain file uses `Date.now`, `new Date()` with no argument, or `Math.random`.
- **Postgres grants** enforce the sync rule at runtime (section 2).
- **Biome** runs `noExplicitAny`, `noNonNullAssertion` and `useExhaustiveDependencies`. TypeScript runs with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

### Where validation lives

| Boundary | What validates | Result |
|---|---|---|
| HTTP request (body, query, params) | `zValidator` with schemas from `src/shared/api.ts` | Typed input. Bad input gets 400 with the Zod issues. |
| Environment | `src/server/env.ts` parses `process.env` with Zod at boot | The process refuses to start on bad config. |
| Job source payloads | Each adapter parses `unknown` JSON or RSS with its own Zod schema into `Posting` | Shape mismatch on the envelope throws `SourceError { kind: 'parse' }`. Bad items are skipped; more than half bad fails the run. |
| AI responses | Zod schema per purpose (`SplitResult`, `DraftResult`, `EligibilityResult`, `QuestionsResult`) | One retry on parse failure, then the task fails with the parse error. |
| Fetched pages | JSON-LD `JobPosting` parsed with Zod, otherwise readability text | Too little text becomes `needs_paste`. |
| Database | CHECK, FK, UNIQUE and partial unique indexes | Invariants that must survive any code bug (one running refresh, must-answer never drafted, closed implies outcome). |
| Domain | Nothing. It trusts its typed inputs | Outcomes are discriminated unions (`GateResult`, `SourceRunPlan`, `AddLinkResult`, `DraftCheck`). |

TypeScript rules from the `typescript-best-practices` skill that the plan relies on: branded ids (`JobId`, `OpportunityId`, `FactId`, `FactKey`) via Drizzle `.$type<>()`; `kind` discriminants for every variant type; `const _exhaustive: never` in every `switch` default; no `as` outside the adapter parse step; object arguments for every service function.

### How API types reach the SPA

- Request and response schemas live in `src/shared/api.ts`. Types are `z.infer` of those schemas. Services return these DTO types, already shaped for display: pay arrives converted and formatted, working hours arrive in Philippine time, labels arrive resolved. The SPA stays thin and never needs domain code.
- Routes are chained on one Hono app and exported as `export type AppType = typeof app`. The SPA builds its client with `hc<AppType>("/api")` in `src/web/api.ts` and wraps calls in TanStack Query hooks.
- Errors use one shape: `{ error: { code, message, details? } }`. Codes the SPA handles specially: `needs_input` (409, with `GateBlocker[]`), `over_cap` (402, with month total, cap and estimate), `refresh_running` (409, with the running task id), `frozen` (409, the opportunity is applied).

### Runtime shape

- Dev: `bun --watch src/server/main.ts` on port 3000, Vite on 5173 with `/api` proxied.
- Prod: one Bun process. Hono serves `/api/*` and the built SPA from `dist/` with `serveStatic` and an `index.html` fallback.
- `src/server/main.ts` is the composition root. It parses env, connects Postgres, runs migrations, ensures the single `users` row (and seeds built-in `sources` rows for it), marks `running` tasks as `interrupted`, and builds `deps = { db, ai, sources, pageReader, pdf, keyStore, clock }`. `HB_AI=fake` and `HB_SOURCES=fixture` swap in the fakes for tests and Playwright.
- Driver: `postgres` (postgres.js) with `drizzle-orm/postgres-js`.

### Folder tree

```
hanapbuhay/
  compose.yaml              # db (postgres:17) + app; volumes pgdata, appdata
  Dockerfile
  package.json  bunfig.toml  tsconfig.json  biome.json
  drizzle.config.ts  vite.config.ts  playwright.config.ts  index.html
  drizzle/                  # generated SQL migrations, plus custom 00xx_sync_role.sql
  src/
    shared/
      enums.ts              # statuses, outcomes, kinds, verdicts, seniority, currencies
      api.ts                # request/response Zod schemas and DTO types
      labels.ts             # statusLabel(type, status), verdict labels, dismiss reasons
    domain/
      text.ts               # normalize, tokens, htmlToText, contentHash
      dedup.ts              # applyUrlKey, companyKey, titleKey, isAutoMerge, likelyDuplicates
      features.ts           # skills dictionary + extractSkills, seniority, minYears
      eligibility.ts        # ordered rules -> { verdict, phrase }
      pay.ts                # parsePay, toMonthly, convert(fxRates)
      hours.ts              # parseHours, toManila
      match.ts              # matchJob(job, profile) -> { level, reasons }
      sync-plan.ts          # planSourceRun: closing rules, suspicious-empty guard
      split.ts              # rule-based splitting of text into candidate facts
      facts-diff.ts         # re-import diff
      citations.ts          # parse [FACT-n] and [[...]], strip for export, checkDraft
      must-answer.ts        # classifyQuestion -> salary | work_auth | notice | start_date | references | null
      gate.ts               # checkGate -> { ok } | { ok: false, blockers }
      prompts.ts            # prompt builders per purpose (pure strings)
      *.test.ts             # co-located unit tests
    server/
      env.ts
      main.ts
      db/
        schema.ts
        client.ts           # app-role connection
        sync-session.ts     # asSync(): transaction + SET LOCAL ROLE hb_sync
        migrate.ts
      adapters/
        http.ts             # polite fetch queue
        page-reader.ts      # add-by-link: fetch once, JSON-LD, readability
        extract.ts          # PDF (unpdf) and DOCX (mammoth) to text
        pdf.ts              # HTML template -> PDF
        key-store.ts        # read/write the AI key file
        ai/  types.ts  anthropic.ts  openai.ts  fake.ts  pricing.ts
        sources/  types.ts  index.ts  fixture.ts
                  jobicy.ts himalayas.ts remoteok.ts weworkremotely.ts remotive.ts
                  greenhouse.ts lever.ts ashby.ts smartrecruiters.ts recruitee.ts workable.ts
      services/
        tasks.ts            # startTask, getTask, markInterrupted
        ai.ts               # runAi: cap check, call, record ai_calls
        profile.ts          # users row, profile_items, facts, split, re-import
        jobs.ts             # add by link/paste, dismiss, save, merge
        matches.ts          # Matches query + scoring + reading pane detail
        sync.ts             # refresh pipeline (hb_sync only)
        workspace.ts        # outputs, questions, drafting, outdated, gate, ready, export
        board.ts            # status changes, history, freeze on apply, notes, contract fields
        sources.ts          # add/check company boards, toggle, keywords
        settings.ts         # AI provider, key, models, cap, currency, FX, spend
        setup.ts            # first-run checklist, derived from state
      http/
        app.ts              # Hono app, error mapper, AppType
        routes/  profile.ts jobs.ts matches.ts workspace.ts board.ts sources.ts settings.ts tasks.ts
    web/
      main.tsx  router.tsx  api.ts  styles.css
      routes/   matches.tsx workspace.tsx board.tsx profile.tsx sources.tsx settings.tsx
      components/  top-bar.tsx  setup-checklist.tsx  add-job-dialog.tsx  job-list.tsx
                   reading-pane.tsx  output-editor.tsx  needs-input.tsx  shortcut-sheet.tsx
      ui/       # shadcn components
  test/
    setup.ts                # preload: migrate test DB, resetDb() truncates
    architecture.test.ts
    sync-invariant.test.ts
    fixtures/               # source payloads, HTML pages, cv.pdf, cv.docx
    *.test.ts               # service integration tests against real Postgres
  eval/                     # eligibility and drafting evaluation sets (slice 10)
  e2e/                      # Playwright specs
```

### Polite fetching (carried over from job-hunter)

`adapters/http.ts` is the only `fetch` in the server. User agent `hanapbuhay/0.1 (personal use)`, per-host concurrency 2, 400 to 900 ms jitter between requests to the same host, 10 s timeout, `Retry-After` honored, at most 3 attempts with exponential backoff, 2 MB response cap. Each source declares `minIntervalMinutes` (30 by default, 360 for Remotive) and a per-run request budget (SmartRecruiters detail fetches are capped at 50 new postings per run).

---

## 2. Data model

Eleven tables. Every table except `users` has `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE` (decision 28), written once below and implied after. Primary keys are `uuid DEFAULT gen_random_uuid()` unless stated. All timestamps are `timestamptz`. Enums are `text` with CHECK constraints, mirrored by Zod enums in `src/shared/enums.ts`, so adding a value is a one-line migration.

### `users`: the person, their profile and their settings

```sql
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- contact: the resume and letter header, filled from here and never generated
  full_name          text NOT NULL DEFAULT '',
  email              text NOT NULL DEFAULT '',
  phone              text NOT NULL DEFAULT '',
  location           text NOT NULL DEFAULT 'Philippines',
  links              text[] NOT NULL DEFAULT '{}',
  -- targeting
  target_titles      text[] NOT NULL DEFAULT '{}',          -- default keywords (decision 13)
  role_families      text[] NOT NULL DEFAULT '{}',          -- see 3.7a; pre-filled from target titles and CV
  exclude_title_words text[] NOT NULL DEFAULT '{}',         -- e.g. {designer,sales,intern}; a hit is a sure drop
  seniority          text CHECK (seniority IN ('junior','mid','senior','lead','staff','principal')),
  years_experience   smallint CHECK (years_experience BETWEEN 0 AND 60),
  min_pay            jsonb,                                  -- {amount, currency, period} or null
  standard_answers   jsonb NOT NULL DEFAULT '{}',            -- {salary?, work_auth?, notice?, start_date?, references?}
  -- money display (decision 20)
  view_currency      char(3) NOT NULL DEFAULT 'PHP',
  fx_rates           jsonb NOT NULL DEFAULT '{}',            -- {"USD": 57.80} = view units per 1 unit
  -- AI (decisions 29 to 31)
  ai_provider        text CHECK (ai_provider IN ('anthropic','openai')),
  ai_key_hint        text,                                   -- last 4 characters; the key is not in Postgres
  model_light        text,
  model_writing      text,
  monthly_cap_usd    numeric(8,2) CHECK (monthly_cap_usd > 0),
  ai_eligibility_on_refresh boolean NOT NULL DEFAULT false
);
```

jsonb columns are typed with `.$type<T>()` where `T` is inferred from a shared Zod schema, and every write goes through that schema.

### `profile_items`: the CV and the add-ons

```sql
CREATE TABLE profile_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     ...,
  kind        text NOT NULL CHECK (kind IN ('cv','experience','open_source','challenge','other')),
  title       text NOT NULL,
  body        text NOT NULL,             -- CV text, or "what you did and the result"
  happened_on date,
  link        text,                      -- stored only, never fetched (decision 4)
  skills      text[] NOT NULL DEFAULT '{}',
  usage       text NOT NULL DEFAULT 'everywhere' CHECK (usage IN ('everywhere','letters_only')),
  rev         integer NOT NULL DEFAULT 1, -- bumped on every re-split
  file_name   text,                      -- CV only: the uploaded file's name, for display
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'cv' OR usage = 'everywhere'),
  CHECK (kind = 'cv' OR file_name IS NULL)
);
CREATE UNIQUE INDEX profile_items_one_cv ON profile_items (user_id) WHERE kind = 'cv';
```

### `facts`: the one confirmed fact list

```sql
CREATE TABLE facts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no          integer GENERATED ALWAYS AS IDENTITY UNIQUE,   -- key is 'FACT-' || no, never reused
  user_id     ...,
  item_id     uuid NOT NULL REFERENCES profile_items(id) ON DELETE CASCADE,
  text        text NOT NULL CHECK (length(btrim(text)) > 0),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  seen_rev    integer NOT NULL,          -- the item rev whose split last produced this fact
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facts_user_status ON facts (user_id, status);
CREATE INDEX facts_item ON facts (item_id);
```

A fact is "not in the latest version" of its item when `facts.seen_rev < profile_items.rev`. That is derived, so there is no flag to keep in sync. Usage comes from the item by join.

### `sources`: built-in boards and company boards

```sql
CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        ...,
  kind           text NOT NULL CHECK (kind IN ('jobicy','himalayas','remoteok','weworkremotely','remotive',
                   'greenhouse','lever','ashby','smartrecruiters','recruitee','workable')),
  board          text,                    -- company slug for ATS kinds, NULL for built-ins
  label          text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  keywords       text[],                  -- NULL means use users.target_titles
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- written only by sync (column grants below)
  last_run_at    timestamptz,
  last_ok_at     timestamptz,
  last_status    text CHECK (last_status IN ('ok','failed','rate_limited','suspicious_empty','skipped')),
  last_count     integer,
  last_ok_count  integer,
  last_dropped   integer,                 -- sure-drop count from the role filter (3.7a)
  last_error     text,
  CHECK ((kind IN ('greenhouse','lever','ashby','smartrecruiters','recruitee','workable')) = (board IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (user_id, kind, board)
);
```

### `jobs`: one posting, however many places it was seen

```sql
CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             ...,
  origin              text NOT NULL CHECK (origin IN ('source','link','paste')),
  title               text NOT NULL,
  company             text NOT NULL,
  title_key           text NOT NULL,     -- dedup: lowercased, punctuation and parentheticals dropped,
                                         -- sr->senior, tokens sorted
  company_key         text NOT NULL,     -- dedup: lowercased, Inc/LLC/Ltd/Corp/Co dropped
  apply_url           text,
  apply_url_key       text,              -- dedup: host lowercased, utm_* and ref params dropped, no trailing slash
  location_text       text NOT NULL DEFAULT '',
  description         text NOT NULL,     -- plain text; no HTML is stored
  content_hash        text NOT NULL,     -- sha256 of title, company, location, description, pay phrase
  description_key     text NOT NULL,     -- dedup: sha256 of the description lowercased, whitespace collapsed,
                                         -- URLs and dates removed (so tracking links and "posted 3 days ago" don't differ)
  posted_at           timestamptz,
  expires_at          timestamptz,
  pay_min             numeric(14,2),
  pay_max             numeric(14,2),
  pay_currency        char(3),
  pay_period          text CHECK (pay_period IN ('hour','day','week','month','year')),
  pay_phrase          text,              -- the posted wording, shown next to the conversion
  hours               jsonb,             -- {phrase, tz, start, end} | {phrase, tz, overlapHours}
  skills              text[] NOT NULL DEFAULT '{}',
  seniority           text CHECK (seniority IN ('intern','junior','mid','senior','lead','staff','principal','manager')),
  min_years           smallint,
  eligibility         text NOT NULL DEFAULT 'unclear'
                        CHECK (eligibility IN ('ph','worldwide','apac','americas','excluded','unclear')),
  eligibility_phrase  text,              -- the phrase that decided it (decision 7)
  eligibility_by      text NOT NULL DEFAULT 'rule' CHECK (eligibility_by IN ('rule','ai')),
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  search              tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', title), 'A') ||
                        setweight(to_tsvector('english', company), 'B') ||
                        setweight(to_tsvector('english', description), 'C')) STORED,
  CHECK (pay_min IS NULL OR pay_currency IS NOT NULL),
  CHECK (pay_min IS NULL OR pay_max IS NULL OR pay_max >= pay_min),
  CHECK (eligibility_phrase IS NOT NULL OR eligibility = 'unclear')
);
CREATE UNIQUE INDEX jobs_apply_url_key ON jobs (user_id, apply_url_key, title_key); -- dedup key 1, DB-enforced;
                                         -- title_key is included so a generic careers-page apply URL can't force two roles together
CREATE INDEX jobs_company_title ON jobs (user_id, company_key, title_key, description_key); -- dedup key 2 lookup
CREATE INDEX jobs_search ON jobs USING gin (search);                            -- FTS (decision 32)
CREATE INDEX jobs_open ON jobs (user_id, first_seen_at DESC) WHERE closed_at IS NULL;
CREATE INDEX jobs_closed ON jobs (closed_at) WHERE closed_at IS NOT NULL;        -- prune
```

`apply_url_key` NULLs are distinct, so pasted jobs with no link never collide.

### `job_listings`: where a job was seen

```sql
CREATE TABLE job_listings (
  source_id      uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id    text NOT NULL,
  user_id        ...,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  listing_url    text NOT NULL,         -- attribution link back (RemoteOK, WWR, Remotive)
  is_primary     boolean NOT NULL,      -- the listing whose content fills the job
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  missing_since  timestamptz,           -- set when a run says it is gone
  PRIMARY KEY (source_id, external_id)
);
CREATE UNIQUE INDEX job_listings_one_primary ON job_listings (job_id) WHERE is_primary;
CREATE INDEX job_listings_job ON job_listings (job_id);
```

A job closes when all of its listings are missing. Jobs added by link or paste have no primary listing, so sync never rewrites their content even if a source later lists the same job.

### `opportunities`: everything the user did to a job

```sql
CREATE TABLE opportunities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            ...,
  job_id             uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  type               text NOT NULL DEFAULT 'job' CHECK (type IN ('job','contract')),
  status             text CHECK (status IN ('saved','applied','interviewing','offer','closed')),  -- NULL = not on the board
  outcome            text CHECK (outcome IN ('accepted','rejected','no_response','withdrawn')),
  status_changed_at  timestamptz,
  history            jsonb NOT NULL DEFAULT '[]',   -- [{at, from, to, outcome?}], append-only
  dismissed_at       timestamptz,
  dismiss_reason     text CHECK (dismiss_reason IN ('wrong_stack','too_senior','pay','location','other')),
  notes              text NOT NULL DEFAULT '',
  ready_at           timestamptz,
  applied_snapshot   jsonb,                         -- {title, company, description, apply_url, at}
  rate_amount        numeric(12,2),
  rate_type          text CHECK (rate_type IN ('hourly','fixed')),
  rate_currency      char(3),
  platform           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'closed') = (outcome IS NOT NULL)),
  CHECK (status IS NOT NULL OR dismissed_at IS NOT NULL),     -- a row means the job was touched
  CHECK (status IS NULL OR dismissed_at IS NULL),             -- board jobs are not dismissed
  CHECK (dismiss_reason IS NULL OR dismissed_at IS NOT NULL),
  CHECK (type = 'contract' OR (rate_amount IS NULL AND rate_type IS NULL AND rate_currency IS NULL AND platform IS NULL))
);
CREATE INDEX opportunities_board ON opportunities (user_id, status) WHERE status IS NOT NULL;
```

### `outputs`: tailored files and question answers

```sql
CREATE TABLE outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         ...,
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('resume','letter','message','answer')),
  included        boolean NOT NULL DEFAULT true,  -- files: ticked. answers: false = AI-suggested, not yet added
  question        text,                           -- answers only
  must_answer     text CHECK (must_answer IN ('salary','work_auth','notice','start_date','references')),
  position        integer NOT NULL DEFAULT 0,
  body            text,                           -- NULL = not drafted; for must-answer, NULL = use profile answer
  ai_call_id      uuid REFERENCES ai_calls(id) ON DELETE SET NULL,
  generated_at    timestamptz,
  edited_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'answer') = (question IS NOT NULL)),
  CHECK (must_answer IS NULL OR kind = 'answer'),
  CHECK (must_answer IS NULL OR (ai_call_id IS NULL AND generated_at IS NULL))  -- never drafted (decision 24)
);
CREATE UNIQUE INDEX outputs_one_file ON outputs (opportunity_id, kind) WHERE kind <> 'answer';
CREATE INDEX outputs_opportunity ON outputs (opportunity_id, kind, position);
```

Saving a job to the board creates its three file rows (`resume`, `letter`, `message`) with `body = NULL` and `included = true`, so unticking a file is an update, not a new table.

### `output_facts`: provenance

```sql
CREATE TABLE output_facts (
  output_id  uuid NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  fact_key   text NOT NULL,                                      -- 'FACT-12', as cited in the body
  user_id    ...,
  fact_id    uuid REFERENCES facts(id) ON DELETE SET NULL,       -- NULL after the fact is deleted
  fact_text  text NOT NULL,                                      -- snapshot at drafting time
  PRIMARY KEY (output_id, fact_key)
);
CREATE INDEX output_facts_fact ON output_facts (fact_id);
```

### `ai_calls`: spending

```sql
CREATE TABLE ai_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        ...,
  task_id        uuid REFERENCES tasks(id) ON DELETE SET NULL,
  tier           text NOT NULL CHECK (tier IN ('light','writing')),
  purpose        text NOT NULL CHECK (purpose IN ('split','eligibility','questions','draft')),
  provider       text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL,
  output_tokens  integer NOT NULL,
  cost_usd       numeric(10,6),          -- NULL when the model is missing from pricing.ts
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_month ON ai_calls (user_id, created_at);
```

"This month" is computed in `Asia/Manila`: `created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'`.

### `tasks`: long work (decision 36)

```sql
CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      ...,
  kind         text NOT NULL CHECK (kind IN ('refresh','split','draft','suggest_questions')),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','interrupted')),
  step         text NOT NULL DEFAULT '',
  input        jsonb NOT NULL,           -- enough to retry
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE UNIQUE INDEX tasks_one_refresh ON tasks (user_id) WHERE kind = 'refresh' AND status = 'running';
CREATE INDEX tasks_recent ON tasks (user_id, created_at DESC);
```

The partial unique index is the "one running sync" rule. `startTask({ kind: 'refresh' })` inserts; a unique violation (`23505`) becomes `409 refresh_running` with the id of the task already running. On boot, `UPDATE tasks SET status = 'interrupted', finished_at = now() WHERE status = 'running'` frees the slot.

### What sync may write, and how that is enforced

| Table | Sync (`hb_sync`) | Everything else (app role) |
|---|---|---|
| `jobs` | SELECT, INSERT, UPDATE, DELETE | Creates link/paste jobs, edits pasted text, deletes merge losers |
| `job_listings` | SELECT, INSERT, UPDATE, DELETE | Moves listings during a user merge |
| `sources` | SELECT; UPDATE only `last_run_at, last_ok_at, last_status, last_count, last_ok_count, last_dropped, last_error` | All other columns |
| `ai_calls` | SELECT, INSERT (AI eligibility pass) | INSERT |
| `users` | SELECT only `id, target_titles, role_families, exclude_title_words, ai_provider, model_light, monthly_cap_usd, ai_eligibility_on_refresh` | All |
| `opportunities` | SELECT only `job_id` (prune's NOT EXISTS) | All |
| `profile_items`, `facts`, `outputs`, `output_facts`, `tasks` | nothing | All |

The custom migration `drizzle/00xx_sync_role.sql`:

```sql
DO $$ BEGIN CREATE ROLE hb_sync NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT hb_sync TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO hb_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs, job_listings TO hb_sync;
GRANT SELECT ON sources TO hb_sync;
GRANT UPDATE (last_run_at, last_ok_at, last_status, last_count, last_ok_count, last_dropped, last_error) ON sources TO hb_sync;
GRANT SELECT, INSERT ON ai_calls TO hb_sync;
GRANT SELECT (id, target_titles, role_families, exclude_title_words, ai_provider, model_light, monthly_cap_usd, ai_eligibility_on_refresh) ON users TO hb_sync;
GRANT SELECT (job_id) ON opportunities TO hb_sync;
```

Enforcement has four layers, strongest first:

1. **Postgres.** `asSync(db, fn)` runs `fn` inside `db.transaction(async tx => { await tx.execute(sql\`SET LOCAL ROLE hb_sync\`); ... })`. `SET LOCAL` ends with the transaction, so a pooled connection never leaks the role. Any write to a user table fails with SQLSTATE `42501`. The migration never uses `ALTER DEFAULT PRIVILEGES`, so a table added later is unwritable by sync until someone grants it on purpose.
2. **Foreign key.** `opportunities.job_id ... ON DELETE RESTRICT` makes it impossible to delete a touched job, even with a wrong `WHERE` clause in prune. Outputs hang off opportunities, not jobs, so files are protected by the same key.
3. **Import rule.** `services/sync.ts` cannot import `db/client.ts` (architecture test). Task progress goes through a `ctx.step(text)` callback that the task module owns.
4. **`test/sync-invariant.test.ts`.** It checks (a) `information_schema.table_privileges` and `column_privileges` for `hb_sync` equal the table above exactly, so a sloppy future grant fails the build; (b) as `hb_sync`, `UPDATE opportunities`, `UPDATE outputs`, `DELETE FROM facts`, `UPDATE users`, `UPDATE tasks` each fail with `42501`; (c) behaviour: it seeds saved, applied, dismissed and noted opportunities with outputs and citations, runs refresh through fixture sources in six scenarios (normal, postings gone from a complete board, adapter throws, zero results after a healthy run, description changed, clock moved 61 days), and asserts that an md5 of every row of every table outside `{jobs, job_listings, sources, ai_calls, tasks}` is identical before and after. The table list is read from `information_schema.tables`, so new tables are covered without editing the test.

One consequence worth stating: a job the user added by link is never pruned and never has its content rewritten, because it always has an opportunity row and never has a primary listing.

### Provenance and "outdated"

- When a draft is saved, `citations.ts` parses every `[FACT-n]` marker in the body. For each distinct key the service writes `output_facts (output_id, fact_key, fact_id, fact_text = current facts.text)`. User edits re-parse markers: new markers get a fresh snapshot, kept markers keep their old snapshot, removed markers lose their row.
- An output is **outdated** when any of its `output_facts` rows meets one of these, computed in the workspace query:
  - `fact_id IS NULL` (the fact was deleted),
  - `facts.text <> output_facts.fact_text` (edited),
  - `facts.status <> 'confirmed'`,
  - `output.kind = 'resume'` and the fact's item has `usage = 'letters_only'`.
- The UI lists each changed fact with its old and new text, and offers **Regenerate** and **Mark up to date**. The second refreshes the snapshots for that output only; it is for users who fixed the text by hand.
- Outputs of an opportunity with `status` in `('applied','interviewing','offer','closed')` are frozen. The query skips the outdated check, and the service refuses edits and regeneration with `409 frozen` (decision 26).
- **Deleting a cited fact** sets `output_facts.fact_id` to NULL through the FK. The snapshot stays, so the output says "FACT-12 was deleted" with the text it used to say. The `[FACT-12]` marker stays in the body, and export strips markers, so the claim would still print. The plan's default is that the gate lists a deleted-fact citation as a blocker. See open question 6.

---

## 3. Key flows

### 3.1 Refresh (sync pipeline)

`POST /api/refresh` → `startTask({ kind: 'refresh' })` (409 if one is running) → `runRefresh` in `services/sync.ts`. Per-source work happens in one `asSync` transaction per source, so an interrupted refresh leaves every source either fully applied or untouched.

1. **Load** enabled sources and `users.target_titles` inside `asSync`.
2. **Skip** any source whose `last_run_at` is within its `minIntervalMinutes`. Record `last_status = 'skipped'`. A skipped source closes nothing.
3. **Fetch.** `adapter.fetch({ board, keywords })` returns `{ complete: boolean, postings: Posting[] }` or throws `SourceError { kind: 'failed' | 'rate_limited' | 'parse' }`. ATS boards return the whole board and set `complete: true`. Keyword boards and feeds (Jobicy, Himalayas, RemoteOK, WWR, Remotive) return a window of recent results and set `complete: false`. Built-in boards filter postings to the keywords locally after fetching (title or tag match). Then every posting, from built-in and company boards alike, goes through `roleFit` (section 3.7a). `drop` postings are counted in `last_dropped` and never stored. `keep` and `unsure` postings continue. The `suspicious_empty` check uses the count before any filtering, so a strict filter can never look like a broken source.
4. **Normalize** each posting with domain code: `htmlToText`, the three dedup keys, `extractSkills`, `seniority`, `minYears`, `parsePay`, `parseHours`, `classifyEligibility`, `contentHash`.
5. **Plan** with `planSourceRun({ source, fetched, existing, now })`, a pure function that returns a discriminated union:
   - `{ kind: 'failed' | 'rate_limited', error }`: write only the `last_*` columns. Close nothing.
   - `{ kind: 'suspicious_empty' }` when `fetched.length === 0` and `source.last_ok_count > 0`: close nothing, upsert nothing.
   - `{ kind: 'ok', upserts, missing, reopened }` otherwise.
6. **Apply** (`kind: 'ok'`), one transaction:
   - Listing exists for `(source_id, external_id)`: set `last_seen_at = now`, `missing_since = NULL`. If it is the primary listing and `content_hash` changed, update the job's content and derived columns and re-run eligibility rules.
   - No listing, but a job is exactly the same posting: the same `apply_url_key` and `title_key`, or the same `company_key`, `title_key` and `description_key` with `posted_at` (or `first_seen_at`) within 28 days. Attach a non-primary listing. This is the auto-merge of decision 10, narrowed by the user: same company and title alone never merges, because a large company can have several "Software Engineer" openings with different requirements. Those pairs become "possible duplicate" suggestions (3.8). It never moves an opportunity, because it only adds a listing to a job that already exists.
   - Otherwise insert a job (`origin = 'source'`) and its primary listing.
   - Complete sources only: listings of this source not in the fetched set get `missing_since = now` if it was NULL.
   - Recompute `jobs.closed_at` for affected jobs: `max(missing_since)` when every listing is missing, else NULL. A returning job reopens.
   - Write `last_run_at`, `last_ok_at`, `last_status = 'ok'`, `last_count`, `last_ok_count`.
7. **Expire and go stale** (incomplete sources). A listing gets `missing_since` when the job's `expires_at` has passed, or when `source.last_ok_at > last_seen_at + 30 days`. Staleness is measured against the source's last successful run, not the wall clock, so a source that has been failing for a month closes nothing.
8. **AI eligibility pass** (optional, decision 31). `services/ai.ts` takes the database handle as an argument, so here it records `ai_calls` and reads the month total through the `hb_sync` transaction. If `ai_eligibility_on_refresh` is on and a key is set, jobs first seen in this refresh with `eligibility = 'unclear'` go to the light tier, at most 25 per refresh. The answer is accepted only if its `phrase` is a verbatim substring of the description; otherwise the job stays `unclear`. If the monthly cap would be crossed, the pass is skipped and the task result says so, because nobody is there to confirm.
9. **Prune** (decision 15): `DELETE FROM jobs j WHERE j.closed_at < now - interval '60 days' AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.job_id = j.id)`. Listings cascade. The FK is the backstop.
10. **Finish.** `tasks.result = { sources: [{ sourceId, status, fetched, added, updated, closed, error? }], pruned, aiPass }`.

Sources that need attribution (RemoteOK, WWR, Remotive) show "via RemoteOK" with `listing_url` in the reading pane. WWR jobs use the WWR listing as the apply link, as WWR's terms ask.

### 3.2 Add by link, with paste fallback

`POST /api/jobs/from-link { url }` runs synchronously and returns `AddLinkResult`:

```ts
type AddLinkResult =
  | { kind: 'created'; opportunityId: OpportunityId }
  | { kind: 'existing'; opportunityId: OpportunityId }
  | { kind: 'needs_paste'; url: string; prefill: { title?: string; company?: string }; reason: 'blocked_host' | 'too_little_text' | 'fetch_failed' };
```

1. Normalize the URL. If the host is on the no-automation list (LinkedIn, Indeed, JobStreet, Kalibrr, OnlineJobs.ph, Upwork, Glassdoor, Wellfound, Toptal), return `needs_paste` with `reason: 'blocked_host'` without fetching. See open question 5.
2. Dedup before fetching: if exactly one existing job has this `apply_url_key`, return `existing` (creating its opportunity if it has none). If several do (a generic careers URL), keep going and dedup after reading the title.
3. If the URL is a known ATS posting URL (Greenhouse, Lever, Ashby, and the rest), read that one posting through its public API using the same source adapter code.
4. Otherwise fetch the page once through `adapters/http.ts`. Prefer a JSON-LD `JobPosting` block (title, hiringOrganization, description, datePosted, validThrough, baseSalary, applicantLocationRequirements). Fall back to `@mozilla/readability` on `linkedom`.
5. Under 600 characters of description, or no title, returns `needs_paste` with whatever was found as `prefill`.
6. `POST /api/jobs/from-paste { url?, title, company, description }` is the fallback form. It runs the same normalization and exact-match dedup (company, title and description, or apply URL and title), then creates the job with `origin = 'paste'`.
7. Creating a job also creates its opportunity (`status = 'saved'`) and the three file rows, then the SPA navigates to the workspace.

Pasted and linked jobs can be edited later (title, company, description); the derived columns are recomputed on save.

### 3.3 CV to facts to confirm, with re-import

1. **Input.** Upload PDF or DOCX (`adapters/extract.ts`: `unpdf` for PDF, `mammoth` for DOCX) or paste text. The text goes into the single `profile_items` row with `kind = 'cv'`. The file is not kept. A PDF that yields under 200 characters returns "This PDF has no text layer. Paste the text instead."
2. **Split** (`startTask({ kind: 'split', input: { itemId } })`). With an AI key, the light tier returns `{ facts: [{ text }] }`, each fact one claim in the user's words. Without a key, `domain/split.ts` splits on bullets and sentences. Either way, every candidate goes through the same `checkDraft` token check used for drafting (section 3.4), with the item's text as the only allowed evidence. A candidate containing a number, year, proper noun, skill or URL that is not in the source text is dropped.
3. **Diff** with `diffFacts({ existing, candidates })` in `domain/facts-diff.ts`. Texts are compared after `normalize` (case, whitespace, punctuation).
   - Unchanged (an existing fact matches a candidate): keep the row, its id, key, status and citations. Set `seen_rev = rev`.
   - New candidate: insert with `status = 'pending'`, `seen_rev = rev`.
   - Existing **pending** fact with no match: delete. Nothing can cite a pending fact.
   - Existing **confirmed** fact with no match: keep it confirmed, leave `seen_rev` behind. The Profile screen shows it under "Not in your latest CV" with **Keep** (sets `seen_rev = rev`) and **Delete**.
   - The item's `rev` goes up by one before the diff.
4. **Confirm.** The Profile screen lists pending facts with Confirm, Edit and Discard, plus "Confirm all". Only `status = 'confirmed'` facts ever reach a prompt or count toward matching.
5. **Add-ons** use the same flow. The form fields are kind, title, body, date, link, skills and usage. Saving runs the split on the add-on's own row. The skills field is passed to the split as context; matching uses skills found in confirmed fact text, so the user can see exactly what counts ("Skills found in your confirmed facts" on the Profile screen).
6. **Editing a fact** updates its text and `updated_at`. Outputs that cite it become outdated. Editing an item's body and saving re-runs the split, which is the same thing as re-importing.

### 3.4 Drafting with citations

`POST /api/opportunities/:id/draft { kinds?: OutputKind[], outputId?: OutputId, confirmOverCap?: boolean }` → cap check → `startTask({ kind: 'draft' })`.

1. **Refuse** with `409 frozen` if the opportunity is applied or later, and `409 must_answer` if any target output has `must_answer` set. The DB CHECK on `outputs` backs this up.
2. **Build the prompt** (`domain/prompts.ts`). Inputs: the job's title, company and description; every confirmed fact as `FACT-n: text (link)`. For `resume`, facts whose item has `usage = 'letters_only'` are left out. For `message`, the prompt switches to a proposal when `opportunity.type = 'contract'`. Rules given to the model: every sentence about the candidate ends with the `[FACT-n]` markers that support it; when something is needed but not in the facts, write `[[what is missing]]`; never mention salary, visa, notice, start date or references; output a small Markdown subset (`#`, `##`, `-`, `**`). Voice rules (from `domain/style.ts`, so prompt and check share one list): write as the candidate in plain first person; short, concrete sentences; no em dashes; none of the banned phrases; no rule-of-three padding or stacked adjectives; no opening flattery of the company; match the posting's language and level of formality.
3. **Check** with `checkDraft({ body, facts, allowedKeys, posting, contact })`, which returns `{ ok: true } | { ok: false, violations }`:
   - `unknown_fact`: a marker cites a key that is not confirmed or not allowed for this kind.
   - `unsupported_token`: a sentence contains a number, a year, a month-and-year, a currency amount, a percentage, a URL, an email, a skill from the dictionary, or a capitalized proper noun that does not appear in the facts that sentence cites. Proper nouns may also come from the posting's company and title and the user's contact fields.
   - `uncited_claim`: a sentence with no markers contains any of those tokens.
4. **Retry once** with the violations listed in the prompt. If it still fails, each failing sentence is replaced with `[[Check this: "<sentence>" is not backed by your facts]]`. The draft is saved; the gate blocks export until the user rewrites those lines.
4a. **Style pass.** `checkStyle(body)` in `domain/style.ts` returns `StyleHit[]` (`{ sentence, phrase, rule }`). Rules: em or en dash used as punctuation; a banned phrase from one exported list ("I am excited", "thrilled", "passionate about", "leverage", "delve", "proven track record", "results-driven", "dynamic", "synergy", "spearheaded", "in today's fast-paced", "I believe I would be a great fit", "look no further", "tapestry", "testament to" and similar); three-item adjective lists; a sentence over 35 words. If there are hits, the app makes one AI call that rewrites only the flagged sentences, then runs `checkDraft` and `checkStyle` again on the result. A rewrite that fails `checkDraft` is discarded and the original sentence kept. Remaining hits are stored on the output (`outputs.style_hits jsonb`) and highlighted in the editor with the phrase named. They are warnings: the gate ignores them and export is allowed. User edits re-run `checkStyle` (no AI) so the warnings stay current.
5. **Save** body, `ai_call_id`, `generated_at`, and the `output_facts` rows. If the user had edited the output since it was generated, the SPA asks before starting.
6. User edits are not checked for invented claims; the user is the authority on their own life. Placeholders in user edits still count for the gate.

Question answers work the same way, one output at a time. **Suggest questions** (`startTask({ kind: 'suggest_questions' })`, light tier) finds questions in the posting text and inserts them as `kind = 'answer'`, `included = false`. Each question, typed or suggested, goes through `classifyQuestion`, which sets `must_answer` from patterns such as `salary|compensation|pay expectation|expected rate`, `visa|sponsorship|authori[sz]ed to work|right to work|work permit`, `notice period`, `start date|when can you start|earliest start`, `references|referees`.

### 3.5 The "Needs your input" gate

`checkGate(workspace)` in `domain/gate.ts` is the only definition of the gate. It returns `{ ok: true } | { ok: false; blockers: GateBlocker[] }`:

```ts
type GateBlocker =
  | { kind: 'must_answer'; outputId: OutputId; question: string; category: MustAnswer }
  | { kind: 'placeholder'; outputId: OutputId; text: string }
  | { kind: 'not_drafted'; outputId: OutputId; outputKind: OutputKind }
  | { kind: 'deleted_fact'; outputId: OutputId; factKey: FactKey };
```

- A must-answer output blocks when `body ?? users.standard_answers[category]` is empty after trimming.
- Only `included` outputs count. Suggested questions that were not added do not.
- `[[...]]` anywhere in an included body is a placeholder.

The server calls it in three places, and nowhere trusts the client:

- `POST /api/opportunities/:id/ready` sets `ready_at` or returns `409 needs_input` with the blockers.
- `GET /api/outputs/:id/export.pdf` returns the PDF or `409 needs_input`.
- `GET /api/outputs/:id/text` (Copy as text) returns marker-free text or `409 needs_input`. See open question 7.

The workspace shows "Ready" only when `ready_at` is set and the gate still passes on the current data, so adding a question after marking ready shows the job as not ready again without anyone clearing a flag. "Mark applied" is not gated; people apply through forms that need none of the files. Applying copies resolved standard answers into must-answer bodies and writes `applied_snapshot`, which is what "frozen" means in practice.

### 3.6 Eligibility rules

`classifyEligibility({ description, locationText, structured })` in `domain/eligibility.ts` runs an ordered rule list and stops at the first hit. Each rule returns a verdict and the matched phrase (the sentence, trimmed to about 160 characters), which the UI shows.

1. PH named in a negative: `(excluding|except|not (open to|available in)|cannot hire in) … Philippines` → `excluded`.
2. PH named positively: `Philippines`, `PH-based`, `Manila`, `Cebu`, `Filipino` → `ph`.
3. Country or region lock without PH: `(US|USA|United States|Canada|UK|EU|Europe|LATAM)[ -](only|based|residents)`, `must (be located|reside|live) in (the )?(US|…)`, `authori[sz]ed to work in the (US|UK|EU)`, `US citizens?`, `security clearance` → `excluded`.
4. APAC: `APAC|Asia[- ]Pacific|Southeast Asia|SEA|Asia|GMT\+8|UTC\+8` → `apac`.
5. Americas: `Americas|North America|US time ?zones|EST|PST|overlap with (US|Eastern|Pacific)` → `americas`.
6. Worldwide: `worldwide|anywhere in the world|work from anywhere|global(ly)? remote|all countries` → `worldwide`.
7. Structured fields: Ashby `workplaceType` plus an empty location restriction, Himalayas `locationRestrictions = []`, Jobicy `jobGeo = 'Anywhere'` → `worldwide`; a populated restriction list without PH → `excluded`.
8. Otherwise `unclear`, with no phrase.

Exclusion beats inclusion of a region, and every pattern is case-insensitive with word boundaries. The rule table lives in a typed array so `eligibility.test.ts` can run one fixture per rule, plus a fixture set from real postings under `eval/eligibility/`. Matches hides `excluded` by default.

### 3.7 Match rules

`matchJob({ job, profile })` in `domain/match.ts`, where `profile` holds the target titles, the skill set extracted from confirmed facts plus confirmed items' skills fields, seniority and years. It returns `{ level: 'strong' | 'possible' | 'weak'; reasons: Reason[] }`, where each reason has a sign and a short sentence.

- **Title fit**: best token Jaccard between the job's `title_key` and each target title's key, with seniority words removed from both. ≥ 0.6 is a fit, ≥ 0.3 partial, below that none.
- **Skills**: `matched = job.skills ∩ profile.skills`, `missing = job.skills − profile.skills`, `coverage = matched / max(1, job.skills.length)`. Reasons name up to five of each.
- **Seniority**: on the ladder intern < junior < mid < senior < lead < staff < principal, a gap of two or more steps is a negative. Manager roles are a negative unless the user's targets include a manager title.
- **Years**: `job.min_years > profile.years + 1` is a negative.
- **Eligibility**: `ph`, `worldwide`, `apac` are positives. `americas` and `unclear` cap the level at Possible. `excluded` forces Weak.

Levels:

- **Strong**: title fit or partial, coverage ≥ 0.6, no seniority or years negative, eligibility not capped.
- **Weak**: no title fit, or coverage < 0.3 with at least three job skills, or excluded.
- **Possible**: everything else.

Pay is not part of the level. The Matches pay filter converts `pay_min` (or `pay_max`) to monthly in the view currency and hides jobs below the filter. Jobs with no pay, or in a currency with no rate set, are never hidden (decision 20).

### 3.7a Role filter (three levels)

`roleFit({ title, tags, families, excludeWords })` in `domain/roles.ts` returns `{ fit: 'keep' | 'unsure' | 'drop'; family: RoleFamily | 'unknown'; reason: string }`. Families: `engineering`, `design`, `product`, `data`, `qa`, `devops`, `security`, `sales`, `marketing`, `support`, `ops`, `people`, `finance`. The classifier is a typed rule table: for each family, the head nouns and phrases that decide it ("engineer", "developer", "programmer", "SRE" → engineering; "designer", "UX researcher", "illustrator" → design; "account executive", "SDR" → sales). The head noun, the last role word in the title, wins over modifiers, so "Design Systems Engineer" is engineering and "Frontend Designer" is design.

- **drop** (sure): the title contains a word from `exclude_title_words`, or exactly one family matched, it is not in `role_families`, and no family the user picked appears anywhere in the title or tags.
- **unsure** (kept and tagged): no family matched ("Technical Wizard"); or the title mixes a picked family with an unpicked one ("UX Engineer", "Designer/Developer", "Developer Relations Manager"); or the title's family is unpicked but a tag or the first 300 characters of the description name a picked family's core words.
- **keep** (sure): the head noun's family is picked.

When in doubt, the rules pick `unsure` over `drop`. Only `drop` happens at sync. The `unsure` tag is computed on read like the match level, so changing your families updates tags at once. Jobs dropped earlier come back on the next Refresh, because boards return them again. Matches shows unsure jobs with a "Role unclear" chip and the reason ("title mixes design and engineering"). A filter chip shows or hides them, and they're shown by default. `unsure` also caps the match level at Possible. Pasted and linked jobs skip the filter, since you chose them yourself. Sources shows "kept 12 of 140" from `last_count` and `last_dropped`.

### 3.8 Duplicates the user merges

The reading pane asks `likelyDuplicates({ job, candidates })` for open jobs with the same `company_key` and title token Jaccard ≥ 0.5, or the same `title_key` and description shingle Jaccard ≥ 0.8, excluding pairs that already auto-merged. The hint shows a two-line diff of what differs (requirements, location or pay), so two same-titled roles at a big company are easy to tell apart before you merge. It shows one line: "Possibly the same job as Senior Engineer at Acme (Greenhouse) · Merge". **Merge** (`POST /api/jobs/:id/merge { into }`) keeps the job that has an opportunity, moves the loser's listings to it as non-primary, and deletes the loser. If both have opportunities, the button is disabled with the reason "Both are on your board. Close one instead." Merging returns `409 refresh_running` during a refresh.

---

## 4. UI

Built with shadcn/ui, Tailwind v4 and lucide icons, following the `design-engineering` craft floor. Specific calls for this app:

- One OKLCH palette with light and dark ramps, chosen by `prefers-color-scheme` only (decision 39). No toggle.
- A self-hosted UI sans and a self-hosted text serif for posting bodies, file previews and the PDF template. The reading measure is 68ch.
- `tabular-nums` for pay, dates, counts and costs. Selection, caret, scrollbars and focus rings are themed from the palette.
- No cards as page structure. Matches is a list and a pane; the Board is plain columns of rows; the workspace is a document with a side rail.
- No motion on keyboard navigation or selection changes. Popovers and dialogs use 150 to 200 ms ease-out from their trigger. Progress shows as text, not spinners where text fits.
- Errors name the problem and the way out ("Greenhouse said this board does not exist. Check the link, or try the company's careers page URL.").

| Screen | Purpose | Primary action | Empty | Loading | Error |
|---|---|---|---|---|---|
| **Matches** (`/`) | Triage new postings: list on the left, reading pane on the right with verdict phrase, PH-time hours, converted pay, match reasons, attribution, duplicate hint | Save to board (`s`) or open workspace (`Enter`) | Setup checklist when no jobs exist. "Nothing new. Refresh, or loosen the filters" with a Clear filters button when filters hide everything | Row skeletons at real row height; pane keeps the previous job until the new one loads | Inline banner with Retry; a failed source shows in the Refresh result, not here |
| **Workspace** (`/jobs/:id`) | Write the application: file tabs with include ticks, editor with citation chips, questions list, side rail with "Needs your input" and the apply checklist, outdated notices | Draft (or Regenerate) the included files | New job: three undrafted files with "Draft all", plus "Add a question" | Per-output "Drafting…" with the task step; editor stays readable | Task error with Retry; `needs_input` renders the blocker list; `over_cap` opens the confirm dialog; `frozen` explains that applied jobs keep what you sent |
| **Board** (`/board`) | Track jobs and contracts by status: Saved, Applied/Proposal sent, Interviewing, Offer, Closed | Change status from the row menu (keys 1 to 5 on a focused row) | "Nothing on the board yet. Save a match or add a job by link" with Add by link | Column skeletons | Inline banner with Retry; a failed status change reverts and toasts the reason |
| **Profile** (`/profile`) | Contact, target titles, seniority, years, minimum pay, standard answers, CV, add-ons, the fact review queue | Confirm pending facts | Setup checklist plus "Upload your CV or paste it" | "Reading your CV…" with the split task step | Extraction failure says which file and what to do; split failure has Retry |
| **Sources** (`/sources`) | Built-in boards on or off, company boards by careers link, per-source keywords, last run status | Add a company board | Built-ins are always listed; "No company boards yet" under them | Checking a board shows "Checking…" in the field | Check failure names the ATS response; each row shows its `last_status` and `last_error` |
| **Settings** (`/settings`) | AI provider, key (masked `…a1B2`), light and writing models, this month's spend, cap, AI eligibility on Refresh, view currency, FX rates | Save the AI key | Spend reads "$0.00 this month" (costs are in USD); FX lists currencies seen in jobs with no rate | Key test shows "Checking key…" | Bad key: "Anthropic rejected this key." Nothing is saved |
| **Add job** (dialog from Matches and Board, key `a`) | Add by link, or paste | Add | URL field focused | "Reading the page…" with a 10 s limit | Becomes the paste form with prefilled fields and the reason ("LinkedIn does not allow automated reading. Paste the description.") |
| **Refresh** (top bar) | Run all enabled sources | Refresh | n/a | Button shows "Refreshing · Lever 3 of 8" | Ends with a summary popover: new, updated, closed, and each failed or suspicious source |
| **Setup checklist** (on empty screens) | AI key, CV, confirm facts, preferences (including role families), sources, first refresh, in any order, derived from data by `GET /api/setup`. The "First refresh" step shows the five built-in sources as on/off toggles (all on by default), each with a one-line description and a link to add a company board, above the Refresh button. Before any refresh task exists, the top bar's Refresh opens this same panel instead of starting a sync. Both use the existing `sources.enabled` column and `tasks` rows, so no new state is added | Next undone step's link | Hidden when all steps are done | n/a | n/a |

### Keyboard model for Matches

The list is a `role="listbox"` with `aria-activedescendant`; selection follows focus and the pane updates instantly.

| Key | Action |
|---|---|
| `j` / `↓`, `k` / `↑` | Next or previous job |
| `Home` / `End` | First or last job |
| `Space` / `Shift+Space` | Scroll the reading pane |
| `Enter` or `o` | Open the workspace (saves to the board as Saved) |
| `s` | Save to the board and move to the next job |
| `d` | Dismiss: a reason popover opens at the row. `1` wrong stack, `2` too senior, `3` pay, `4` location, `5` other, `Enter` without a reason, `Esc` cancels. Then the next job is selected |
| `z` | Undo the last save or dismiss |
| `v` | Open the posting in a new tab |
| `/` | Focus search (Postgres FTS); `Esc` returns to the list |
| `e` | Show or hide excluded jobs |
| `a` | Add a job by link |
| `?` | Shortcut sheet |

Keys are ignored while focus is in a text field. Saved and dismissed jobs leave the list, so Matches works as an inbox.

---

## 5. Build order

Every slice leaves `bun run check` green. Package scripts used below:

```
check       = biome check . && tsc --noEmit && bun test
db:up       = docker compose up -d db
db:generate = drizzle-kit generate
db:migrate  = bun src/server/db/migrate.ts
build       = vite build
e2e         = playwright test        # starts the built app with HB_AI=fake HB_SOURCES=fixture
```

Tests use `DATABASE_URL_TEST` against the same Compose Postgres. `test/setup.ts` (bunfig preload) migrates once, and `resetDb()` truncates every table except `users`.

### Slice 1. Gated application kit (no AI, no sources)

Value: paste your CV and a job, write the files in the app, and export a PDF only once salary, visa and the rest are answered.

- **Files owned**: `package.json`, `bunfig.toml`, `tsconfig.json`, `biome.json`, `vite.config.ts`, `index.html`, `compose.yaml` (db service), `drizzle.config.ts`, `drizzle/`, `src/shared/{enums,api,labels}.ts`, `src/domain/{text,dedup,split,citations,must-answer,gate}.ts` and tests (`dedup.ts` holds only the three key functions here), `src/server/{env,main}.ts`, `src/server/db/{schema,client,migrate}.ts` (tables `users`, `profile_items`, `facts`, `jobs`, `opportunities`, `outputs`, `output_facts`; `outputs.ai_call_id` and its must-answer CHECK clause arrive in slice 2, the `generated_at` clause is here), `src/server/adapters/pdf.ts`, `src/server/services/{profile,jobs,workspace}.ts` (paste only), `src/server/http/app.ts`, `src/server/http/routes/{profile,jobs,workspace}.ts`, `src/web/{main,router,api}.tsx|ts`, `src/web/styles.css`, `src/web/routes/{profile,workspace,board}.tsx` (board: a plain Saved list), `src/web/components/{top-bar,add-job-dialog,output-editor,needs-input}.tsx`, `test/{setup,architecture.test,workspace.test}.ts`, `playwright.config.ts`, `e2e/kit.spec.ts`.
- **Depends on**: nothing.
- **Acceptance**:
  - Pasting CV text creates a `cv` item and pending facts by rule split; confirming moves them to `confirmed`; keys read `FACT-<n>`.
  - Pasting a job creates `jobs` (`origin = 'paste'`), an opportunity with `status = 'saved'`, and three file outputs.
  - Adding "What are your salary expectations?" stores `must_answer = 'salary'`. With no standard answer, export and ready return `409 needs_input` listing it. Filling the profile answer clears it without touching the job.
  - A `[[...]]` in any included body blocks export; unticking that file clears the block.
  - Export returns `application/pdf` with the contact header from `users` and markers stripped.
  - The architecture test fails if a domain file imports `drizzle-orm` (checked by a fixture case inside the test).
  - PDF spike: the chosen renderer runs under Bun in the Docker image (open question 1).
- **Verify**:
  ```
  bun run db:up && bun run db:migrate
  bun test src/domain/gate.test.ts src/domain/must-answer.test.ts src/domain/split.test.ts src/domain/citations.test.ts
  bun test test/architecture.test.ts test/workspace.test.ts
  bun run check
  bun run build && bun run e2e -- e2e/kit.spec.ts
  ```

### Slice 2. AI drafting with citations, spend and tasks

- **Files owned**: `src/server/adapters/ai/{types,anthropic,openai,fake,pricing}.ts`, `src/server/adapters/key-store.ts`, `src/server/services/{tasks,ai,settings}.ts`, drafting parts of `src/server/services/workspace.ts`, `src/domain/{citations,prompts,style}.ts` (adds `checkDraft` and `checkStyle`), `outputs.style_hits jsonb NOT NULL DEFAULT '[]'`, schema additions `tasks`, `ai_calls`, `outputs.ai_call_id`, `src/server/http/routes/{settings,tasks}.ts`, `src/web/routes/settings.tsx`, workspace draft and outdated UI, `test/{draft,tasks,settings}.test.ts`, `src/domain/prompts.test.ts`.
- **Depends on**: slice 1.
- **Acceptance**:
  - With `HB_AI=fake`, drafting a resume stores a body with markers and one `output_facts` row per cited key with a text snapshot.
  - A fake response with an invented "8 years" fails `checkDraft`, retries once, and saves the sentence as a `[[Check this: …]]` placeholder that the gate reports.
  - The resume prompt never contains a `letters_only` fact (asserted on the built prompt string).
  - The built prompt contains every phrase from `style.ts`'s banned list (one list feeds both prompt and check).
  - A fake draft containing "I am passionate about leveraging" and an em dash triggers one rewrite call; a fake rewrite that still contains "leverage" is saved with a `style_hits` entry, the editor highlights it, and export still succeeds. A rewrite that adds an unbacked number is discarded.
  - Drafting a must-answer output returns `409 must_answer`; a direct SQL insert with `ai_call_id` on a must-answer row fails the CHECK.
  - Editing a cited fact marks the output outdated and lists old and new text; deleting it shows "FACT-n was deleted" and adds a `deleted_fact` blocker; Mark up to date clears edits.
  - Each AI call writes an `ai_calls` row with tokens and cost; with a cap below the estimate, the endpoint returns `402 over_cap` until `confirmOverCap: true`.
  - The key file is written with mode 0600; no API response contains the key (test scans every settings response body).
  - Restarting the server marks `running` tasks `interrupted`, and Retry starts a new task from `input`.
- **Verify**:
  ```
  bun test src/domain/citations.test.ts src/domain/prompts.test.ts src/domain/style.test.ts
  bun test test/draft.test.ts test/tasks.test.ts test/settings.test.ts
  bun run check
  ```

### Slice 3. CV upload, AI split, add-ons, re-import

- **Files owned**: `src/server/adapters/extract.ts`, split and re-import parts of `src/server/services/profile.ts`, `src/domain/facts-diff.ts` and test, `src/web/routes/profile.tsx` (add-on form, review queue, "Not in your latest CV", skills found), `test/fixtures/{cv.pdf,cv.docx,cv-scanned.pdf}`, `test/profile.test.ts`.
- **Depends on**: slice 2.
- **Acceptance**:
  - PDF and DOCX fixtures extract to text; the scanned PDF returns the no-text-layer message.
  - A split candidate containing a number not in the CV text is dropped.
  - Re-import with one edited line: unchanged confirmed facts keep id and key; the new line is pending; the old pending line is gone; the old confirmed line shows under "Not in your latest CV".
  - An add-on with `usage = 'letters_only'` splits into facts that drafting excludes from resumes.
  - Without an AI key, split falls back to the rule splitter.
- **Verify**:
  ```
  bun test src/domain/facts-diff.test.ts
  bun test test/profile.test.ts
  bun run check
  ```

### Slice 4. Board

- **Files owned**: `src/server/services/board.ts`, `src/server/http/routes/board.ts`, `src/web/routes/board.tsx`, contract fields and caution in the workspace header, `test/board.test.ts`, `e2e/board.spec.ts`.
- **Depends on**: slice 2 (freeze relies on outdated and drafting).
- **Acceptance**:
  - Status changes append to `history` and set `status_changed_at`; Closed requires an outcome (DB CHECK and 400 from Zod).
  - Contracts show "Proposal sent" for applied, accept rate, rate type, currency and platform, and show the W-8BEN caution.
  - Marking applied writes `applied_snapshot` and copies resolved standard answers into must-answer bodies; afterwards edit and draft return `409 frozen` and no outdated notice shows.
  - An applied opportunity with `status_changed_at` 15 days ago shows the follow-up hint (clock injected).
  - Notes save on blur.
- **Verify**:
  ```
  bun test test/board.test.ts
  bun run check
  bun run build && bun run e2e -- e2e/board.spec.ts
  ```

### Slice 5. Add by link and job features

- **Files owned**: `src/server/adapters/{http,page-reader}.ts`, `src/domain/{dedup,features,eligibility,pay,hours}.ts` and tests, add-by-link parts of `src/server/services/jobs.ts`, the link mode of `add-job-dialog.tsx`, the verdict phrase, PH-time hours and converted pay in the workspace header, FX rates and view currency in Settings, `test/fixtures/pages/*.html`, `test/add-link.test.ts`.
- **Depends on**: slice 4, because both slices edit the workspace header. Everything else here could start right after slice 1.
- **Acceptance**:
  - A JSON-LD page creates a job with title, company, pay and expiry; a thin page returns `needs_paste` with prefill; a LinkedIn URL returns `needs_paste` with `blocked_host` and makes no request (fetch spy).
  - The same URL twice returns `existing`; the same company, title and description pasted within 28 days returns `existing`; two "Software Engineer" postings at one company with different descriptions create two jobs, and the reading pane shows them as possible duplicates with a diff.
  - Eligibility has one passing fixture per rule, including "Remote (US only)" → `excluded` and "We hire in the Philippines" → `ph`.
  - "9am to 5pm ET" converts to 10:00 PM to 6:00 AM PHT on a January date (EST) and 9:00 PM to 5:00 AM PHT on a July date (EDT).
  - "$60k–$80k/yr" with `USD = 57.80` shows the monthly PHP range; a EUR job with no rate shows as posted.
- **Verify**:
  ```
  bun test src/domain/eligibility.test.ts src/domain/pay.test.ts src/domain/hours.test.ts src/domain/dedup.test.ts src/domain/features.test.ts
  bun test test/add-link.test.ts
  bun run check
  ```

### Slice 6. Sync safety and the first source

The invariant test is written first, fails, and then the code makes it pass.

- **Files owned**: `test/sync-invariant.test.ts` (first), `drizzle/00xx_sync_role.sql`, schema additions `sources`, `job_listings`, `tasks_one_refresh` index, `src/server/db/sync-session.ts`, `src/domain/sync-plan.ts` and test, `src/domain/roles.ts` and test (one fixture per rule plus `eval/roles/titles.json` of real titles with expected levels), role families and exclude words on the profile page, `src/server/adapters/sources/{types,index,fixture,greenhouse,jobicy}.ts`, `src/server/services/{sync,sources}.ts` (company board add with check), `src/server/http/routes/{sources,tasks}.ts` (refresh), Refresh button in `top-bar.tsx`, a minimal `src/web/routes/matches.tsx` (plain list) and `src/web/routes/sources.tsx`, `test/fixtures/sources/{greenhouse,jobicy}/*.json`.
- **Depends on**: slices 4 and 5 (the invariant test seeds board data and needs job features).
- **Acceptance**:
  - `sync-invariant.test.ts` passes all three parts: exact grants, `42501` on every forbidden write, byte-identical user tables across the six scenarios.
  - A second `POST /api/refresh` while one runs returns `409 refresh_running` with the first task's id.
  - Greenhouse (complete): a posting missing from a successful run closes its job; it reopens when it returns; a thrown fetch closes nothing; zero postings after a healthy run sets `suspicious_empty` and closes nothing.
  - Role filter: a Greenhouse board fixture with "Senior Frontend Engineer", "Product Designer", "UX Engineer" and "Technical Wizard" (families = engineering) stores three jobs and drops one; Sources shows `last_count = 3`, `last_dropped = 1`. A fixture where every posting is dropped is `ok`, not `suspicious_empty`.
  - Jobicy (incomplete): a missing posting stays open; it closes 30 days after its last sighting only if the source had a successful run since.
  - A closed untouched job is deleted after 61 days; a closed saved job and a closed dismissed job remain.
  - A Greenhouse posting with the same apply URL as a pasted job attaches a non-primary listing and does not change the pasted job's text.
  - A Greenhouse board that does not exist is rejected before saving.
- **Verify**:
  ```
  bun test test/sync-invariant.test.ts
  bun test src/domain/sync-plan.test.ts src/domain/roles.test.ts test/sync.test.ts test/sources.test.ts
  bun run check
  ```

### Slice 7. Matches

- **Files owned**: `src/domain/match.ts` and test, `src/server/services/matches.ts`, `src/server/http/routes/matches.ts`, full `src/web/routes/matches.tsx`, `src/web/components/{job-list,reading-pane,shortcut-sheet}.tsx`, dismiss and save parts of `src/server/services/jobs.ts`, `test/matches.test.ts`, `e2e/matches.spec.ts`.
- **Depends on**: slice 6.
- **Acceptance**:
  - The match rule table test covers each level boundary and each cap (americas, unclear, excluded, role unsure).
  - Unsure jobs carry a "Role unclear" chip with the reason; unpicking a family changes tags on the next request without a refresh.
  - Confirming a fact with a new skill changes a job's level on the next request, with no stored state to update.
  - Search "react native" returns FTS hits ranked within match level; excluded jobs appear only with `e`.
  - The pay filter never hides jobs with no pay or no FX rate.
  - Playwright: `j`, `j`, `s`, `d`, `1`, `z` give the expected list and board state; no animation runs on selection (checked by `getAnimations().length === 0` on the pane).
- **Verify**:
  ```
  bun test src/domain/match.test.ts test/matches.test.ts
  bun run check
  bun run build && bun run e2e -- e2e/matches.spec.ts
  ```

### Slice 8. All sources

- **Files owned**: `src/server/adapters/sources/{himalayas,remoteok,weworkremotely,remotive,lever,ashby,smartrecruiters,recruitee,workable}.ts`, their fixtures, built-in seeding in `main.ts`, per-source keywords and attribution in `src/web/routes/sources.tsx` and the reading pane, `test/adapters.test.ts`.
- **Depends on**: slice 6.
- **Acceptance**:
  - Each adapter parses its fixture into `Posting[]` and throws `SourceError { kind: 'parse' }` on a changed envelope.
  - Remotive within 6 hours of its last run is `skipped` and makes no request.
  - SmartRecruiters stops detail fetches at the budget.
  - A job seen on Himalayas and Lever with the same apply URL is one job with two listings; it stays open while either listing is present (Lever complete, Himalayas incomplete).
  - RemoteOK, WWR and Remotive jobs show "via <source>" with a link.
- **Verify**:
  ```
  bun test test/adapters.test.ts test/sync.test.ts test/sync-invariant.test.ts
  bun run check
  ```

### Slice 9. Likely duplicates and merge

- **Files owned**: `likelyDuplicates` in `src/domain/dedup.ts`, merge in `src/server/services/jobs.ts` and `routes/jobs.ts`, the hint line in `reading-pane.tsx`, `test/merge.test.ts`.
- **Depends on**: slice 7.
- **Acceptance**:
  - "Sr. Frontend Engineer (Remote)" and "Frontend Engineer, Senior" at "Acme Inc" and "Acme" are suggested.
  - Merge keeps the job with the opportunity, moves listings, deletes the other; both-on-board disables merge; merge during a refresh returns 409.
- **Verify**:
  ```
  bun test src/domain/dedup.test.ts test/merge.test.ts
  bun run check
  ```

### Slice 10. AI extras and the evaluation set

- **Files owned**: question suggestions in `src/server/services/workspace.ts`, the AI eligibility pass in `src/server/services/sync.ts`, `eval/{eligibility,drafting}/*.json`, `eval/run.ts`, a `package.json` script `eval`, `test/ai-extras.test.ts`.
- **Depends on**: slices 2 and 8.
- **Acceptance**:
  - Suggested questions arrive with `included = false`; must-answer ones are classified and never drafted.
  - The AI eligibility pass accepts a verdict only with a verbatim phrase, stays within 25 jobs, skips itself when over the cap, and the sync-invariant test still passes with it enabled.
  - `bun run eval --tier light --model <id>` reports missed exclusions and invented claims per model, and exits non-zero on any. Settings defaults to the cheapest model that passed (recorded in `src/server/adapters/ai/pricing.ts`).
- **Verify**:
  ```
  bun test test/ai-extras.test.ts test/sync-invariant.test.ts
  bun run check
  ANTHROPIC_API_KEY=… bun run eval --tier light --model <id>   # manual, costs money
  ```

### Slice 11. First run and shipping

- **Files owned**: `src/server/services/setup.ts`, `src/web/components/setup-checklist.tsx`, `Dockerfile`, the `app` service in `compose.yaml`, `README.md`, `e2e/first-run.spec.ts`, a final craft-floor pass over `styles.css` and every route.
- **Depends on**: all slices above.
- **Acceptance**:
  - A fresh database shows the checklist on Matches, Board and Profile; each step ticks itself from data; it disappears when all are done.
  - Playwright: on a fresh database, clicking Refresh in the top bar opens the sources panel instead of syncing; turning off RemoteOK and clicking Refresh runs a sync that never calls the RemoteOK fixture; the second Refresh click syncs directly.
  - `docker compose up --build` on a clean machine serves the app on port 3000, survives a restart with data and the AI key intact, and passes `/api/health`.
  - The craft-floor checks pass in both themes: contrast, themed selection and scrollbars, focus rings, tabular numerals, empty, loading and error states on every screen.
- **Verify**:
  ```
  bun run check
  bun run build && bun run e2e
  docker compose up --build -d && curl -fsS localhost:3000/api/health && docker compose restart app && curl -fsS localhost:3000/api/health
  ```

### Later

From `DECISIONS.md`: fetching add-on links (GitHub) to pre-fill the form; reading a portfolio URL; filtering on working hours; using dismiss reasons in ranking; tracking active contracts (hours, invoices, payments, W-8BEN and BIR reminders); pgvector for facts or jobs; scheduled syncs, maybe with pg-boss behind `startTask`; accounts, login, hosting and RA 10173 consent work (the key file moves into Postgres, encrypted, at that point); a command palette; DOCX export; reading application forms on ATS sites.

Deferred by this plan: near-match detection on re-import ("this replaces FACT-12"); output version history; a "not a duplicate" memory; a `status_events` table if cross-job reports are wanted; board drag and drop; a manual eligibility override.

---

## 6. Risks and open questions

### Risks

| Risk | Mitigation |
|---|---|
| The sync role needs `CREATE ROLE` rights. Compose's Postgres user is a superuser, so this works there; a friend pointing at an external Postgres needs `CREATEROLE`. | Decision 35 puts everyone on Compose. `migrate.ts` fails with a clear message if the role cannot be created. |
| `SET LOCAL ROLE` only lasts inside a transaction. A sync query outside `asSync` would run as the app role. | The import rule forbids `db/client` in `sync.ts`, and part (c) of the invariant test would catch a write that slipped through. |
| The anti-invention check will flag some legitimate sentences (a capitalized product name the user typed in the posting's wording). | Failures become placeholders, not hard errors; the user edits them. The eval set tracks the false-positive rate. |
| Rule eligibility misses exclusions phrased in new ways. | The eval set grows from real misses; exclusion rules run before inclusion; the phrase is always shown so a wrong verdict is visible. |
| Truncated feeds make closure guesswork. | Incomplete sources close only by expiry or by 30 days of absence measured in successful runs. |
| Computing match on read gets slow if open jobs grow past about 20,000. | Measure in slice 7 with a generated 20k fixture. If it is slow, cache scores in memory keyed by a hash of the confirmed facts and preferences; still no table. |
| Chromium under Bun for PDF may be flaky, and adds image size. | Spike in slice 1; fallback renderer in open question 1. |
| Hono RPC type inference slows the editor as routes grow. | Keep routes chained per module; if `tsc` time passes 10 s, split `AppType` per route group. |

### Open questions for the user

All of these are now decided; the table at the top has the answers. The text below is kept for the trade-offs. Items 1 to 11 here are Q2 to Q12 in the table at the top. Q1 (no repository layer) is explained in "What this plan cuts".

1. **PDF renderer.** Default: render the same HTML and CSS template the workspace preview uses, with headless Chromium (`playwright-core` plus Debian's `chromium` in the image). The preview then matches the PDF exactly, and there is one template. Trade-off: about 300 MB more image and roughly 150 MB of memory per export. Alternative: `@react-pdf/renderer`, small and pure JS, but its layout is not HTML, so preview and PDF can drift. Plan C's alternative: a print route and the browser's own Save as PDF (`window.print()`). It needs no server renderer and no extra image size, but export becomes a print dialog rather than a download, the server can't check the gate at the moment of export, and output varies a little between browsers.
2. **FX-rate shape.** Default: one view currency (PHP) and a flat map `{ "USD": 57.80, "EUR": 62.10 }` of view-currency units per 1 unit, entered by hand. Settings lists currencies seen in jobs that have no rate. Changing the view currency clears the map, since the rates are relative to it. Pay periods convert to monthly at 173.33 hours, 21.67 days and 4.33 weeks. Trade-off: no triangulation and no history, so a rate change re-prices every job at once. That is what a manual rate means.
3. **Where the AI key lives.** Default: not in Postgres at all. The key is written to `/data/ai-key-<user_id>` (mode 0600) in the `appdata` volume; the database stores only `ai_key_hint`. There is no encryption secret to lose or to manage. Trade-off: losing the volume means pasting the key again (nothing else is lost), and a hosted multi-user version would need to move keys into Postgres with AES-GCM and an env secret. The alternative is that design now, with `APP_SECRET` required by Compose.
4. **CV re-import semantics.** Default (section 3.3): exact matches keep their fact and citations; new lines arrive pending; vanished pending facts are deleted; vanished confirmed facts stay confirmed and are listed under "Not in your latest CV" for Keep or Delete. Trade-off: a reworded line shows up as one new pending fact plus one "not in latest" fact instead of a single "replaces FACT-12" suggestion. That costs the user two clicks and keeps the diff exact.
5. **Add by link for sites that forbid automation.** Decision 6 says the app reads the page once; the research says LinkedIn, JobStreet, Indeed, Upwork and others ban automated access. Default: for those hosts, skip the fetch and open the paste form with the link kept as the apply URL. Trade-off: one paste for LinkedIn jobs, in return for never touching those sites. The alternative is a single fetch per user click for every host.
6. **Citing a deleted fact.** Default: the gate lists it as a blocker ("Resume cites FACT-12, which you deleted"), because the claim would still print without its backing. Trade-off: this adds a fourth item to the list in decision 25. The alternative is an outdated notice only, with export allowed.
7. **Is Copy as text an export?** Default: yes, gated like PDF, so placeholders never reach a LinkedIn message box. Trade-off: an unanswered salary question also blocks copying the short message. The alternative gates only PDF and shows placeholders highlighted when copying.
8. **Windows for duplicates and staleness.** Default: company and title auto-merge within 28 days of each other's posting dates; incomplete feeds close after 30 days without a sighting. Trade-off: a genuine repost within 28 days merges into the old job, which keeps its board status (usually what you want). Plan A's stricter alternative also requires the descriptions to be at least 60% similar. That way, two different roles with the same title at one large company, such as two "Software Engineer" postings, stay separate and show up as a possible duplicate instead.
9. **Company boards: keep every posting or filter by keywords?** Default: keep every posting from a company board the user added, and filter built-in boards by keywords. Match levels push unrelated roles down. Trade-off: a 400-job company board adds 400 rows, most of them Weak. The alternative applies the keyword filter to company boards too.
10. **Applied outputs read-only?** Default: yes. After Applied, files and answers are read-only, so the workspace shows what you sent. Trade-off: fixing a typo for a second submission means duplicating the text by hand. The alternative allows edits but still suppresses outdated notices and regeneration.
11. **Built-in sources on by default?** Default: all five on, so the first Refresh shows results. Trade-off: about five requests per Refresh before the user has chosen. The alternative is all off, with the checklist's "sources" step asking the user to pick.
