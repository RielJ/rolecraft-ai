import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { crossFromEur, invertFromView } from "@/domain/fx";
import { type HttpClient, HttpError, type HttpText } from "./http";

/**
 * Public exchange-rate sources (decision 67). The ECB's reference rates come from Frankfurter;
 * currencies the ECB does not publish come from fawazahmed0's currency-api (jsDelivr first, then
 * its pages.dev mirror). Every request goes through the polite HttpClient.
 */

export type FxBy = "ecb" | "currency-api";

/** Rates in view-currency units per 1 unit of each currency, rounded to 6 significant digits. */
export type FxQuote = { by: FxBy; rateDate: string; rates: Record<string, number> };

export class FxError extends Error {
  readonly source: FxBy;
  constructor(source: FxBy, message: string) {
    super(message);
    this.name = "FxError";
    this.source = source;
  }
}

export type FxSource = {
  /** ECB rates, crossed through EUR. Throws `FxError` when the ECB does not publish `view`. */
  ecb(view: string): Promise<FxQuote>;
  currencyApi(view: string): Promise<FxQuote>;
};

export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
export const currencyApiUrls = (view: string): [string, string] => {
  const code = view.toLowerCase();
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${code}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${code}.json`,
  ];
};

const JSON_ACCEPT = "application/json";

// Frankfurter with no `base` answers in EUR; asking for EUR keeps its 5 significant digits exact.
const FrankfurterLatest = z.object({
  base: z.literal("EUR"),
  date: z.iso.date(),
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()),
});

/** currency-api's `<view>.json`: `{ date, <view>: { <code>: units per 1 view unit } }`, codes in lower case. */
const CurrencyApiBody = z.looseObject({ date: z.iso.date() });
const CurrencyApiTable = z.record(z.string(), z.unknown());

/** The body parsed and checked against `schema`, or null for HTML, junk or the wrong shape. */
function parseBody<T>(schema: z.ZodType<T>, body: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function ecbQuote(http: HttpClient, view: string): Promise<FxQuote> {
  let res: HttpText;
  try {
    res = await http.getText(FRANKFURTER_URL, { accept: JSON_ACCEPT });
  } catch (err) {
    if (err instanceof HttpError) throw new FxError("ecb", `Could not get ECB rates from Frankfurter. ${err.message}`);
    throw err;
  }
  const parsed = parseBody(FrankfurterLatest, res.body);
  if (parsed === null) throw new FxError("ecb", "Frankfurter sent ECB rates the app could not read.");
  const rates = crossFromEur({ view, eurRates: parsed.rates });
  if (rates === null) throw new FxError("ecb", `The ECB publishes no rate for ${view}.`);
  return { by: "ecb", rateDate: parsed.date, rates };
}

async function currencyApiFrom(http: HttpClient, url: string, view: string): Promise<FxQuote> {
  let res: HttpText;
  try {
    res = await http.getText(url, { accept: JSON_ACCEPT });
  } catch (err) {
    if (err instanceof HttpError)
      throw new FxError("currency-api", `Could not get rates from currency-api. ${err.message}`);
    throw err;
  }
  const parsed = parseBody(CurrencyApiBody, res.body);
  const table = CurrencyApiTable.safeParse(parsed?.[view.toLowerCase()]);
  if (parsed === null || !table.success) {
    throw new FxError("currency-api", "currency-api sent rates the app could not read.");
  }
  // Crypto and other entries can be any shape; only numbers are rates.
  const perView: Record<string, number> = {};
  for (const [key, value] of Object.entries(table.data)) if (typeof value === "number") perView[key] = value;
  const rates = invertFromView({ perView });
  delete rates[view];
  return { by: "currency-api", rateDate: parsed.date, rates };
}

export function createFxSource(http: HttpClient): FxSource {
  return {
    ecb: (view) => ecbQuote(http, view),
    async currencyApi(view) {
      const [primary, mirror] = currencyApiUrls(view);
      try {
        return await currencyApiFrom(http, primary, view);
      } catch (err) {
        if (!(err instanceof FxError)) throw err;
        // jsDelivr failed or sent junk: the same files are mirrored on pages.dev.
        return currencyApiFrom(http, mirror, view);
      }
    },
  };
}

/** Rate sources that refuse every call. Tests use this so they never reach the network. */
export function offlineFx(): FxSource {
  const refuse = (source: FxBy) => async (): Promise<FxQuote> => {
    throw new FxError(source, `${source === "ecb" ? "ECB rates are" : "currency-api is"} turned off here.`);
  };
  return { ecb: refuse("ecb"), currencyApi: refuse("currency-api") };
}

/**
 * Rate sources read from files instead of the network (`HB_FX=fixture`): `frankfurter-latest.json`
 * and `currency-api-<view>.json` in `dir`. A missing file fails like an unreachable site, so an
 * empty directory is the offline case. The real parsing runs unchanged.
 */
export function createFixtureFx({ dir }: { dir: string }): FxSource {
  const [jsdelivr = "", pagesDev = ""] = currencyApiUrls("x").map((u) => u.slice(0, u.lastIndexOf("/") + 1));
  const fileFor = (url: string): string | null => {
    if (url === FRANKFURTER_URL) return "frankfurter-latest.json";
    for (const prefix of [jsdelivr, pagesDev]) {
      if (url.startsWith(prefix)) return `currency-api-${url.slice(prefix.length).replace(/\.json$/, "")}.json`;
    }
    return null;
  };
  const http: HttpClient = {
    async getText(url) {
      const name = fileFor(url);
      const body = name === null ? null : await readFile(join(dir, name), "utf8").catch(() => null);
      if (body === null) throw new HttpError({ kind: "network", message: "The site could not be reached." });
      return { url, status: 200, contentType: "application/json", body };
    },
  };
  return createFxSource(http);
}
