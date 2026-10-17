import type { ErrorCode, UserId } from "@/shared/api";
import type { AiClients, AiSource } from "../adapters/ai/types";
import type { HttpClient } from "../adapters/http";
import type { KeyStore } from "../adapters/key-store";
import type { PdfRenderer } from "../adapters/pdf";
import type { SourceAdapters } from "../adapters/sources";
import type { Db } from "../db/client";

export type Clock = { now(): Date };

/** Built once in main.ts (or a test) and passed to every service call. */
export type Deps = {
  db: Db;
  /** v1 is single-user (decision 28); the id is resolved at boot. */
  userId: UserId;
  pdf: PdfRenderer;
  ai: AiClients;
  /** Saved API key (default) or the local pi runner (decision 48). */
  aiSource: AiSource;
  keyStore: KeyStore;
  /** The polite fetch queue (adapters/http.ts); tests inject one that never reaches the network. */
  http: HttpClient;
  /** Job sources by kind, built on `http` (or on fixture files with `HB_SOURCES=fixture`). */
  sources: SourceAdapters;
  clock: Clock;
};

type Status = 400 | 402 | 404 | 409 | 422 | 500 | 503;

const STATUS: Record<ErrorCode, Status> = {
  invalid_input: 400,
  not_found: 404,
  needs_input: 409,
  frozen: 409,
  not_exportable: 400,
  must_answer: 409,
  over_cap: 402,
  no_ai_key: 409,
  key_rejected: 400,
  ai_unavailable: 503,
  refresh_running: 409,
  source_exists: 409,
  on_board: 409,
  has_work: 409,
  both_on_board: 409,
  unreadable_file: 422,
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
  get status(): Status {
    return STATUS[this.code];
  }
}

export function notFound(what: string): AppError {
  return new AppError({ code: "not_found", message: `${what} was not found. It may have been deleted.` });
}
