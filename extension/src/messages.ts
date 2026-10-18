import { MarkReviewedInput, OutputId, TaskDto, TaskId } from "@shared/api";
import {
  ActiveSessionResponse,
  AdapterId,
  ApplicationSessionDto,
  ApplicationSessionId,
  DiagnosticEntry,
  ExtensionOutputDto,
  FieldDescriptor,
  FillPlan,
  FillResult,
  MAX_DIAGNOSTIC_ENTRIES,
  MAX_PREFILL_FIELDS,
  PairingId,
  PreferenceDto,
  PreferenceInput,
  PrefillResponse,
  RuntimeMessage,
  ScanNonce,
  UrlMismatchDetails,
} from "@shared/extension";
import { z } from "zod";
import type { TabRefusal } from "./background/content";
import { ATTACH_PANEL_REQUESTS, ATTACH_PANEL_RESULTS } from "./messages-attach";
import { IMPORT_PANEL_REQUESTS, IMPORT_PANEL_RESULTS } from "./messages-import";

// Panel <-> service worker messages. Content-script messages use `RuntimeMessage` from
// src/shared/extension.ts. Both travel over `chrome.runtime` only; the worker routes by sender.

const Endpoint = z.string().max(300);

/** What the panel shows. Anything but `paired` puts the pairing screen up and nothing fills. */
export const ConnectionStatus = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unpaired"),
    endpoint: Endpoint,
    /** `revoked`: the server answered 401 to a stored token. */
    notice: z.literal("revoked").nullable(),
  }),
  z.object({ kind: z.literal("paired"), endpoint: Endpoint, pairingId: PairingId }),
  z.object({ kind: z.literal("unreachable"), endpoint: Endpoint }),
  z.object({ kind: z.literal("error"), endpoint: Endpoint, message: z.string().max(500) }),
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

const TabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TabUrl = z.url({ protocol: /^https?$/ }).max(2000);
/** An approved origin as `GrantedOrigins` stores it: `https://host`. */
const ApprovedOrigin = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^/?#\s]+$/);

/**
 * What the panel asks the worker. Strict: an unknown key is a parse error. The worker checks every
 * session-scoped request against the session-to-tab binding in `chrome.storage.session`.
 */
export const PanelRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status") }),
  /** Raw input; the worker validates both. Host permission was requested by the panel first. */
  z.strictObject({ kind: z.literal("pair"), endpoint: z.string().max(300), code: z.string().max(20) }),
  z.strictObject({ kind: z.literal("disconnect") }),
  z.strictObject({ kind: z.literal("session_active") }),
  /** `tabUrl` is the address the panel showed; the worker re-reads the tab and refuses if it moved. */
  z.strictObject({
    kind: z.literal("session_claim"),
    sessionId: ApplicationSessionId,
    tabId: TabId,
    tabUrl: TabUrl,
    confirmMismatch: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("scan"), tabId: TabId }),
  z.strictObject({
    kind: z.literal("prefill"),
    sessionId: ApplicationSessionId,
    nonce: ScanNonce,
    fields: z.array(FieldDescriptor).max(MAX_PREFILL_FIELDS),
  }),
  /** Only ever sent from the Prefill click. There is no overwrite flag: non-empty fields are skipped. */
  z.strictObject({ kind: z.literal("fill"), tabId: TabId, plan: FillPlan }),
  z.strictObject({ kind: z.literal("sync_origins") }),
  z.strictObject({ kind: z.literal("revoke_origin"), origin: ApprovedOrigin }),
  /** Only ever sent from a "Save as default" or "Save for this job" click. */
  z.strictObject({ kind: z.literal("preference_save"), input: PreferenceInput }),
  z.strictObject({ kind: z.literal("outputs_list"), sessionId: ApplicationSessionId }),
  /** `body`: the answer text the panel showed. The server refuses (409 `output_changed`) if it changed since. */
  z.strictObject({
    kind: z.literal("output_reviewed"),
    sessionId: ApplicationSessionId,
    outputId: OutputId,
    body: MarkReviewedInput.shape.body,
  }),
  z.strictObject({
    kind: z.literal("draft_start"),
    sessionId: ApplicationSessionId,
    outputId: OutputId,
    confirmOverCap: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("task_poll"), taskId: TaskId }),
  /** The local diagnostics log (state/diagnostics.ts). Neither is recorded in it. */
  z.strictObject({ kind: z.literal("diagnostics_list") }),
  z.strictObject({ kind: z.literal("diagnostics_clear") }),
  /** `attach` and `attach_download`: messages-attach.ts. */
  ...ATTACH_PANEL_REQUESTS,
  /** Import this page, success check and confirm applied: messages-import.ts. */
  ...IMPORT_PANEL_REQUESTS,
]);
export type PanelRequest = z.infer<typeof PanelRequest>;

/** Why the worker would not act on a tab request. Includes every `TabRefusal` from background/content.ts. */
export const PANEL_REFUSALS = [
  "not_active",
  "unsupported_url",
  "blocked_host",
  "permission_denied",
  "not_bound",
  "bad_reply",
  /** The tab navigated between the panel reading its address and the claim. */
  "tab_changed",
] as const satisfies readonly (TabRefusal | "tab_changed")[];
export const PanelRefusal = z.enum(PANEL_REFUSALS);
export type PanelRefusal = z.infer<typeof PanelRefusal>;
// Fails to compile if content.ts gains a refusal this list lacks.
const _everyTabRefusal: TabRefusal extends PanelRefusal ? true : never = true;
void _everyTabRefusal;

/** The payload of a reply, by what happened. Absent on status, pair and disconnect. */
export const PanelResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_active"), active: ActiveSessionResponse }),
  z.object({ kind: z.literal("claimed"), session: ApplicationSessionDto }),
  z.object({ kind: z.literal("claim_mismatch"), details: UrlMismatchDetails }),
  z.object({
    kind: z.literal("scanned"),
    nonce: ScanNonce,
    adapter: AdapterId,
    fields: z.array(FieldDescriptor).max(MAX_PREFILL_FIELDS),
  }),
  z.object({ kind: z.literal("prefilled"), response: PrefillResponse }),
  z.object({ kind: z.literal("filled"), result: FillResult }),
  z.object({ kind: z.literal("origins"), origins: z.array(ApprovedOrigin).max(500) }),
  z.object({ kind: z.literal("preference"), preference: PreferenceDto }),
  z.object({ kind: z.literal("outputs"), outputs: z.array(ExtensionOutputDto).max(100) }),
  z.object({ kind: z.literal("output"), output: ExtensionOutputDto }),
  z.object({ kind: z.literal("task"), task: TaskDto }),
  /** Oldest first. Empty after `diagnostics_clear`. */
  z.object({ kind: z.literal("diagnostics"), entries: z.array(DiagnosticEntry).max(MAX_DIAGNOSTIC_ENTRIES) }),
  ...ATTACH_PANEL_RESULTS,
  ...IMPORT_PANEL_RESULTS,
  z.object({ kind: z.literal("refused"), reason: PanelRefusal }),
  /** The server answered with an app error. `code` is an `ErrorCode` or `bad_response`. */
  z.object({ kind: z.literal("failed"), code: z.string().max(60), message: z.string().max(500) }),
]);
export type PanelResult = z.infer<typeof PanelResult>;

/**
 * Every panel request answers with the connection status and, when it failed, why. `result` is
 * optional so a reply built without one (bridge.ts's "no worker" reply) still type-checks.
 */
export const PanelReply = z.object({
  status: ConnectionStatus,
  error: z.string().max(500).nullable(),
  result: PanelResult.optional(),
});
export type PanelReply = z.infer<typeof PanelReply>;

/** The parts of `chrome.runtime.MessageSender` the worker trusts. */
export type Sender = {
  id?: string | undefined;
  url?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
};

export type Routed =
  | { kind: "panel"; request: PanelRequest }
  | { kind: "content"; message: RuntimeMessage; tabId: number; url: string }
  | { kind: "rejected"; reason: "foreign_sender" | "not_top_frame" | "bad_message" };

/**
 * Classify an incoming `chrome.runtime` message. Only this extension's own contexts are heard:
 * this extension's pages (the side panel, or panel.html open in a tab) send `PanelRequest`s;
 * top-frame content scripts in a web tab send `RuntimeMessage`s. Content scripts never run in
 * `chrome-extension://` pages, so the sender URL tells the two apart. Anything else, or anything
 * that does not parse, is rejected. Origin approval, the session-to-tab binding and the scan nonce
 * are checked by the content-message handler.
 */
export function routeMessage({
  message,
  sender,
  runtimeId,
}: {
  message: unknown;
  sender: Sender;
  runtimeId: string;
}): Routed {
  if (sender.id !== runtimeId) return { kind: "rejected", reason: "foreign_sender" };

  if (sender.url?.startsWith(`chrome-extension://${runtimeId}/`)) {
    const parsed = PanelRequest.safeParse(message);
    return parsed.success ? { kind: "panel", request: parsed.data } : { kind: "rejected", reason: "bad_message" };
  }
  if (sender.tab === undefined) return { kind: "rejected", reason: "foreign_sender" };

  const tabId = sender.tab.id;
  if (sender.frameId !== 0 || tabId === undefined || sender.url === undefined) {
    return { kind: "rejected", reason: "not_top_frame" };
  }
  const parsed = RuntimeMessage.safeParse(message);
  return parsed.success
    ? { kind: "content", message: parsed.data, tabId, url: sender.url }
    : { kind: "rejected", reason: "bad_message" };
}
