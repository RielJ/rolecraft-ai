# Hanapbuhay

Hanapbuhay is a job search tool for one person in the Philippines who applies to remote jobs and contracts. It does three things:

- It reads public job boards and company boards, and tells you whether each job can hire from the Philippines.
- It keeps the jobs you care about on a board, from Saved to Closed.
- It drafts a tailored resume, cover letter, short message, and answers for each job. Every claim in a draft comes from facts you confirmed.

It never submits an application. You copy or export the files and apply yourself, or let the optional Chrome extension fill the empty fields of the form after you check them.

Each person runs their own copy, with their own database and their own AI key. There is no login.

## Run it with Docker

You need Docker with Compose.

1. Start Postgres and the app:

   ```sh
   docker compose up -d --build
   ```

2. Open <http://localhost:3000>. The **Get set up** checklist lists the six first-run steps.

To use another port, set `HB_PORT`. For example, `HB_PORT=3300 docker compose up -d` serves the app on <http://localhost:3300>.

The app migrates the database each time it starts. It runs as a non-root user and keeps its data in two volumes:

| Volume | Holds |
|---|---|
| `pgdata` | The Postgres data. |
| `appdata` | The AI key file, mounted at `/data`. |

`docker compose down` keeps both volumes. `docker compose down -v` deletes them, together with your profile, your board, and your key.

The `app` service waits for a healthy `db`. Its own healthcheck calls `GET /api/health`, which answers 200 only when Postgres answers. The image includes Debian's Chromium for PDF export.

## Run it for development

You need [Bun](https://bun.sh) 1.4.3 or later and Docker for Postgres.

1. Install dependencies and copy the example environment:

   ```sh
   bun install
   cp .env.example .env
   ```

2. Start Postgres:

   ```sh
   bun run db:up
   ```

3. Start the API on port 3000. It runs the migrations first.

   ```sh
   bun run dev
   ```

4. In a second terminal, start Vite on port 5173. It sends `/api` requests to the API.

   ```sh
   bun run dev:web
   ```

5. Open <http://localhost:5173>.

PDF export needs Chromium. If `HB_CHROMIUM_PATH` is empty, the app uses Playwright's download, which `bunx playwright install chromium` fetches.

To serve the built app from one process, run `bun run build`, then `bun run start`.

## Use the Chrome extension

The extension adds a side panel that fills empty fields on a job's application form from your profile and reviewed answers, after you click **Prefill**. It never submits, never overwrites a field, and never fills a pay question.

1. Run `bun run build:extension`.
2. In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `dist-extension/`.
3. Pair it with a code from **Settings** > **Chrome extension**.

[docs/EXTENSION.md](docs/EXTENSION.md) covers pairing, revoking, permissions, stored data, the threat model, the limits, and the manual checks.

## Environment variables

`src/server/env.ts` parses these at startup. If one is invalid, the process stops and prints the problem. `.env.example` lists the common ones.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay` | The app database. |
| `PORT` | `3000` | The API port. In production the same port serves the SPA. |
| `HB_HOST` | `127.0.0.1` | The interface the server listens on. The app has no login, so keep it on loopback. The Docker image sets `0.0.0.0`, and Compose publishes the port on `127.0.0.1` only. |
| `HB_ALLOWED_HOSTS` | unset | Extra hostnames, comma-separated and without a port, that the server answers to. It always answers to `localhost`, `127.0.0.1`, and `[::1]`. A request with any other `Host` header gets 403, which blocks DNS rebinding. |
| `HB_AI` | `live` | Where AI calls go. See the next table. |
| `HB_DATA_DIR` | `./data` | Where the AI key file is written, with mode 0600. |
| `HB_CHROMIUM_PATH` | unset | The Chromium binary for PDF export. Unset uses Playwright's Chromium. |
| `HB_STATIC_DIR` | `./dist` | The built SPA. |
| `HB_SOURCES` | `live` | `fixture` reads job sources from files in `HB_SOURCES_DIR` instead of the network. Tests use it. |
| `HB_SOURCES_DIR` | `./test/fixtures/sources` | The fixture files for `HB_SOURCES=fixture`. |
| `HB_SOURCES_LOG` | unset | With `HB_SOURCES=fixture`, a file that gets one line for each fixture request. The end-to-end tests read it. |
| `HB_FX` | `live` | Where exchange rates come from (decision 67). `fixture` reads recorded ECB and currency-api bodies from `HB_FX_DIR` instead of the network. |
| `HB_FX_DIR` | `./test/fixtures/fx` | The fixture files for `HB_FX=fixture`. A missing file fails like an unreachable site. |
| `HB_PI_BIN` | `pi` | The pi binary for `HB_AI=pi`. |
| `HB_PI_MODEL_LIGHT` | `claude-haiku-5-5` | The light-tier model for `HB_AI=pi`. |
| `HB_PI_MODEL_WRITING` | `claude-opus-5-5` | The writing-tier model for `HB_AI=pi`. |
| `HB_PI_THINKING_LIGHT` | `off` | The thinking level for light-tier pi calls. |
| `HB_PI_THINKING_WRITING` | `low` | The thinking level for writing-tier pi calls. |

The test suites read `DATABASE_URL_TEST` (default database `hanapbuhay_test`) and `DATABASE_URL_E2E` (default database `hanapbuhay_e2e`). Each suite creates its database if it does not exist.

Compose reads `HB_PORT` (the host port for the app), `HB_DB_PORT` (the host port for Postgres, default 5432), and `HB_DB_PASSWORD` (default `hanapbuhay`).

### Pick an AI mode with `HB_AI`

| Value | AI calls go to | Use it for |
|---|---|---|
| `live` | Anthropic or OpenAI, with the API key you save in **Settings**. | Docker, and any copy you run for real. |
| `pi` | The `pi` CLI on your machine, signed in to Anthropic. The app stores no key and never reads pi's credentials. | Local development only. It needs pi and its sign-in on the host, so the Docker image always uses `live`. |
| `fake` | A scripted provider with fixed replies. | Tests and Playwright. |

With `HB_AI=pi`, **Settings** shows "AI runs through pi on this machine" instead of the key form. At startup the server checks that pi is signed in, and logs a warning if it is not.

## How drafts stay true

A draft that claims something you never did can cost you the job. The app is built so that each claim in a draft traces back to a sentence you confirmed, and so that you cannot export a file that still has a gap in it.

**Facts.** Your CV and your add-ons become short facts, one claim each. A new fact starts as pending. Only facts you confirm reach a prompt or count toward a match. The split, with or without AI, runs each candidate fact through `checkDraft` with the CV text as the only evidence. It drops a candidate that has a number, a year, a proper noun, a skill, or a URL that the CV does not have.

**Citations.** The drafting prompt lists every confirmed fact as `FACT-n: text`. The model must end each sentence about you with the `[FACT-n]` markers that support it. Where it needs something the facts do not have, it writes `[[what is missing]]`. When a draft is saved, the app records the text of each cited fact. If you later edit or delete that fact, the file shows as outdated and names the change.

**`checkDraft`.** `src/domain/citations.ts` checks every generated draft before it is saved. It rejects a marker for a fact that is not confirmed. It also rejects a sentence with a number, a date, an amount, a percentage, a URL, an email, a known skill, or a proper noun that the cited facts do not contain. Proper nouns from the posting's title and company and from your contact details are allowed. A failing draft gets one retry with the problems listed. Each sentence that still fails becomes a `[[Check this: ...]]` placeholder for you to rewrite.

**The gate.** `checkGate` in `src/domain/gate.ts` decides whether a job is ready. It blocks while an included file has a `[[...]]` placeholder, is not drafted yet, or cites a deleted fact. It also blocks while a must-answer question has no answer. Must-answer questions cover salary, work authorization, notice period, start date, and references. The AI never drafts them. The server runs the gate for **Mark ready**, PDF export, and **Copy as text**, and never trusts the browser's copy of it.

Your own edits are not checked for invented claims. You are the authority on your own life. Placeholders in your edits still count for the gate.

### The evaluation set

`eval/` holds eligibility and drafting cases. `eval/run.ts` runs them through the app's own rules, prompts, and `checkDraft`. It reports two numbers: missed exclusions (a job that cannot hire from the Philippines that ends up as anything else) and invented claims (a draft that still fails `checkDraft` after the retry). It exits with code 1 if either is above zero.

```sh
bun run eval --via pi --tier light --model claude-haiku-5-5
```

The recorded run of that command reported 0 missed exclusions and 0 invented claims. That result is why `claude-haiku-5-5` is the default light-tier Anthropic model. `EVAL_PASSED_LIGHT` in `src/server/adapters/ai/pricing.ts` records the date. To run the eval with a key instead of pi, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and pass `--via key`.

## Architecture

The server and the SPA share one TypeScript codebase, split into layers. `test/architecture.test.ts` scans every import and fails the build when a layer imports something it may not.

| Layer | Folder | Holds | May import |
|---|---|---|---|
| shared | `src/shared` | Zod schemas for the API, enums, and display labels | `zod` only |
| domain | `src/domain` | Pure functions: eligibility, matching, dedup, pay, citations, the gate, prompts | `shared` |
| adapters | `src/server/adapters` | Everything that talks to the outside: job sources, AI providers, page reading, PDF, the key file | `shared`, `domain` |
| db | `src/server/db` | The Drizzle schema, connections, and migrations | `shared`, `domain` types |
| services | `src/server/services` | Use cases. Each opens its own transaction. | `shared`, `domain`, `db`, `adapters` |
| http | `src/server/http` | Hono routes. Each validates input and calls one service. | `shared`, `services` |
| web | `src/web` | The React SPA | `shared`, and the API type from `src/server/http/app.ts` |

Domain code may not read the clock or use randomness. Callers pass `now`.

### Refresh never touches your work

**Refresh** reads every enabled source and updates the job list. It must never change what you did: your board, notes, files, facts, or profile. Postgres enforces this, not code review:

- `src/server/services/sync.ts` gets its database handle only from `asSync()` in `src/server/db/sync-session.ts`. That function runs each transaction as the `hb_sync` role, and the architecture test stops `sync.ts` from importing the normal connection.
- `hb_sync` may write `jobs` and `job_listings`, insert into `ai_calls`, and update the last-run columns of `sources`. On every other table it can read only the few columns it needs, or nothing. Any other write fails with a permission error.
- A job that has an opportunity cannot be deleted, because of a foreign key. So a wrong prune query still cannot remove a job on your board.
- `test/sync-invariant.test.ts` checks that the role's grants match that list exactly. It runs Refresh in six scenarios and compares a hash of every row in every other table, before and after.

## Tests

| Command | What it runs |
|---|---|
| `bun run check` | Biome, `tsc --noEmit`, and `bun test`. The unit tests and the service tests run against a real Postgres database, `hanapbuhay_test`. |
| `bun run e2e` | Playwright specs in `e2e/`. Run `bun run build` first. The suite starts the server on port 3100 with `HB_AI=fake`, `HB_SOURCES=fixture` and `HB_FX=fixture`, against `hanapbuhay_e2e`. |
| `bun run e2e:extension` | The Chrome extension end to end, in `e2e-extension/`. It builds `dist-extension/` and starts the server on port 3110 against `hanapbuhay_e2e`. Run `bun run build` first. See [docs/EXTENSION.md](docs/EXTENSION.md). |
| `bun run eval ...` | The evaluation set. It makes real AI calls, so it costs money. |

Start Postgres with `bun run db:up` before `bun run check` or `bun run e2e`.

`e2e/craft.spec.ts` runs axe on every screen in the light and dark themes. It also checks focus rings, the themed selection and scrollbar, and the empty, loading, and error states. It saves screenshots to `test-results/craft/`.
