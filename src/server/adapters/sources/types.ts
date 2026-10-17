import type { z } from "zod";
import { type Pay, payPhrase } from "@/domain/pay";
import type { PayPeriod, SourceKind } from "@/shared/enums";
import { type HttpClient, HttpError } from "../http";

/** One posting as a source gives it, before normalization (section 3.1 step 3). */
export type Posting = {
  /** The board's own id for the posting; with the source it is the listing's key. */
  externalId: string;
  title: string;
  company: string;
  /** Plain text. Adapters convert HTML with `htmlToText`. */
  description: string;
  locationText: string;
  applyUrl: string | null;
  /** Attribution link back to the board. */
  listingUrl: string;
  postedAt: Date | null;
  expiresAt: Date | null;
  /** Pay the board gives as data; otherwise it is read from the description. */
  pay: Pay | null;
  /** Location restrictions the board states as data (section 3.6 rule 7), or null. */
  restrictions: readonly string[] | null;
  /** Departments, categories or tags, for the keyword and role filters. */
  tags: readonly string[];
};

/**
 * `complete`: the whole board came back, so a missing posting is closed. `unread`: external ids
 * the board lists whose content was not read this run (a detail budget); they are not missing.
 */
export type FetchResult = { complete: boolean; postings: Posting[]; unread: string[] };

/** What sync asks a source for. `known` holds the external ids this source already has listings for. */
export type FetchInput = { board: string | null; keywords: readonly string[]; known: ReadonlySet<string> };

export type SourceErrorKind = "failed" | "rate_limited" | "parse";

/** A source run that cannot be used. Sync records it on the source and closes nothing. */
export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  constructor({ kind, message }: { kind: SourceErrorKind; message: string }) {
    super(message);
    this.name = "SourceError";
    this.kind = kind;
  }
}

export type SourceAdapter = {
  kind: SourceKind;
  /** Shown in the UI and in task steps. */
  name: string;
  /** Whether a fetch returns the whole board (ATS) or a window of recent results (built-ins). */
  complete: boolean;
  /** A source run within this many minutes of the last one is skipped. */
  minIntervalMinutes: number;
  fetch(input: FetchInput): Promise<FetchResult>;
  /** Company boards only: read a careers link and check the board exists before it is saved. */
  board?: {
    /** The board slug in a careers link, or null when the link is not this ATS. */
    fromUrl(url: string): string | null;
    /** The company's name for the label. Throws `SourceError` when the board does not exist. */
    check(board: string): Promise<{ label: string }>;
  };
};

export type SourceAdapters = Partial<Record<SourceKind, SourceAdapter>>;

/** A failed request as a source error: 429 is `rate_limited`, everything else `failed`. */
export function sourceErrorFrom(error: unknown, name: string): SourceError {
  if (error instanceof SourceError) return error;
  if (error instanceof HttpError) {
    if (error.status === 429) {
      return new SourceError({ kind: "rate_limited", message: `${name} asked us to slow down (429). Try later.` });
    }
    return new SourceError({ kind: "failed", message: `${name}: ${error.message}` });
  }
  return new SourceError({ kind: "failed", message: `${name} could not be read.` });
}

/** Parse a JSON body against its schema, or throw a `parse` error that names the source. */
export function readJson<T>({ body, schema, name }: { body: string; schema: z.ZodType<T>; name: string }): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new SourceError({ kind: "parse", message: `${name} answered with something that is not JSON.` });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new SourceError({ kind: "parse", message: `${name} answered in a format we do not read.` });
  return parsed.data;
}

/** A date string, or null when missing or unreadable. */
export function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** GET a source's body as text; a failed request becomes a `SourceError` naming the source. */
export async function getBody({
  http,
  url,
  name,
  accept = "application/json",
}: {
  http: HttpClient;
  url: string;
  name: string;
  accept?: string;
}): Promise<string> {
  try {
    return (await http.getText(url, { accept })).body;
  } catch (error) {
    throw sourceErrorFrom(error, name);
  }
}

/**
 * Check a company board by reading `url`: 404 means the board does not exist, and the error says
 * what to do. Any other failure is the source's usual error. Returns the body.
 */
export async function checkBoard({
  http,
  url,
  name,
  board,
}: {
  http: HttpClient;
  url: string;
  name: string;
  board: string;
}): Promise<string> {
  try {
    return (await http.getText(url, { accept: "application/json" })).body;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw boardMissing({ name, board });
    throw sourceErrorFrom(error, name);
  }
}

export function boardMissing({ name, board }: { name: string; board: string }): SourceError {
  return new SourceError({
    kind: "failed",
    message: `${name} said the board "${board}" does not exist. Check the link, or open the company's careers page and copy the link of its job list.`,
  });
}

/** A positive amount from a number or a numeric string ("60,000"), else null. */
export function amountOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pay a board gives as data, or null when the minimum or the currency is missing. */
export function structuredPay({
  min,
  max,
  currency,
  period,
}: {
  min: string | number | null | undefined;
  max: string | number | null | undefined;
  currency: string | null | undefined;
  period: PayPeriod | null;
}): Pay | null {
  const lo = amountOf(min);
  const hi = amountOf(max);
  const code = currency?.trim().toUpperCase();
  if (lo === null || !code || !/^[A-Z]{3}$/.test(code)) return null;
  const top = hi !== null && hi >= lo ? hi : null;
  return {
    min: lo,
    max: top,
    currency: code,
    period,
    phrase: payPhrase({ min: lo, max: top, currency: code, period }),
  };
}

/** "acme-labs" as "Acme Labs", for boards whose API does not name the company. */
export function labelFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A board slug as boards use them: letters, digits, `-` and `_`. */
export const BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

/** The first path segment of `raw` when its host is one of `hosts` and it looks like a slug. */
export function slugFromPath({ raw, hosts }: { raw: string; hosts: ReadonlySet<string> }): string | null {
  const url = URL.parse(raw.trim());
  if (!url || !hosts.has(url.hostname.toLowerCase())) return null;
  const slug = url.pathname.split("/").filter(Boolean)[0] ?? null;
  return slug && BOARD_SLUG.test(slug) ? slug.toLowerCase() : null;
}
