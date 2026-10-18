import type { PayPeriod } from "@/shared/enums";

/** Pay as posted (decision 20). `max` is null for a single figure; `period` is null when unstated. */
export type Pay = { min: number; max: number | null; currency: string; period: PayPeriod | null; phrase: string };

/** View-currency units per one unit of each other currency, e.g. `{ USD: 57.8 }` (open question 2). */
export type FxRates = Readonly<Record<string, number>>;

/** Section 6, open question 2: periods convert to monthly at these rates. */
const PER_MONTH: Readonly<Record<PayPeriod, number>> = {
  hour: 173.33,
  day: 21.67,
  week: 4.33,
  month: 1,
  year: 1 / 12,
};

export function toMonthly({ amount, period }: { amount: number; period: PayPeriod }): number {
  return amount * PER_MONTH[period];
}

/** `amount` in the view currency, or null when the currency has no rate set. */
export function convert({
  amount,
  currency,
  viewCurrency,
  rates,
}: {
  amount: number;
  currency: string;
  viewCurrency: string;
  rates: FxRates;
}): number | null {
  if (currency === viewCurrency) return amount;
  const rate = rates[currency];
  return rate === undefined || !(rate > 0) ? null : amount * rate;
}

// ---------- parsing ----------

const SYMBOLS: readonly (readonly [string, string])[] = [
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["S$", "SGD"],
  ["US$", "USD"],
  ["$", "USD"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["₱", "PHP"],
  ["¥", "JPY"],
  ["₹", "INR"],
];

const PAY_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "PHP",
  "CAD",
  "AUD",
  "SGD",
  "NZD",
  "JPY",
  "INR",
  "CHF",
  "HKD",
  "MYR",
  "IDR",
  "THB",
  "VND",
  "KRW",
  "CNY",
  "AED",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "MXN",
  "BRL",
] as const;

const SYMBOL_RE = SYMBOLS.map(([s]) => s.replace(/\$/g, "\\$")).join("|");
const CODE_RE = PAY_CURRENCIES.join("|");
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const ONE = String.raw`(?:(?<sym>${SYMBOL_RE})\s?|(?<code>${CODE_RE})\s?)?(?<amt>${AMOUNT})\s?(?<k>[kK]\b)?`;
const TWO = String.raw`(?:\s*(?:-|–|—|to)\s*(?:(?:${SYMBOL_RE})\s?|(?:${CODE_RE})\s?)?(?<amt2>${AMOUNT})\s?(?<k2>[kK]\b)?)?`;
const TRAILING_CODE = String.raw`(?:\s?(?<code2>${CODE_RE})\b)?`;
const PERIOD = String.raw`(?:\s*(?:\/|per|a|an|each)?\s*(?<period>(?:hours?|hrs?|hourly|days?|daily|weeks?|wk|weekly|months?|mo|monthly|years?|yr|annually|annual|annum|pa)\b|p\.a\.))?`;

const PAY_RE = new RegExp(`${ONE}${TWO}${TRAILING_CODE}${PERIOD}`, "g");

function periodOf(word: string | undefined): PayPeriod | null {
  if (word === undefined) return null;
  const w = word.toLowerCase().replace(/\./g, "");
  if (/^(hours?|hrs?|hourly)$/.test(w)) return "hour";
  if (/^(days?|daily)$/.test(w)) return "day";
  if (/^(weeks?|wk|weekly)$/.test(w)) return "week";
  if (/^(months?|mo|monthly)$/.test(w)) return "month";
  return "year";
}

function amountOf(digits: string, k: string | undefined): number {
  const n = Number(digits.replace(/,/g, ""));
  return k ? n * 1000 : n;
}

/**
 * The first pay figure or range in `text` that names a currency, with the words it was posted
 * in: "$60k–$80k/yr", "USD 5,000 per month", "₱80,000 - 100,000 monthly", "35 EUR/hour". A number
 * with no currency is not pay.
 */
export function parsePay(text: string): Pay | null {
  for (const m of text.matchAll(PAY_RE)) {
    const g = m.groups ?? {};
    const symbol = g.sym === undefined ? undefined : SYMBOLS.find(([s]) => s === g.sym)?.[1];
    const currency = symbol ?? g.code ?? g.code2;
    if (currency === undefined || g.amt === undefined) continue;
    // "10 years" or "2 weeks" is not pay; a currency must sit on the figure.
    const k2 = g.k2 ?? undefined;
    const kFirst = g.k ?? (g.amt2 !== undefined ? k2 : undefined);
    const min = amountOf(g.amt, kFirst);
    const max = g.amt2 === undefined ? null : amountOf(g.amt2, k2 ?? kFirst);
    if (!(min > 0) || (max !== null && max < min)) continue;
    return { min, max, currency, period: periodOf(g.period), phrase: m[0].trim() };
  }
  return null;
}

// ---------- display ----------

const PERIOD_WORDS: Readonly<Record<PayPeriod, string>> = {
  hour: "an hour",
  day: "a day",
  week: "a week",
  month: "a month",
  year: "a year",
};

/** "₱289,000", or "₱289K" when compact (three significant digits, for tight spots like a Board card). */
function money({ amount, currency, compact = false }: { amount: number; currency: string; compact?: boolean }): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    ...(compact
      ? { notation: "compact", maximumSignificantDigits: 3 }
      : { maximumFractionDigits: amount < 100 ? 2 : 0, minimumFractionDigits: 0 }),
  }).format(amount);
}

/** "₱289,000–₱385,333" or "₱289,000"; "₱289K–₱385K" when compact. */
function range({
  min,
  max,
  currency,
  compact = false,
}: {
  min: number;
  max: number | null;
  currency: string;
  compact?: boolean;
}): string {
  const low = money({ amount: min, currency, compact });
  return max === null || max === min ? low : `${low}–${money({ amount: max, currency, compact })}`;
}

/** Pay from the `jobs` pay columns, or null when the posting stated none. */
export function payFromColumns(row: {
  payMin: string | null;
  payMax: string | null;
  payCurrency: string | null;
  payPeriod: PayPeriod | null;
}): Omit<Pay, "phrase"> | null {
  if (row.payMin === null || row.payCurrency === null) return null;
  return {
    min: Number(row.payMin),
    max: row.payMax === null ? null : Number(row.payMax),
    currency: row.payCurrency,
    period: row.payPeriod,
  };
}

/** The posted pay in plain words, for pay that came as data rather than text. */
export function payPhrase(pay: Omit<Pay, "phrase">): string {
  const period = pay.period === null ? "" : ` ${PERIOD_WORDS[pay.period]}`;
  return `${range(pay)}${period}`;
}

/**
 * Pay converted to a monthly figure in the view currency (decision 20), or null when the job
 * shows as posted: no period stated, or no rate set for its currency.
 */
export function monthlyInView({
  pay,
  viewCurrency,
  rates,
  compact = false,
}: {
  pay: Omit<Pay, "phrase">;
  viewCurrency: string;
  rates: FxRates;
  /** "₱289K–₱385K a month" instead of "₱289,000–₱385,333 a month". */
  compact?: boolean;
}): string | null {
  const { period } = pay;
  if (period === null) return null;
  const toView = (amount: number) =>
    convert({ amount: toMonthly({ amount, period }), currency: pay.currency, viewCurrency, rates });
  const min = toView(pay.min);
  if (min === null) return null;
  const max = pay.max === null ? null : toView(pay.max);
  const rounded = { min: Math.round(min), max: max === null ? null : Math.round(max) };
  return `${range({ ...rounded, currency: viewCurrency, compact })} a month`;
}
