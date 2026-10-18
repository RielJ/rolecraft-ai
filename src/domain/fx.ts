import type { FxFetchStatus } from "@/shared/api";

/**
 * Exchange-rate math for automatic fills (decision 67). Every rate is view-currency units per 1
 * unit of the other currency, like the rates the user types (decision 20).
 */

/** A good fetch is due again after this. 20 hours, so a daily Refresh a little earlier still fills. */
export const FILL_EVERY_MS = 20 * 60 * 60 * 1000;
/** After a failed fetch, Refresh waits this long before trying again. */
export const RETRY_FAILED_MS = 60 * 60 * 1000;
/** The largest rate the app stores, the same cap as a typed rate. Anything above counts as unsupported. */
export const MAX_FX_RATE = 1_000_000;

const CODE = /^[A-Z]{3}$/;

/** 6 significant digits: more than any source publishes, and short enough to read. */
export function roundRate(rate: number): number {
  return Number(rate.toPrecision(6));
}

const usable = (rate: number): boolean => Number.isFinite(rate) && rate > 0 && rate <= MAX_FX_RATE;

/**
 * Rates for `view` from a table of units per 1 EUR (the ECB's reference rates): rate(X) =
 * r[view] / r[X], with EUR = 1. Null when the table has no rate for `view`.
 */
export function crossFromEur({
  view,
  eurRates,
}: {
  view: string;
  eurRates: Readonly<Record<string, number>>;
}): Record<string, number> | null {
  const table: Record<string, number> = { EUR: 1, ...eurRates };
  const perEur = table[view];
  if (perEur === undefined || !Number.isFinite(perEur) || perEur <= 0) return null;
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(table)) {
    if (code === view || !CODE.test(code) || !Number.isFinite(value) || value <= 0) continue;
    const rate = roundRate(perEur / value);
    if (usable(rate)) out[code] = rate;
  }
  return out;
}

/**
 * Rates from a table of units per 1 view-currency unit (currency-api's `<view>.json`): rate(X) =
 * 1 / r[X]. Keys are uppercased; keys that are not three letters and unusable values are dropped.
 */
export function invertFromView({ perView }: { perView: Readonly<Record<string, number>> }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(perView)) {
    const code = key.toUpperCase();
    if (!CODE.test(code) || !Number.isFinite(value) || value <= 0) continue;
    const rate = roundRate(1 / value);
    if (usable(rate)) out[code] = rate;
  }
  return out;
}

/**
 * Which source serves each needed currency. The ECB comes first; whatever its quote lacks (or
 * everything, when the ECB failed or does not publish the view currency) goes to currency-api.
 */
export function splitBySource({
  needed,
  ecb,
}: {
  needed: readonly string[];
  ecb: Readonly<Record<string, number>> | null;
}): { ecb: string[]; currencyApi: string[] } {
  const fromEcb = ecb === null ? [] : needed.filter((c) => ecb[c] !== undefined);
  return { ecb: fromEcb, currencyApi: needed.filter((c) => !fromEcb.includes(c)) };
}

/**
 * Whether a Refresh should fetch rates. Due with no fetch yet, 20 hours after a good fetch, and 1
 * hour after a failed one. A needed currency with no rate is due at once, unless no source
 * publishes it or the last fetch failed less than an hour ago. The Fill rates button skips this.
 */
export function fillDue({
  fetch,
  missing,
  now,
}: {
  fetch: FxFetchStatus | null;
  missing: readonly string[];
  now: Date;
}): boolean {
  if (fetch === null) return true;
  const age = now.getTime() - new Date(fetch.at).getTime();
  if (fetch.error !== null) return age >= RETRY_FAILED_MS;
  if (age >= FILL_EVERY_MS) return true;
  return missing.some((c) => !fetch.unsupported.includes(c));
}
