# Chrome extension: prefill job applications from Hanapbuhay

Status: plan, not started. Merged from GPT 5.6 Sol (base) and GLM 5.2 plans, corrected by Opus 5.5 and Opus 5 reviews against the repository.

## Summary

An unpacked Manifest V3 Chrome extension with a side panel. It pairs with the user's local Hanapbuhay server. When the user clicks **Apply** in a Hanapbuhay workspace, the server records a short-lived application session and opens the job's apply URL. The extension finds that session by asking the server, checks the tab URL matches, and binds it to the tab. On an explicit **Prefill** click it fills empty, high-confidence fields from profile data, saved preferences, and reviewed answers. It attaches a resume or letter only when the user picks the file and the target input. It never submits, never overwrites, never fills salary. When it detects a likely success page it asks the user before marking the opportunity applied.

## Confirmed product decisions

| Area | Decision |
|---|---|
| Users | One local Hanapbuhay per user; unpacked beta first |
| Entry | Workspace **Apply**, or explicit import of the visible current page |
| Handoff | Short-lived active session, discovered by the extension from the server (nothing added to the apply URL) |
| UI | Chrome side panel |
| Coverage | Generic matching on user-approved domains; tested adapters for Greenhouse, Lever, Ashby |
| Automation | Prefill on explicit click; never submit; never overwrite; uncertain fields left blank and listed |
| Files | User chooses output and target input, then clicks Attach |
| Precedence | Confirmed profile data → per-job saved answer → global saved answer → reviewed generated answer |
| Generation | Panel can start existing draft tasks; results need review before they can fill |
| Preferences | Typed category value + editable display text; global default + per-job override; saved only on explicit prompt |
| MVP groups | Application basics, eligibility/availability, voluntary identity. Salary never prefilled |
| Sensitive | One confirmation checklist per application |
| Applied | Detection only prompts; user confirmation marks applied |
| Connection | Configurable loopback URL, default `http://localhost:3000`; explicit pairing; fail closed |
| Storage | Endpoint, token, granted origins, UI settings in `chrome.storage.local`; session binding in `chrome.storage.session`; no answers, page text, or files |
| Permissions | Host access requested per domain |
| Diagnostics | Local, metadata only |

## Repository facts the plan depends on

- Fact statuses are `pending | confirmed` (`src/shared/enums.ts:24`). "Verified profile facts" means `users` contact columns, `users.standardAnswers` (except `salary`), and facts with `status = 'confirmed'`.
- Outputs have `included`, `generatedAt`, `editedAt` and no review state (`src/server/db/schema.ts` outputs table). `editedAt` is reset to null on redraft (`src/server/services/workspace.ts:696`). `opportunities.readyAt` is per opportunity and is not cleared by redrafting, so it cannot mark a specific answer as reviewed.
- `AppError` statuses are `400|402|404|409|422|429|500|503` (`src/server/services/context.ts:31`); there is no 401/403.
- Every router mounts at `"/"` under `/api` (`src/server/http/app.ts`). A `use('*')` inside one of them guards later routes too (reproduced by both reviewers).
- `JOB_ORIGINS` feeds an exhaustive switch in `src/server/services/jobs.ts:243-256`. Imports from the extension use origin `paste`; no new origin.
- URL dedup key is `applyUrlKey` in `src/domain/dedup.ts:31`. Lookup must reuse it.
- The only Apply link is in `src/web/routes/workspace.tsx:749-756`. The board has no apply URL.
- Root `bun test` preloads Postgres (`bunfig.toml`) and would pick up `extension/**` tests. Root `tsc` covers `src, test, e2e, eval, *.ts` only (`tsconfig.json:25`).
- `linkedom` is already a dependency; use it for DOM tests. There is no React/DOM test library; UI checks go in Playwright.
- `src/shared/hosts.ts` lists sites whose terms forbid automated tools (LinkedIn, Indeed, JobStreet, others). See "Open decision".

## Open decision

Prefilling on sites listed in `src/shared/hosts.ts` may break their terms (DECISIONS.md records JobStreet §9(b) banning "any automated process, script, tool"). Plan default: the extension refuses Prefill and Attach on those hosts and shows answers as copyable text instead. Change only if the user decides otherwise.

## Architecture

### Layers

- `src/shared/extension.ts`: Zod contracts shared by server, web, and extension. No server imports.
- `src/domain/prefill.ts`: pure matcher and precedence. Covered by the existing architecture test rules for `src/domain`.
- `src/server/services/extension-*.ts`: pairing, sessions, preferences, prefill payload, import, applied.
- `src/server/http/routes/extension-web.ts`: unguarded routes the SPA calls.
- `src/server/http/routes/extension/index.ts`: guarded routes the extension calls, mounted with `.route("/extension", …)` so the guard cannot leak.
- `extension/`: MV3 package (service worker, side panel, content script), its own `tsconfig.json`, built by `vite.extension.config.ts` into `dist-extension/`.

### Auth matrix

| Path | Caller | Auth | CSRF control |
|---|---|---|---|
| `POST /api/extension-web/pairings` (create code) | SPA | none (same as rest of app) | Requires `Content-Type: application/json` and `Origin` equal to the app origin |
| `GET /api/extension-web/pairings` | SPA | none | Same-origin read; returns no token material |
| `DELETE /api/extension-web/pairings/:id` | SPA | none | JSON + app `Origin` |
| `POST /api/extension-web/sessions` (Apply) | SPA | none | JSON + app `Origin` |
| `POST /api/extension/pair/claim` | Extension | one-time code | Code is 10-min, single-use, hashed; binds `chrome-extension://<id>` origin |
| every other `/api/extension/*` | Extension | `Authorization: Bearer` | Token hash compare (timing-safe); `Origin`, if present, must equal the paired extension origin |

Route-local CORS on `/api/extension/*` only: allow the paired extension origin, `Authorization` and `Content-Type`, no credentials. Existing `/api` routes stay unchanged. All extension responses send `Cache-Control: no-store`. Tokens, answers, page text, and file bytes never appear in logs or error bodies.

`AppError` gains `unauthorized` (401) and `forbidden_origin` (403); `src/web/api.ts` error handling covers them.

### Data model (migration `0008_extension`)

- `extension_pairings`: id, user_id, extension_origin, code_hash, code_expires_at, token_hash (null until claimed), claimed_at, revoked_at, last_used_at, created_at.
- `application_sessions`: id, user_id, opportunity_id (FK cascade), apply_url, apply_url_key, status `pending | claimed | completed | expired`, expires_at (15 min), claimed_by_pairing_id, claimed_at, completed_at, created_at. Creating a session expires all earlier `pending | claimed` sessions in the same transaction.
- `application_preferences`: id, user_id, opportunity_id (nullable), category, typed_value (jsonb), display_text, updated_at. Partial unique indexes for global `(user_id, category) WHERE opportunity_id IS NULL` and per-job `(user_id, opportunity_id, category)`. Category CHECK from `PREFILL_CATEGORY_KEYS`.
- `outputs.reviewed_at` (nullable). Set by an explicit "Mark reviewed" action (web workspace and panel). Cleared wherever a draft rewrites the body (`workspace.ts:696`) and on body edit through the panel. Edits in the web editor keep it.

New tables get no `hb_sync` grants (follows `drizzle/0004_sync_role.sql`).

### Precedence and eligibility (`src/domain/prefill.ts`)

For each field category:

1. Profile: `users` contact columns, `standardAnswers` (`work_auth`, `notice`, `start_date`, `references`), confirmed facts.
2. Per-job preference.
3. Global preference.
4. Per-job answer output: `kind = 'answer'`, `included`, `outdated` empty, `reviewed_at` not null, `reviewed_at >= generated_at`.

Hard rules:

- Salary is blocked at the source (`standardAnswers.salary`, `mustAnswer = 'salary'` outputs, any `compensation` category) and by label regex covering salary, compensation, pay, rate, wage, remuneration, CTC, "pay expectation". A test uses a salary output on a field labelled "Expected monthly rate".
- Generated answers that are not yet reviewed come back with `needsReview: true`, never preselected. They become fillable only after the user accepts each one in the panel.
- Sensitive categories (voluntary identity, sponsorship, work authorization) return `needsConfirmation: true`.
- Confidence: exact `autocomplete`, input type, or adapter mapping → high; normalized label alias → medium; anything else → unresolved. Only high, or medium accepted by the user, fill.
- `file` fields never get text values.

### Categories (`PREFILL_CATEGORIES`)

- Basics: given_name, family_name, full_name, email, phone, location, linkedin, github, portfolio, website, references, referral_source.
- Eligibility/availability: work_authorization, requires_sponsorship, notice_period, start_date, willing_to_relocate, work_arrangement, willing_to_travel.
- Voluntary identity (all sensitive): gender, race_ethnicity, veteran_status, disability_status. Each has an explicit "decline to answer" value.

Each category has `group`, `valueType` (`text | yesNo | date | choice`), `sensitive`, and `labelSynonyms`.

### Extension runtime

- Manifest: `permissions: ["sidePanel", "storage", "activeTab", "scripting", "downloads"]`; `optional_host_permissions` limited to loopback (`http://localhost/*`, `http://127.0.0.1/*`) plus `https://*/*` for per-domain requests. No `host_permissions`, no static `content_scripts`, no `externally_connectable`, no `web_accessible_resources`.
- Endpoint must be loopback HTTP or HTTPS. Pairing requests host permission for the endpoint origin first.
- Service worker: all server calls, permission requests, session discovery, file fetch. On 401, network error, or revoked token it clears session state and shows the pairing screen.
- Content script: registered per approved origin with `chrome.scripting.registerContentScripts`, isolated world, top frame only. Never reads `chrome.storage`. Never receives the token.
- Messages: `chrome.runtime` only, no `window.postMessage` listener. The worker checks `sender.id`, tab id, `frameId === 0`, approved origin, session-to-tab binding, schema, and a per-scan nonce. Messages carry field descriptors and fill plans keyed by ephemeral field ids, never selectors or code.
- Fill: rescan and compare field signature before writing; native value setter plus `input`/`change` events; skip non-empty, hidden, disabled, read-only controls; never click buttons.
- Files: user picks output and an empty file input. Worker fetches PDF with bearer, checks session and output ownership, `application/pdf`, size ≤ 10 MB, sanitized filename. Content script builds a `File` via `DataTransfer`, dispatches `change`, drops references. On rejection, offer a download.
- Session discovery: panel asks `GET /api/extension/sessions/active`. Claim only when `applyUrlKey(tab.url)` matches the session or the user confirms the mismatch. Binding stored in `chrome.storage.session`.
- Success detection: after a submit interaction, URL or visible text signals produce a reason code. Panel asks "Did you submit this application?". Only Yes calls `confirm-applied`.
- Diagnostics: ring buffer of 50 `{ts, adapter, counts, errorCode}` entries. Schema has no value or text fields.

### Build and test integration

- `bunfig.toml`: add `extension/**` to `pathIgnorePatterns`.
- `package.json`: `build:extension` (`vite build -c vite.extension.config.ts`), `test:extension` (`bun test --cwd extension`), and `check` gains `tsc -p extension/tsconfig.json --noEmit && bun run test:extension`.
- Dev deps: `@types/chrome`.
- Extension unit tests use linkedom fixtures. Web UI checks go in `e2e/`. Extension end-to-end runs in `playwright.extension.config.ts` with a persistent Chromium context; if that cannot run headless here, it is a documented manual step, not a gate.

## Not doing

- Chrome Web Store release, multi-user accounts, cloud sync.
- Auto-submit, CAPTCHA handling, background scraping, crawling links.
- Salary prefill, overwriting values, guessing sensitive answers.
- Cross-origin iframes, custom upload widgets, drag-and-drop emulation.
- Firefox, Safari, mobile.
- New AI prompts or changes to the drafting pipeline beyond clearing `reviewed_at`.

## Order

```
1 → 2 → 3 → 4 ─┐
1 → 5 ──────────┼→ 6 → 8
3,4 → 7         │
1,3 → 9 → 10 → 11
          10,6 → 12, 13
          7,12 → 14
          12,13,14 → 15 → 16
```

Parallel after Task 3: {4, 5, 9}. After 6 and 10: {11, 12, 13}.

## MVP acceptance

- Prefill fills only empty, high-confidence or user-accepted fields, after an explicit click.
- Salary and pre-filled fields are never changed.
- Voluntary identity and eligibility answers need the per-application checklist.
- Unreviewed generated answers never fill without per-field acceptance.
- Chosen resume or letter attaches to a user-chosen empty input on Greenhouse, Lever, Ashby fixtures.
- Unresolved fields are listed with reasons.
- Opportunity becomes Applied only after the user confirms.
- Without a valid pairing, or with the server down, nothing fills.
- Extension storage holds only endpoint, token, origins, UI settings, session binding, and metadata diagnostics.
- All root gates pass.

## Tasks

Each task leaves `bun run check` green. Shared files are owned by exactly one task; later tasks only replace files they own.

## Task 0: Local server hardening
- **Files owned:** `src/server/http/local-guard.ts`, `src/server/http/local-guard.test.ts` or `test/local-guard.test.ts`, `src/server/http/app.ts` (mount only), `src/server/main.ts` (hostname), `src/server/env.ts` (`HB_HOST`, `HB_ALLOWED_HOSTS`), `.env.example`
- **Depends on:** none
- **Steps:** bind `Bun.serve` to `HB_HOST` (default `127.0.0.1`, unless the repo runs the server inside a container, then keep that path working); reject requests whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (any port) or listed in `HB_ALLOWED_HOSTS` (blocks DNS rebinding); on non-GET/HEAD/OPTIONS `/api` requests reject a present `Origin` that is not `http(s)://<request Host>` and reject `Sec-Fetch-Site: cross-site`, except `/api/extension/*`, whose origin rules belong to Task 3. 403 with code `forbidden_origin`.
- **Verify:** LAN `Host`, rebinding host, foreign `Origin` POST, `Sec-Fetch-Site: cross-site` POST rejected; same-origin POST, no-Origin POST, GETs allowed; existing suite and e2e green. `bun run check && bun run e2e`

## Task 1: Contracts, error codes, auth matrix
- **Files owned:** `src/shared/extension.ts`, `src/shared/api.ts` (error codes only), `src/server/services/context.ts` (401/403), `src/web/api.ts` (error mapping), `test/extension-contracts.test.ts`
- **Depends on:** none
- **Steps:** branded ids; pairing, session, lookup, import, preference, prefill, attach, applied DTOs; `FieldDescriptor`, `FieldMatch`, `FillPlan`, runtime message union; `PREFILL_CATEGORIES`, `PREFILL_CATEGORY_KEYS`, `SALARY_LABEL_PATTERN`; `DiagnosticEntry`; endpoint schema (loopback or HTTPS); auth matrix as a typed constant used by tests. Caps on every string and array.
- **Verify:** `bun test test/extension-contracts.test.ts && bun run check`

## Task 2: Migration and schema
- **Files owned:** `src/server/db/schema.ts`, `drizzle/0008_*.sql`, `drizzle/meta/*`, `test/extension-db.test.ts`
- **Depends on:** Task 1
- **Steps:** three tables and `outputs.reviewed_at` as above; review generated SQL.
- **Verify:** `bun run db:generate` yields no further diff; `bun run db:migrate && bun test test/extension-db.test.ts && bun run check`

## Task 3: Router skeleton, guard, CORS, pairing
- **Files owned:** `src/server/http/app.ts`, `src/server/http/routes/extension/index.ts`, `src/server/http/routes/extension/pair.ts`, `src/server/http/routes/extension-web.ts`, `src/server/http/extension-guard.ts`, `src/server/services/extension-pairing.ts`, `test/extension-auth.test.ts`
- **Depends on:** Task 0, Task 1, Task 2
- **Steps:** mount `extension-web` and `.route("/extension", …)` once. Create stub files `routes/extension/{sessions,import,preferences,prefill,materials,applied}.ts` (each exporting an empty Hono router) and mount them in `index.ts`, so later tasks only replace their own stub and never edit `index.ts` or `app.ts`. Pairing create/list/revoke, claim, ping.
- **Verify:** auth matrix test hits every path with and without bearer, with app and foreign `Origin`; existing routes (`/api/profile`, `/api/board`) and unknown paths return non-401 without a token; expired, reused, revoked tokens → 401. `bun run check`

## Task 4: Sessions
- **Files owned:** `src/server/http/routes/extension/sessions.ts`, `src/server/http/routes/extension-web-sessions.ts`, `src/server/services/extension-sessions.ts`, `test/extension-sessions.test.ts`
- **Depends on:** Task 3
- **Steps:** web create (expires earlier sessions), `GET sessions/active`, `POST sessions/:id/claim` with `applyUrlKey` match, expiry.
- **Verify:** Apply A then B within a minute → B active, A expired; claim on mismatched URL → requires `confirmMismatch`; expired → error. `bun run check`

## Task 5: Prefill matcher
- **Files owned:** `src/domain/prefill.ts`, `src/domain/prefill.test.ts`
- **Depends on:** Task 1
- **Steps:** precedence, salary rules, confidence, option matching (yes/no/decline), sensitive flags.
- **Verify:** table tests with Greenhouse, Lever, Ashby labels; profile beats conflicting preference; per-job beats global; pending fact ignored; unreviewed answer → `needsReview`; "Expected monthly rate" salary case blocked. `bun run check`

## Task 6: Preferences, prefill payload, materials
- **Files owned:** `src/shared/api.ts` (add `reviewedAt` to `OutputDto`), `routes/extension/preferences.ts`, `routes/extension/prefill.ts`, `routes/extension/materials.ts`, `src/server/services/extension-preferences.ts`, `src/server/services/extension-prefill.ts`, `src/server/services/workspace.ts` (clear and set `reviewed_at`, add `markReviewed`), `src/server/http/routes/workspace.ts` (`POST /outputs/:id/reviewed`), `test/extension-prefill.test.ts`
- **Depends on:** Task 2, Task 3, Task 4, Task 5
- **Steps:** preference CRUD; `POST sessions/:id/prefill` with field descriptors (cap 200); output list without bodies; draft trigger and task poll wrapping existing services; authenticated PDF route with ownership checks.
- **Verify:** redraft clears `reviewed_at`; salary never in payload; outputs from another opportunity → 404; `test/draft.test.ts` still passes. `bun run check`

## Task 7: Import, lookup, applied
- **Files owned:** `routes/extension/import.ts`, `routes/extension/applied.ts`, `src/server/services/extension-import.ts`, `src/server/services/extension-applied.ts`, `test/extension-import.test.ts`, `test/extension-applied.test.ts`
- **Depends on:** Task 3, Task 4
- **Steps:** `GET opportunities/by-url` using `applyUrlKey`, read-only; `POST import` through `addPastedJob` (origin `paste`); `POST sessions/:id/confirm-applied` calling `changeStatus` from `board.ts`, then completing the session.
- **Verify:** lookup creates no rows; `javascript:` URL → 400; confirm-applied is idempotent and writes history and snapshot; `test/board.test.ts` passes. `bun run check`

## Task 8: Web: pairing settings, Apply, Mark reviewed
- **Files owned:** `src/web/routes/settings.tsx`, `src/web/routes/workspace.tsx`, `src/web/queries.ts`, `src/web/components/extension-pairing.tsx`, `e2e/extension-web.spec.ts`
- **Depends on:** Task 3, Task 4, Task 6
- **Steps:** Settings section to create a code, list pairings, revoke. Workspace Apply opens a blank tab synchronously, creates the session, then navigates to the unchanged `applyUrl`; on failure it still opens the URL and says the extension won't pick it up. "Mark reviewed" control on answers and files.
- **Verify:** e2e asserts opened URL equals stored `applyUrl` exactly, a session exists, board status is unchanged, revoke removes the row. `bun run check && bun run e2e -- extension-web`
- **Manual:** pairing code readable, countdown visible.

## Task 9: Extension scaffold and client
- **Files owned:** `extension/**` scaffold (`manifest.json`, `tsconfig.json`, `src/background/*`, `src/api/client.ts`, `src/state/*`, `src/messages.ts`, `src/panel/main.tsx`, `src/panel/App.tsx`, `src/panel/Pairing.tsx`), `vite.extension.config.ts`, `bunfig.toml`, `package.json`, `biome.json`, `extension/test/client.test.ts`, `extension/test/manifest.test.ts`
- **Depends on:** Task 1, Task 3
- **Steps:** build entries for worker, panel, content script (empty); pairing UI; endpoint validation and host-permission request; fail-closed states; panel screen switch with placeholder components (`Application.tsx`, `Attachments.tsx`, `ImportJob.tsx`, `AppliedPrompt.tsx`, `Diagnostics.tsx`) so later tasks only replace their own component; content script entry `extension/src/content/index.ts` as a stub exported for Task 10 to replace.
- **Verify:** manifest test (no `<all_urls>`, no static content scripts, required permissions present); client test (bearer header, 401 → unpaired, endpoint rejects LAN HTTP); `bun run build:extension && bun run check`
- **Manual:** load `dist-extension/`, pair, restart the worker, still paired; extension ID noted for re-pairing docs.

## Task 10: Generic scan and fill
- **Files owned:** `extension/src/content/scan.ts`, `extension/src/content/fill.ts`, `extension/src/content/index.ts`, `extension/src/background/permissions.ts`, `extension/src/background/content.ts`, `extension/test/scan.test.ts`, `extension/test/fill.test.ts`, `extension/test/fixtures/generic.html`
- **Depends on:** Task 9
- **Steps:** label resolution (`label[for]`, wrapping label, `aria-labelledby`, `aria-label`, fieldset legend); visibility and editability; per-origin approve and revoke; signature check before fill.
- **Verify:** fixture tests for existing values untouched, hidden/disabled skipped, stale field rejected, salary never filled. `bun run check`

## Task 11: ATS adapters
- **Files owned:** `extension/src/adapters/*`, `extension/src/content/scan.ts` (adapter hook only), `extension/src/content/index.ts` (adapter wiring), `extension/src/content/fill.ts` and `extension/test/fill.test.ts` (non-unique option values fix), `FieldControl` "combobox" in `src/shared/extension.ts` plus `src/domain/prefill.ts` (unsupported controls), `extension/test/adapters.test.ts`, `extension/test/fixtures/{greenhouse,lever,ashby}.html`
- **Depends on:** Task 10
- **Steps:** host and DOM detection; label and category hints only; fall back to generic.
- **Verify:** each fixture maps contact, work authorization, sponsorship, voluntary identity, resume, cover letter; custom questions and salary unresolved. `bun run check`

## Task 12: Panel review, prefill, sensitive checklist, save prompt
- **Files owned:** `extension/src/messages.ts`, `extension/src/background/index.ts`, `extension/src/background/panel.ts`, `extension/test/panel-handler.test.ts`, `extension/src/panel/App.tsx`, `extension/test/messages.test.ts`, `extension/src/panel/Application.tsx`, `FieldReview.tsx`, `SensitiveChecklist.tsx`, `SavePreference.tsx`, `DraftProgress.tsx`, `extension/src/panel/state.ts`, `extension/test/panel-state.test.ts`
- **Depends on:** Task 6, Task 10
- **Steps:** session discovery and claim; scan; server prefill; review with provenance and confidence; accept-per-field for medium and `needsReview`; one checklist per application; Prefill; result counts and unresolved list; explicit "Save as default / Save for this job"; draft and poll.
- **Verify:** state reducer tests: nothing fills before Prefill, sensitive blocked until checklist, unreviewed answer blocked until accepted, save never automatic. `bun run check`

## Task 13: File attachment
- **Files owned:** `extension/src/messages-attach.ts`, `extension/src/content/scan.ts` and `extension/test/scan.test.ts` (visually hidden file inputs), `extension/src/background/files.ts`, `extension/src/content/files.ts`, `extension/src/panel/Attachments.tsx`, `extension/test/files.test.ts`. Shared wiring (`messages.ts`, `background/panel.ts`, `background/index.ts`, `content/index.ts`, `panel/App.tsx`) is done in Task 14b.
- **Depends on:** Task 6, Task 10, Task 12
- **Steps:** as described in Architecture.
- **Verify:** wrong MIME, oversize, non-empty input, stale input all rejected; no blob in storage. `bun run check`
- **Manual:** attach on Greenhouse, Lever, Ashby; ATS shows the filename.

## Task 14: Import and success detection
- **Files owned:** `extension/src/messages-import.ts`, `extension/src/background/import.ts`, `extension/src/content/import.ts`, `extension/src/content/success.ts`, `extension/src/panel/ImportJob.tsx`, `extension/src/panel/AppliedPrompt.tsx`, `extension/test/import.test.ts`, `extension/test/success.test.ts`. Shared wiring is done in Task 14b.
- **Depends on:** Task 7, Task 12
- **Steps:** visible-only extraction after click with editable preview; lookup before import; success signals produce reason codes only.
- **Verify:** no extraction before click; cancel creates no job; validation-error page does not trigger prompt; signal alone never calls applied. `bun run check`

## Task 14b: Wire attach, import and success into shared files
- **Files owned:** `extension/src/messages.ts`, `extension/src/background/panel.ts`, `extension/src/background/index.ts`, `extension/src/content/index.ts`, `extension/src/panel/App.tsx`, `extension/src/panel/Application.tsx` (mount points only), `extension/test/messages.test.ts`, `extension/test/panel-handler.test.ts`
- **Depends on:** Task 11, Task 13, Task 14
- **Steps:** add the request kinds and handlers exported by `messages-attach.ts` and `messages-import.ts` to the unions and switches; route content messages; mount the panels.
- **Verify:** handler and sender tests for every new kind; exhaustive switches compile. `bun run check`

## Task 15: Diagnostics and architecture tests
- **Files owned:** `extension/src/state/diagnostics.ts`, `extension/src/panel/Diagnostics.tsx`, `extension/test/architecture.test.ts`
- **Depends on:** Task 12, Task 13, Task 14
- **Steps:** ring buffer; tests: no `chrome.storage` under `extension/src/content/`, no `storage.sync`, no `postMessage` listener, diagnostics schema has no value or text fields, extension code does not import `src/server`.
- **Verify:** `bun run check`

## Task 16: End-to-end, docs, decisions
- **Files owned:** `playwright.extension.config.ts`, `e2e-extension/extension.spec.ts`, `e2e-extension/fixtures/application.html`, `docs/EXTENSION.md`, `docs/DECISIONS.md`, `README.md`
- **Depends on:** Task 1 through Task 15
- **Steps:** persistent-context run: pair, Apply, claim, grant one origin, prefill, existing and salary untouched, attach, success prompt, confirm applied. Negative: foreign `postMessage`, subframe message, unapproved origin, revoked token, server down. Docs: install, pair, revoke, permissions, data kept, threat model (malicious pages, token leakage, localhost CSRF, host permissions, sensitive values, file injection), limits. Append decisions.
- **Verify:** `bun run db:migrate && bun run check && bun run build && bun run build:extension && bun run e2e && bunx playwright test -c playwright.extension.config.ts`
- **Manual:** full flow on live Greenhouse, Lever, Ashby postings without submitting; stop the server mid-flow and confirm the panel fails closed; inspect extension storage.

