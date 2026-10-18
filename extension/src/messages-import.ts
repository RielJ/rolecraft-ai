import { AddJobResult } from "@shared/api";
import { ApplicationSessionId, ConfirmAppliedResult, LookupResult, ScanNonce, SuccessReason } from "@shared/extension";
import { z } from "zod";
import type { TabRefusal } from "./background/content";
import type { ConnectionStatus } from "./messages";

// Import-this-page and success-detection messages (docs/plans/chrome-extension.md, Task 14).
// messages.ts spreads `IMPORT_PANEL_REQUESTS` into `PanelRequest` and `IMPORT_PANEL_RESULTS` into
// `PanelResult`; content/index.ts answers the `ImportContentRequest` kinds. This module must not
// import messages.ts at runtime (only types): messages.ts imports it, and a runtime cycle would
// leave one of the two schemas undefined at load.

// ---------- Limits ----------

/** Caps on what the page extract may carry. Title and company match `PasteJobInput`. */
export const IMPORT_LIMITS = {
  title: 300,
  company: 300,
  location: 200,
  description: 20_000,
  url: 2000,
} as const;

const HttpUrl = z.url({ protocol: /^https?$/ }).max(IMPORT_LIMITS.url);
const TabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ---------- Page extract ----------

/** Where the title came from: a JobPosting JSON-LD block the visible page agrees with, or the page itself. */
export const EXTRACT_SOURCES = ["json_ld", "page"] as const;
export const ExtractSource = z.enum(EXTRACT_SOURCES);
export type ExtractSource = z.infer<typeof ExtractSource>;

/** What the content script read from the visible page. Any field can be empty; the user edits it. */
export const ImportDraft = z.strictObject({
  pageUrl: HttpUrl,
  applyUrl: HttpUrl,
  title: z.string().max(IMPORT_LIMITS.title),
  company: z.string().max(IMPORT_LIMITS.company),
  location: z.string().max(IMPORT_LIMITS.location),
  description: z.string().max(IMPORT_LIMITS.description),
  source: ExtractSource,
});
export type ImportDraft = z.infer<typeof ImportDraft>;

/**
 * The preview after the user edited it. Title, company and description are required, as in the
 * web app's paste form. The worker folds `location` into the description (`ImportJobInput` has no
 * location field) before it posts.
 */
export const ImportEdits = z.strictObject({
  applyUrl: HttpUrl,
  title: z.string().trim().min(1).max(IMPORT_LIMITS.title),
  company: z.string().trim().min(1).max(IMPORT_LIMITS.company),
  location: z.string().trim().max(IMPORT_LIMITS.location),
  description: z.string().trim().min(1).max(IMPORT_LIMITS.description),
});
export type ImportEdits = z.infer<typeof ImportEdits>;

// ---------- Panel <-> worker ----------

/**
 * New `PanelRequest` kinds. Strict, like the rest of `PanelRequest`.
 * - `job_extract`: read the visible page in `tabId`. Sent only from the "Read this page" click.
 * - `job_lookup`: is this URL already a saved job? Read-only on the server.
 * - `job_import`: save the edited preview. Sent only from the Import click.
 * - `success_check`: ask the bound tab for a success signal. Never calls the server.
 * - `confirm_applied`: mark the bound session's job applied. Sent only from the "Yes" click.
 */
export const IMPORT_PANEL_REQUESTS = [
  z.strictObject({ kind: z.literal("job_extract"), tabId: TabId }),
  z.strictObject({ kind: z.literal("job_lookup"), url: HttpUrl }),
  z.strictObject({ kind: z.literal("job_import"), edits: ImportEdits }),
  z.strictObject({ kind: z.literal("success_check"), sessionId: ApplicationSessionId, tabId: TabId }),
  z.strictObject({
    kind: z.literal("confirm_applied"),
    sessionId: ApplicationSessionId,
    reason: SuccessReason.nullable(),
  }),
] as const;
export const ImportPanelRequest = z.discriminatedUnion("kind", IMPORT_PANEL_REQUESTS);
export type ImportPanelRequest = z.infer<typeof ImportPanelRequest>;

/** New `PanelResult` kinds, one per request above. */
export const IMPORT_PANEL_RESULTS = [
  z.object({ kind: z.literal("job_extracted"), draft: ImportDraft }),
  z.object({ kind: z.literal("job_lookup"), lookup: LookupResult }),
  z.object({ kind: z.literal("job_imported"), result: AddJobResult }),
  /** `null`: no signal on the page. A reason code only; never page text. */
  z.object({ kind: z.literal("success_checked"), reason: SuccessReason.nullable() }),
  z.object({ kind: z.literal("applied"), result: ConfirmAppliedResult }),
] as const;

/** The tab refusals the import handler can give. All are in `PANEL_REFUSALS`. */
export const IMPORT_REFUSALS = [
  "not_active",
  "unsupported_url",
  "blocked_host",
  "permission_denied",
  "not_bound",
  "bad_reply",
] as const satisfies readonly TabRefusal[];
export const ImportRefusal = z.enum(IMPORT_REFUSALS);
export type ImportRefusal = z.infer<typeof ImportRefusal>;

/**
 * Every result `handleImport` gives: the new kinds plus the `refused` and `failed` shapes
 * `PanelResult` already has. The import and applied panels parse replies with it (`asImportReply`).
 */
export const ImportResult = z.discriminatedUnion("kind", [
  ...IMPORT_PANEL_RESULTS,
  z.object({ kind: z.literal("refused"), reason: ImportRefusal }),
  z.object({ kind: z.literal("failed"), code: z.string().max(60), message: z.string().max(500) }),
]);
export type ImportResult = z.infer<typeof ImportResult>;

/** `PanelReply` narrowed to import results. */
export type ImportReply = { status: ConnectionStatus; error: string | null; result?: ImportResult };

const BAD_RESULT: ImportResult = {
  kind: "failed",
  code: "bad_response",
  message: "The extension's background worker answered with something unexpected. Reload the extension.",
};

/** Narrow a worker reply for the import and applied panels. A result of another kind reads as a failure. */
export function asImportReply(reply: {
  status: ConnectionStatus;
  error: string | null;
  result?: unknown;
}): ImportReply {
  if (reply.result === undefined) return { status: reply.status, error: reply.error };
  const parsed = ImportResult.safeParse(reply.result);
  return { status: reply.status, error: reply.error, result: parsed.success ? parsed.data : BAD_RESULT };
}

// ---------- Worker <-> content script ----------

/**
 * Worker to content script, over `chrome.tabs.sendMessage` to frame 0. Kinds do not overlap
 * `RuntimeMessage`, so content/index.ts can try both schemas.
 */
export const ImportContentRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read_job"), nonce: ScanNonce }),
  z.strictObject({ kind: z.literal("success_probe"), nonce: ScanNonce }),
]);
export type ImportContentRequest = z.infer<typeof ImportContentRequest>;

/** Content script replies. A success probe answers with a reason code, never page text. */
export const ImportContentReply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read_job_result"), nonce: ScanNonce, draft: ImportDraft }),
  z.strictObject({ kind: z.literal("success_probe_result"), nonce: ScanNonce, reason: SuccessReason.nullable() }),
]);
export type ImportContentReply = z.infer<typeof ImportContentReply>;
