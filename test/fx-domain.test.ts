import { describe, expect, test } from "bun:test";
import {
  crossFromEur,
  FILL_EVERY_MS,
  fillDue,
  invertFromView,
  MAX_FX_RATE,
  RETRY_FAILED_MS,
  roundRate,
  splitBySource,
} from "@/domain/fx";

// The ECB's rates against EUR on 16 Oct 2026, as Frankfurter returns them (decision 67).
const EUR_RATES = { EUR: 1, PHP: 70.858, USD: 1.1253, JPY: 177.82 };
const NOW = new Date("2026-10-18T08:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;

describe("roundRate", () => {
  test("keeps 6 significant digits at any size", () => {
    expect(roundRate(0.0000615123)).toBe(0.0000615123);
    expect(roundRate(16250.4567)).toBe(16250.5);
    expect(roundRate(62.968097396249895)).toBe(62.9681);
  });
});

describe("crossFromEur", () => {
  test("crosses through EUR, so USD keeps the ECB's precision", () => {
    const rates = crossFromEur({ view: "PHP", eurRates: EUR_RATES });
    expect(rates?.USD).toBe(62.9681);
    expect(rates?.EUR).toBe(70.858);
    // 70.858 / 177.82 = 0.39848161…, which rounds to 0.398482.
    expect(rates?.JPY).toBe(0.398482);
    expect(rates?.PHP).toBeUndefined();
  });

  test("EUR is 1 when the table leaves out its own base", () => {
    expect(crossFromEur({ view: "PHP", eurRates: { PHP: 70.858 } })).toEqual({ EUR: 70.858 });
  });

  test("a view currency the table lacks gives null", () => {
    expect(crossFromEur({ view: "VND", eurRates: EUR_RATES })).toBeNull();
  });

  test("a rate outside (0, 1,000,000] is dropped", () => {
    const rates = crossFromEur({ view: "PHP", eurRates: { PHP: 70.858, ZZZ: 0.00000001, BAD: 0, NEG: -1 } });
    expect(rates).toEqual({ EUR: 70.858 });
    expect(MAX_FX_RATE).toBe(1_000_000);
  });
});

describe("invertFromView", () => {
  test("inverts, uppercases keys and drops zero, negative and non-finite values", () => {
    expect(invertFromView({ perView: { usd: 0.01588, php: 1, xts: 0, eur: -1 } })).toEqual({ USD: 62.9723, PHP: 1 });
    expect(invertFromView({ perView: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY } })).toEqual({});
  });

  test("drops keys that are not three letters and rates above the cap", () => {
    expect(invertFromView({ perView: { "1inch": 0.5, usdt: 0.0159, btc: 1e-7, gbp: 0.0136 } })).toEqual({
      GBP: 73.5294,
    });
  });
});

describe("splitBySource", () => {
  test("currencies the ECB quoted come from it; the rest go to currency-api", () => {
    expect(splitBySource({ needed: ["EUR", "USD", "VND"], ecb: { EUR: 70.858, USD: 62.9681 } })).toEqual({
      ecb: ["EUR", "USD"],
      currencyApi: ["VND"],
    });
  });

  test("with no ECB quote (failed, or the view is not an ECB currency) everything goes to currency-api", () => {
    expect(splitBySource({ needed: ["USD", "EUR"], ecb: null })).toEqual({ ecb: [], currencyApi: ["USD", "EUR"] });
  });

  test("nothing needed is nothing to fetch", () => {
    expect(splitBySource({ needed: [], ecb: { USD: 62.9681 } })).toEqual({ ecb: [], currencyApi: [] });
  });
});

describe("fillDue", () => {
  const ok = (at: string, unsupported: string[] = []) => ({ at, error: null, unsupported });
  const failed = (at: string) => ({ at, error: "The ECB could not be reached.", unsupported: [] });

  test("the constants are 20 hours and 1 hour", () => {
    expect(FILL_EVERY_MS).toBe(20 * HOUR);
    expect(RETRY_FAILED_MS).toBe(HOUR);
  });

  test("no fetch yet is due", () => {
    expect(fillDue({ fetch: null, missing: [], now: NOW })).toBe(true);
  });

  test("a good fetch is due again after 20 hours, not before", () => {
    expect(fillDue({ fetch: ok(ago(19 * HOUR)), missing: [], now: NOW })).toBe(false);
    expect(fillDue({ fetch: ok(ago(20 * HOUR)), missing: [], now: NOW })).toBe(true);
  });

  test("a failed fetch waits an hour, even with a currency missing", () => {
    expect(fillDue({ fetch: failed(ago(30 * 60_000)), missing: ["USD"], now: NOW })).toBe(false);
    expect(fillDue({ fetch: failed(ago(61 * 60_000)), missing: ["USD"], now: NOW })).toBe(true);
    expect(fillDue({ fetch: failed(ago(61 * 60_000)), missing: [], now: NOW })).toBe(true);
  });

  test("a new missing currency is due at once, unless no source publishes it", () => {
    expect(fillDue({ fetch: ok(ago(2 * HOUR)), missing: ["SEK"], now: NOW })).toBe(true);
    expect(fillDue({ fetch: ok(ago(2 * HOUR), ["XAF"]), missing: ["XAF"], now: NOW })).toBe(false);
  });
});
