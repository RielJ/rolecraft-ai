import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { fillDue, splitBySource } from "@/domain/fx";
import type { FillRatesResult, FxRateEntry, Money, UserId } from "@/shared/api";
import { FxError, type FxQuote } from "../adapters/fx";
import type { DbOrTx } from "../db/client";
import { jobs, users } from "../db/schema";
import { AppError, type Deps } from "./context";
import type { TaskContext } from "./tasks";

/**
 * Automatic exchange rates (decision 67). A fill reads what is needed, fetches with no
 * transaction open, then merges under a lock on the user row. A rate the user typed is never
 * overwritten. Runs as the app role only: from the Fill rates button, and after a Refresh's
 * sources, never under the sync role.
 */

/**
 * Stored rates in the current shape. Migration 0012 backfills old entries, so this only guards a
 * row written by an older build: an entry with no `by` was typed by the user.
 */
export function normalizeRates(stored: Record<string, Partial<FxRateEntry>>): Record<string, FxRateEntry> {
  const out: Record<string, FxRateEntry> = {};
  for (const [currency, entry] of Object.entries(stored)) {
    if (typeof entry.rate !== "number" || typeof entry.setAt !== "string") continue;
    out[currency] = { rate: entry.rate, setAt: entry.setAt, by: entry.by ?? "user", rateDate: entry.rateDate ?? null };
  }
  return out;
}

type RatesUser = {
  id: UserId;
  viewCurrency: string;
  minPay: Money | null;
  fxRates: Record<string, FxRateEntry>;
};

/**
 * Currencies that need a rate, sorted: open jobs' pay currencies, the min pay's currency (the pay
 * filter needs it), and every fetched rate already stored, so it stays current. Never the view
 * currency. Rates the user typed are in this list too; a fill keeps them.
 */
export async function neededCurrencies(db: DbOrTx, user: RatesUser): Promise<string[]> {
  const rows = await db
    .selectDistinct({ currency: jobs.payCurrency })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, user.id),
        isNull(jobs.closedAt),
        isNotNull(jobs.payCurrency),
        ne(jobs.payCurrency, user.viewCurrency),
      ),
    );
  const needed = new Set<string>();
  for (const { currency } of rows) if (currency !== null) needed.add(currency);
  if (user.minPay) needed.add(user.minPay.currency);
  for (const [currency, entry] of Object.entries(user.fxRates)) if (entry.by !== "user") needed.add(currency);
  needed.delete(user.viewCurrency);
  return [...needed].sort();
}

async function loadUser(
  db: DbOrTx,
  userId: UserId,
): Promise<RatesUser & { fxFetch: typeof users.$inferSelect.fxFetch }> {
  const [row] = await db
    .select({
      viewCurrency: users.viewCurrency,
      minPay: users.minPay,
      fxRates: users.fxRates,
      fxFetch: users.fxFetch,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new Error("user row missing");
  return { id: userId, ...row, fxRates: normalizeRates(row.fxRates), fxFetch: row.fxFetch ?? null };
}

/** The quote, or the source's error. Anything that is not an FxError is a bug and throws. */
async function attempt(fetch: () => Promise<FxQuote>): Promise<FxQuote | FxError> {
  try {
    return await fetch();
  } catch (err) {
    if (err instanceof FxError) return err;
    throw err;
  }
}

const inflight = new Map<UserId, Promise<FillRatesResult>>();

/**
 * Fill every needed rate the user did not type. One fill per user at a time: a second call while
 * one runs (the button during a Refresh) gets the same result. Throws `rates_unavailable` when
 * rates were needed and every source failed.
 */
export function fillRates(deps: Deps): Promise<FillRatesResult> {
  const running = inflight.get(deps.userId);
  if (running) return running;
  const fill = runFill(deps).finally(() => inflight.delete(deps.userId));
  inflight.set(deps.userId, fill);
  return fill;
}

async function runFill(deps: Deps): Promise<FillRatesResult> {
  const user = await loadUser(deps.db, deps.userId);
  const view = user.viewCurrency;
  const needed = await neededCurrencies(deps.db, user);
  const kept = needed.filter((c) => user.fxRates[c]?.by === "user");
  const wanted = needed.filter((c) => !kept.includes(c));
  if (wanted.length === 0) return { filled: [], kept, unsupported: [], unavailable: [], viewChanged: false };

  // Fetch with no transaction open: a slow source must not hold the user row.
  const ecb = await attempt(() => deps.fx.ecb(view));
  const split = splitBySource({ needed: wanted, ecb: ecb instanceof FxError ? null : ecb.rates });
  const currencyApi = split.currencyApi.length ? await attempt(() => deps.fx.currencyApi(view)) : null;

  const fetched: { currency: string; rate: number; by: FxQuote["by"]; rateDate: string }[] = [];
  const unsupported: string[] = [];
  const unavailable: string[] = [];
  for (const currency of wanted) {
    const quote = split.ecb.includes(currency) ? ecb : currencyApi;
    if (quote === null || quote instanceof FxError) {
      unavailable.push(currency);
      continue;
    }
    const rate = quote.rates[currency];
    if (rate === undefined) unsupported.push(currency);
    else fetched.push({ currency, rate, by: quote.by, rateDate: quote.rateDate });
  }
  // An ECB failure that currency-api covered is not worth showing; one that left a currency unfilled is.
  const errors = unavailable.length
    ? [ecb, currencyApi].filter((q): q is FxError => q instanceof FxError).map((e) => e.message)
    : [];
  const error = errors.length ? [...new Set(errors)].join(" ") : null;

  const now = deps.clock.now().toISOString();
  const written = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ viewCurrency: users.viewCurrency, fxRates: users.fxRates })
      .from(users)
      .where(eq(users.id, deps.userId))
      .for("update");
    if (!row) throw new Error("user row missing");
    // The rates were fetched for the old view currency, so they are all wrong now.
    if (row.viewCurrency !== view) return null;
    const rates = normalizeRates(row.fxRates);
    const filled: FillRatesResult["filled"] = [];
    const typed: string[] = [];
    for (const f of fetched) {
      // The user typed this rate while the fill was fetching: theirs wins.
      if (rates[f.currency]?.by === "user") {
        typed.push(f.currency);
        continue;
      }
      rates[f.currency] = { rate: f.rate, setAt: now, by: f.by, rateDate: f.rateDate };
      filled.push({ currency: f.currency, rate: f.rate, by: f.by });
    }
    await tx
      .update(users)
      .set({ fxRates: rates, fxFetch: { at: now, error, unsupported } })
      .where(eq(users.id, deps.userId));
    return { filled, typed };
  });
  if (written === null) return { filled: [], kept, unsupported, unavailable, viewChanged: true };
  if (written.filled.length === 0 && written.typed.length === 0 && unavailable.length > 0) {
    throw new AppError({ code: "rates_unavailable", message: error ?? "The rate sources could not be reached." });
  }
  return {
    filled: written.filled,
    kept: [...kept, ...written.typed].sort(),
    unsupported,
    unavailable,
    viewChanged: false,
  };
}

/**
 * The Refresh step (decision 67): fill when `fillDue` says so. It never fails the Refresh; a
 * failed fetch is recorded in `users.fx_fetch` and Settings shows it.
 */
export async function fillRatesIfDue(deps: Deps, ctx: TaskContext): Promise<void> {
  try {
    const user = await loadUser(deps.db, deps.userId);
    const needed = await neededCurrencies(deps.db, user);
    // Only typed rates, or none needed: nothing to fetch and no step to show.
    if (needed.every((c) => user.fxRates[c]?.by === "user")) return;
    const missing = needed.filter((c) => user.fxRates[c] === undefined);
    if (!fillDue({ fetch: user.fxFetch, missing, now: deps.clock.now() })) return;
    await ctx.step("Updating exchange rates");
    await fillRates(deps);
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "rate fill failed", error: String(err) }));
  }
}
