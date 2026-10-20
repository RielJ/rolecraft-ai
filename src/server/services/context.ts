import type { ErrorCode, UserId } from "@/shared/api";
import type { AiClients, AiSource } from "../adapters/ai/types";
import type { FxSource } from "../adapters/fx";
import type { GithubReader } from "../adapters/github";
import type { GitlabReader } from "../adapters/gitlab";
import type { HttpClient } from "../adapters/http";
import type { KeyStore } from "../adapters/key-store";
import type { FolderReader, ProjectsReader } from "../adapters/local-projects";
import type { PdfRenderer } from "../adapters/pdf";
import type { SourceAdapters } from "../adapters/sources";
import type { Cloner } from "../adapters/temp-clone";
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
  /** Reads GitHub links on add-ons: public REST, `gh api` (HB_GITHUB=gh) or fixture snapshots. */
  github: GithubReader;
  /** The local projects folder (HB_PROJECTS_DIR), or null when unset (decision 78). */
  projects: ProjectsReader | null;
  /** Reads one folder by path, to fill the add-on form (decision 80). */
  folders: FolderReader;
  /**
   * Temp clones of public GitHub repos, for their hunks when there is no local clone and no gh
   * (decision 81). Null leaves those reads to the API, as tests do.
   */
  cloner: Cloner | null;
  /** Reads one public GitLab project, to fill the add-on form (decision 80). */
  gitlab: GitlabReader;
  /** Exchange-rate sources (decision 67): live, fixture files (HB_FX=fixture), or offline in tests. */
  fx: FxSource;
  clock: Clock;
};

type Status = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

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
  github_rate_limited: 429,
  github_account: 409,
  github_unavailable: 503,
  unauthorized: 401,
  forbidden_origin: 403,
  url_mismatch: 409,
  session_expired: 409,
  output_changed: 409,
  not_in_facts: 409,
  too_many_skills: 409,
  rates_unavailable: 503,
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
