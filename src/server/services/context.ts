import type { ErrorCode, UserId } from "@/shared/api";
import type { PdfRenderer } from "../adapters/pdf";
import type { Db } from "../db/client";

export type Clock = { now(): Date };

/** Built once in main.ts (or a test) and passed to every service call. */
export type Deps = {
  db: Db;
  /** v1 is single-user (decision 28); the id is resolved at boot. */
  userId: UserId;
  pdf: PdfRenderer;
  clock: Clock;
};

const STATUS: Record<ErrorCode, 400 | 404 | 409 | 500> = {
  invalid_input: 400,
  not_found: 404,
  needs_input: 409,
  frozen: 409,
  not_exportable: 400,
  internal: 500,
};

/** A failure the HTTP layer maps to `{ error: { code, message, details? } }`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor({ code, message, details }: { code: ErrorCode; message: string; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
  get status(): 400 | 404 | 409 | 500 {
    return STATUS[this.code];
  }
}

export function notFound(what: string): AppError {
  return new AppError({ code: "not_found", message: `${what} was not found. It may have been deleted.` });
}
