# Plan: automatic exchange rates (slice 16, decision 67, migration 0012)

This is Plan A (Opus 5.5) from multi-plan run `20261018-112052-plan`, approved as written by the user on 2026-10-18. It was compared against Plans B, C and D. The only change is numbering: rates is built after skills (decision 66, migration 0011) and before CV preview, so it takes **decision 67 and migration 0012**. If the skills slice has not landed, generate the migration anyway and renumber it at merge.

The live API was checked on 2026-10-18. `base=PHP` returns USD `0.01588`, which has only 4 significant digits and gives 62.972. The EUR base returns `PHP 70.858` and `USD 1.1253`, which give the exact cross rate **62.9681**. So the ECB path queries the EUR base and crosses the rates.

## Summary

- **Adapter** (`src/server/adapters/fx.ts`):
  - Reads ECB reference rates from Frankfurter.
  - Falls back to fawazahmed0 currency-api (jsDelivr first, then the pages.dev mirror) for currencies the ECB does not publish.
  - Sends every request through the existing polite `HttpClient`.
- **Pure math** lives in `src/domain/fx.ts`.
- **Service** (`src/server/services/rates.ts`):
  - Decides which currencies need a rate.
  - Fetches with no transaction open.
  - Merges the results into `users.fx_rates` under a row lock.
  - Never overwrites a rate the user typed.
- **When fills run:**
  - The **Fill rates** button calls `POST /api/settings/rates/fill`.
  - Each Refresh fills after the sources loop, as the app role in `startRefresh`, never under `asSync`. A gate opens when a needed currency has no rate, or 20 h after the last good fetch. After a failed fetch it waits 1 h.
- **Data changes:**
  - `FxRateEntry` gains `by: 'user' | 'ecb' | 'currency-api'` and `rateDate`. Existing entries are backfilled as `by: 'user'`.
  - A new nullable column, `users.fx_fetch`, records the last attempt: when it ran, its error, and the currencies no source publishes.
- **UI:**
  - The Fill rates button, with a pending state.
  - A provenance label on each row.
  - One age line per source, for example "ECB rates of 16 Oct · fetched 2 hours ago".
  - An inline note when the last fetch failed.
  - A note on rows whose currency no source publishes.
  - All three "57.80" examples are removed.
- **Tests never reach the network:**
  - `testDeps` injects a rate source that refuses every call.
  - Adapter tests use fixture JSON.
  - e2e sets `HB_FX=fixture` and reads a temp directory that only `e2e/rates.spec.ts` fills.

## Architecture

### Data shape (contract, `src/shared/api.ts`)

```ts
export const FX_RATE_BY = ["user", "ecb", "currency-api"] as const;
export const FxRateBy = z.enum(FX_RATE_BY);
export type FxRateBy = z.infer<typeof FxRateBy>;

/** One stored rate: view-currency units per 1 unit, when it was written (typed or fetched), by whom, and the source's rate date. */
export const FxRateEntry = z.object({
  rate: z.number().positive(),
  setAt: z.iso.datetime(),           // for fetched rates this is the fetch time
  by: FxRateBy,
  rateDate: z.iso.date().nullable(), // null for user-set rates
});

/** The last automatic fetch attempt (button or Refresh). */
export const FxFetchStatus = z.object({
  at: z.iso.datetime(),
  error: z.string().nullable(),      // null when every reachable currency was filled
  unsupported: z.array(z.string()),  // currencies neither source publishes
});

// SettingsDto.money gains: fetch: FxFetchStatus.nullable()

export const FillRatesResult = z.object({
  filled: z.array(z.object({ currency: z.string(), rate: z.number(), by: z.enum(["ecb", "currency-api"]) })),
  kept: z.array(z.string()),         // user-set, skipped
  unsupported: z.array(z.string()),  // no source publishes it
  unavailable: z.array(z.string()),  // the source that would serve it failed
  viewChanged: z.boolean(),          // the view currency changed mid-flight: nothing was written
});
export const FillRatesResponse = z.object({ settings: SettingsDto, fill: FillRatesResult });
```

- Add `"rates_unavailable"` to `ERROR_CODES` (`src/shared/api.ts:61`), and `rates_unavailable: 503` to `STATUS` in `src/server/services/context.ts`.
- **Where metadata lives:**
  - Each entry's `setAt` holds its fetch time, so the age line can be computed per source from the entries.
  - `users.fx_fetch` holds the last attempt, including a failure.

### Positions on the contested points

1. **The gate lives in a new `users.fx_fetch` jsonb column.** Deriving it from entry `setAt`s can't record a failed fetch or remember which currencies are unsupported, so every Refresh would hit a broken source again. `hb_sync`'s column grants (`drizzle/0004_sync_role.sql`) leave out the new column, which is correct.
2. **Gate rules:**
   - The gate opens 20 h after a good fetch. 20 h instead of 24 h means a daily Refresh run a few minutes earlier than yesterday's isn't skipped.
   - After a failed fetch, it waits 1 h.
   - A needed currency with no rate opens the gate at once, unless it is known to be unsupported or the last failure was less than 1 h ago.
   - The button ignores the gate.
3. **The Refresh fill runs after the sources loop.** It runs inside the `startRefresh` closure after `runRefresh` returns, as `ctx.step("Updating exchange rates")`. Running it after the loop means currencies from newly found jobs get rates in the same Refresh. Every throw is caught and logged, and the Refresh result is unchanged.
4. **Rates are rounded to 6 significant digits** with `Number(x.toPrecision(6))`.
   - For the ECB path, query Frankfurter with no `base` (it defaults to EUR) and compute `rate(X) = r[VIEW] / r[X]`, with EUR = 1. This also avoids Frankfurter's error on an unknown `symbols` value.
   - currency-api `<view>.json` values are full-precision, so plain inversion is fine there.
5. **Concurrency:**
   - **Fetch, then write under a lock.** `fillRates` reads, fetches with no transaction open, then writes in a transaction with `SELECT … FOR UPDATE` on the user row.
   - **The view currency changed mid-flight:** write nothing and return `viewChanged: true`.
   - **The user typed a rate mid-flight:** the typed rate wins and is listed in `kept`.
   - **Manual saves use the same lock.** `updateSettings` also moves its read-modify-write into a transaction with `FOR UPDATE`.
   - **Single flight:** a module-level `Map<UserId, Promise>` in `rates.ts`. A button press during a Refresh fill shares the same network call.
6. **Changing the view currency does not fetch inside PATCH.** The change also sets `fx_fetch = null`, so the next Refresh gate is open. The existing toast gains a **Fill rates** action.
7. **Network-free tests, in layers:**
   - `testDeps` defaults `fx` to `offlineFx()`, which throws on every call.
   - Adapter tests use a fake `fetch` that serves `test/fixtures/fx/` and throws on any other URL.
   - e2e uses `HB_FX=fixture` with `HB_FX_DIR`, following the `E2E_GITHUB_DIR` convention. Only `rates.spec.ts` copies fixtures into that directory, so every other spec sees the "unreachable" path.
8. **Partial success and failure:**

   | Case | Response | Recorded |
   |---|---|---|
   | Partial | 200, with `unavailable` and `unsupported` listed | `fx_fetch.error` set, which arms the 1 h retry |
   | Total: currencies were needed, every source failed, nothing was written | `AppError rates_unavailable` → 503 | `fx_fetch` recorded first |
   | Unsupported only | 200, not a failure | — |
   | Nothing needed | 200, no network call | `fx_fetch` untouched |

### Which currencies are needed

`neededCurrencies(db, user)` lives in `rates.ts` and `getSettings` reuses it. It returns the union of:
- the open jobs' `pay_currency` values that differ from the view currency (the existing query)
- `users.min_pay.currency`, when it differs from the view currency (the pay filter needs it)
- every entry with `by !== 'user'`

User-set entries are reported in `kept`, never fetched. `missingRates` means needed currencies with no entry.

### Pure functions (`src/domain/fx.ts`)

`roundRate`, `crossFromEur({ view, eurRates })` (null when the view currency isn't in the table), `invertFromView({ perView })` (drops zero, negative and non-finite values; uppercases keys), `splitBySource`, `fillDue({ fetch, missing, now })`, `FILL_EVERY_MS = 20h`, `RETRY_FAILED_MS = 1h`, `MAX_FX_RATE = 1_000_000`.

A rate outside `(0, 1_000_000]` counts as unsupported. When the view currency is not an ECB currency, every currency goes to currency-api.

### Adapter (`src/server/adapters/fx.ts`)

```ts
export type FxQuote = { by: "ecb" | "currency-api"; rateDate: string; rates: Record<string, number> }; // view units per 1 X, rounded
export class FxError extends Error { constructor(readonly source: "ecb" | "currency-api", message: string) }
export type FxSource = { ecb(view: string): Promise<FxQuote>; currencyApi(view: string): Promise<FxQuote> };
export function createFxSource(http: HttpClient): FxSource;
export function offlineFx(): FxSource;
export function createFixtureFx({ dir }: { dir: string }): FxSource;
```

- **ECB:** `GET https://api.frankfurter.dev/v1/latest`, validated with zod: `{ base: "EUR", date, rates: record<[A-Z]{3}, positive> }`. If the ECB does not publish the view currency, it throws `FxError("ecb", …)`.
- **currency-api:** `GET https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/<view>.json`. On a failure it retries once at `https://latest.currency-api.pages.dev/v1/currencies/<view>.json`.
- `HttpError`, `JSON.parse` failures and `ZodError` all become an `FxError` whose message is a sentence the user can read.

## Risks

- **Empty-map backfill:** `jsonb_object_agg` over zero rows returns NULL, so wrap it in `COALESCE(…, '{}'::jsonb)`.
- **Old-shape entries:** `getSettings` normalizes `by ?? "user"` and `rateDate ?? null` when reading.
- **Rate dates trail:** jsDelivr `@latest` caching can leave the rate date 1–2 days behind. The UI shows the date from `date` as it is.
- **Slow failures:** a dead source can delay the last Refresh step by about 30 s (10 s timeout × 3 attempts). The 1 h failure gate limits how often that happens.
- **Exact-shape tests:** tests that assert the exact `SettingsDto` shape need `fetch: null` and the new entry fields.
- **e2e side effect:** every Refresh in e2e now attempts a fill, which fails because the directory is empty. Grep `e2e/` for "to set" and "Rates" before finishing.
- **Fixture coverage:** the FX fixtures must cover every currency the fixture sources produce. Today those are AUD, CAD, EUR, GBP, INR, MXN, SEK, SGD and USD. Add one currency that only currency-api publishes.
- **Drizzle locking:** use `tx.select(...).for("update")`, which is in drizzle-orm 0.45 for pg.

## Not doing

- No AI.
- No rate history.
- No scheduled fetching.
- No auto-fill from the Add-rate form.
- No change to `pay.ts` or `payBelow`.
- No change to `hb_sync`, its grants or `sync.ts`.
- No fetching on PATCH.
- No commits.

## Tasks

1. **Contract and migration** (`api.ts`, `schema.ts`, `drizzle/0012_fx_auto.sql` and its journal and snapshot, `settings.ts`, `context.ts`, `test/settings.test.ts`, and a one-line provenance change in `settings.tsx`).
   - Add the shapes above and the `fxFetch` jsonb column.
   - Generate the migration with `bun run db:generate -- --name fx_auto`, then append the COALESCE backfill `UPDATE` that adds `"by":"user","rateDate":null`.
   - `getSettings` normalizes old entries and returns `fetch`.
   - `updateSettings`:
     - moves into a `FOR UPDATE` transaction
     - writes new entries as `by: "user"`
     - sets `fxFetch = null` when the view currency changes
   - Tests:
     - The fresh-install `toEqual` includes `fetch: null`.
     - A typed rate has `by: "user"`.
     - A view change resets `fetch`.
     - An old-shape entry reads back as `user`.
     - The backfill statement rewrites stored JSON.
2. **Domain** (`src/domain/fx.ts`, `test/fx-domain.test.ts`). Test first. The fixture rates are `{ EUR: 1, PHP: 70.858, USD: 1.1253, JPY: 177.82 }` with view PHP.

   | Input | Expected |
   |---|---|
   | `crossFromEur`, USD | 62.9681 |
   | `crossFromEur`, EUR | 70.858 |
   | `crossFromEur`, JPY | 0.398481 |
   | `crossFromEur`, view currency not in the table | null |
   | `invertFromView` `{usd:0.01588, php:1, xts:0, eur:-1}` | `{USD:62.9723, PHP:1}` |
   | `roundRate(0.0000615123)` | 0.0000615123 |
   | `roundRate(16250.4567)` | 16250.5 |

   `fillDue` cases:
   - no `fetch` → true
   - success 19 h ago → false
   - success 20 h ago → true
   - failed 30 min ago with a missing currency → false
   - failed 61 min ago → true
   - success 2 h ago with a new missing currency → true
   - success 2 h ago where the missing currency is unsupported → false

   `splitBySource` gets cases too. Check `test/architecture.test.ts` before importing anything from `src/shared` into `src/domain`.
3. **Adapter** (`src/server/adapters/fx.ts`, `test/fixtures/fx/frankfurter-latest.json`, `test/fixtures/fx/currency-api-php.json`, `test/fx-adapter.test.ts`). Test through `createHttpClient({ fetch: fake, sleep: noop })`:
   - `ecb("PHP")` gives USD 62.9681 and `rateDate` 2026-10-16.
   - `ecb("VND")` throws.
   - `currencyApi("PHP")` returns uppercase keys.
   - **Mirror:** jsDelivr answers 503 three times, then pages.dev succeeds.
   - **Malformed or HTML bodies** → `FxError`.
   - **Both 404** → `FxError` with `source` set.
   - `offlineFx` rejects.
4. **Deps wiring** (`context.ts`, `env.ts`, `main.ts`, `test/setup.ts`, plus `createFixtureFx` in `fx.ts`):
   - `Deps.fx`.
   - `HB_FX` is `live | fixture` (default `live`). `HB_FX_DIR` defaults to `./test/fixtures/fx`.
   - `createFixtureFx` serves files from `dir`. A missing file counts as a network error.
   - `testDeps` defaults `fx` to `offlineFx()`.
   - Fix every other `Deps` literal tsc flags.
   - Fixture tests: an empty directory rejects, and the fixtures directory resolves.
5. **Service and route** (`src/server/services/rates.ts`, `settings.ts`, `routes/settings.ts`, `test/rates.test.ts`). Test first.
   - **Fill paths:**
     - fills from the ECB, with `rateDate`, `setAt` equal to the clock time, and `missingRates` empty
     - **user rates kept:** a typed USD 60 survives and is listed in `kept`. Clearing it makes the next fill set ECB 62.9681.
     - **fallback:** when the ECB throws, every currency comes from currency-api
   - **Failure paths:**
     - **unsupported:** the currency is listed, stays in `missingRates`, and appears in `fetch.unsupported`
     - **partial:** currency-api throws, so its currency is in `unavailable` and `fetch.error` is set
     - **total:** both sources throw → 503, existing rates unchanged, and `fetch` recorded
     - **nothing needed:** zero calls, and `fetch` stays null
   - **Concurrency:**
     - **view change mid-flight:** deferred promises → `viewChanged`, nothing written
     - **user types mid-flight:** the typed rate wins
     - **single flight:** two concurrent fills make one ECB call
   - **Min pay:** a `min_pay` currency is requested.
   - Route: `const fill = await fillRates(deps); return c.json({ settings: await getSettings(deps), fill })`.
6. **Refresh** (`rates.ts` `fillRatesIfDue`, `sources.ts`, `test/rates-refresh.test.ts`).
   - In `startRefresh`: `const result = await runRefresh(deps, ctx); await fillRatesIfDue(deps, ctx); return result;`
   - Swallow every error with `console.warn`.
   - Tests:
     - The first Refresh fills.
     - 2 h later: 0 calls. 21 h later: 1 call.
     - A new currency 2 h later: 1 call.
     - 30 min after a failure: 0 calls. 61 min after: 1 call.
     - With `offlineFx`, the Refresh still ends `done`, rates are unchanged, and `fetch.error` is set.
     - The Refresh fill never touches a user rate.
   - `test/sync-invariant.test.ts` and the architecture test still pass.
7. **Labels** (`src/shared/labels.ts` and its test):
   - Extract `agoLabel` from `refreshedLabel`. `refreshedLabel` must give the same output as before.
   - `fxAgeLabel` gives, for example, "ECB rates of 16 Oct · fetched 2 hours ago". It reads `rateDate` as UTC and formats it with `en-GB`, `timeZone: "UTC"`, so it can never show "15 Oct".
   - `fxProvenanceLabel` returns ECB, currency-api, or Set by you.
   - `fxAgeLines` returns one line per fetched source, ECB first, and no line when every rate is the user's.
8. **UI** (`settings.tsx`, `queries.ts`):
   - **Queries:** extract `settingsChanged`. Add `useFillRates`. Invalidate settings when a Refresh finishes.
   - **Fill rates button:**
     - Shows "Filling…" while pending.
     - It is disabled, with a title, when nothing is needed.
     - Success toasts: filled N, plus any unsupported or unavailable currencies; "view changed"; "Every rate is already set."
     - Errors go to `onError`.
   - **Rates section:**
     - Age lines in `<time>` elements.
     - An inline note when `fetch.error` is set.
     - Row helper text for fetched rates, rates set by you (with "Remove to update it automatically"), and unsupported currencies.
     - Row key: `${currency}:${rate}:${setAt}`.
   - **Copy:**
     - Remove all three "57.80" examples (lines ~427, ~468 and ~508). The validation message becomes "Enter a number above zero." The placeholder becomes "Rate".
     - New section description.
   - **View change:** the view-change toast gets a **Fill rates** action.
9. **e2e** (`playwright.config.ts`, `e2e/rates.spec.ts`):
   - **Config:** add `E2E_FX_DIR`, created empty at config load. Add `HB_FX=fixture` and `HB_FX_DIR`.
   - **Spec setup:** copy the fixtures in, then run a Refresh, which fills the rates.
   - **Fill rates flow:**
     1. Settings shows "ECB rates of 16 Oct · fetched" and ECB rows.
     2. Type USD 60. The row reads "Set by you".
     3. Clear EUR.
     4. Click Fill rates. EUR comes back as ECB, and USD stays at 60.
   - **Failure:** with the directory empty, the error toast shows and USD stays at 60.
   - Run the whole suite and fix any specs whose Settings text changed.
10. **Docs:**
    - **Decision 20:** "Rates fill automatically from public sources (decision 67); a rate the user types overrides them."
    - **Decision 67, "Exchange rates fill themselves.":** it covers:
      - sources, and the EUR cross
      - the button and the gate (20 h; 1 h after a failure; at once for a new currency)
      - typed rates are never overwritten, and removing one hands it back to automatic updates
      - 6 significant digits
      - failures keep existing rates
      - a view change still clears rates and offers Fill rates
      - no AI
      - why: typing nine rates by hand
    - **PLAN open question 2:** update the wording to match.

## Verify

- `bun run check`
- `bun run build && bunx playwright test`
- One live Fill rates against the dev server. USD should come out at about 63, and the ECB date may trail on weekends.
