import type { z } from "zod";
import type { Pay } from "@/domain/pay";
import type { SourceKind } from "@/shared/enums";
import { HttpError } from "../http";

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

/** `complete`: the whole board came back, so a missing posting is closed. */
export type FetchResult = { complete: boolean; postings: Posting[] };

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
  fetch(input: { board: string | null; keywords: readonly string[] }): Promise<FetchResult>;
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
