import {
  type AttachRejectReason,
  DiagnosticEntry,
  type DiagnosticErrorCode,
  DiagnosticOrigin,
  DiagnosticOutcome,
  MAX_DIAGNOSTIC_ENTRIES,
  RuntimeMessage,
} from "@shared/extension";
import type { FailureCode } from "../api/client";
import { type PanelRefusal, type PanelReply, PanelRequest, type Routed } from "../messages";
import type { KeyValueArea } from "./storage";

// Local diagnostics (docs/plans/chrome-extension.md, "Diagnostics"): a ring buffer of the last 50
// `DiagnosticEntry` records in chrome.storage.session, so it is gone when the browser closes. The
// worker records one entry after each panel request and each message it refuses to hear. Entries
// are metadata only: request kind, outcome code, adapter, counts and an origin with no path.
// Never values, labels, page text, full URLs, tokens or pairing codes. `record` parses every entry
// with the strict schema, so an extra key throws instead of being stored.

// Every reason the worker can give must be a diagnostic outcome. These fail to compile otherwise.
const _everyPanelRefusal: PanelRefusal extends DiagnosticErrorCode ? true : never = true;
const _everyFailureCode: FailureCode extends DiagnosticErrorCode ? true : never = true;
const _everyRejection: Extract<Routed, { kind: "rejected" }>["reason"] extends DiagnosticErrorCode ? true : never =
  true;
const _everyAttachRejection: AttachRejectReason extends DiagnosticErrorCode ? true : never = true;
void [_everyPanelRefusal, _everyFailureCode, _everyRejection, _everyAttachRejection];

const STORAGE_KEY = "diagnostics";

/** Panel requests about the log itself. Recording them would only fill the log with its own reads. */
const UNRECORDED: ReadonlySet<PanelRequest["kind"]> = new Set(["diagnostics_list", "diagnostics_clear"]);

export function isRecorded(request: PanelRequest): boolean {
  return !UNRECORDED.has(request.kind);
}

/** Scheme, host and port of an https or loopback URL; null for anything else or anything unparsable. */
export function originOf(url: string | null): DiagnosticOrigin | null {
  if (url === null) return null;
  const origin = URL.parse(url)?.origin;
  if (origin === undefined) return null;
  const parsed = DiagnosticOrigin.safeParse(origin);
  return parsed.success ? parsed.data : null;
}

export type DiagnosticsLog = {
  list(): Promise<DiagnosticEntry[]>;
  /** Parses the entry first: a key outside the schema throws and nothing is written. */
  record(entry: DiagnosticEntry): Promise<void>;
  clear(): Promise<void>;
};

/**
 * The ring buffer over one storage area (`chrome.storage.session` in the worker). The worker
 * handles messages concurrently, so reads and writes run one at a time: two requests finishing
 * together both land.
 */
export function createDiagnosticsLog({ area }: { area: KeyValueArea }): DiagnosticsLog {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(): Promise<DiagnosticEntry[]> {
    const raw = (await area.get([STORAGE_KEY]))[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    // An entry that does not parse (an older shape, a corrupted write) is dropped, not shown.
    const entries = raw.flatMap((item: unknown) => {
      const parsed = DiagnosticEntry.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return entries.slice(-MAX_DIAGNOSTIC_ENTRIES);
  }

  return {
    list: () => serial(read),
    record: (entry) =>
      serial(async () => {
        const parsed = DiagnosticEntry.parse(entry);
        await area.set({ [STORAGE_KEY]: [...(await read()), parsed].slice(-MAX_DIAGNOSTIC_ENTRIES) });
      }),
    clear: () => serial(() => area.remove([STORAGE_KEY])),
  };
}

type Counts = NonNullable<DiagnosticEntry["counts"]>;

function counts(partial: Partial<Counts>): Counts {
  return { fields: 0, matched: 0, filled: 0, skipped: 0, unresolved: 0, ...partial };
}

/** The outcome code of a reply: "ok", or why it did not succeed. Never the reply's message text. */
export function outcomeOf({ request, reply }: { request: PanelRequest; reply: PanelReply }): DiagnosticOutcome {
  const result = reply.result;
  if (result !== undefined) {
    switch (result.kind) {
      case "refused":
        return result.reason;
      case "failed": {
        const parsed = DiagnosticOutcome.safeParse(result.code);
        return parsed.success && parsed.data !== "ok" ? parsed.data : "internal";
      }
      case "claim_mismatch":
        return "url_mismatch";
      case "attach_rejected":
        return result.reason;
      case "attach_download_failed":
        return "download_failed";
      case "session_active":
      case "claimed":
      case "scanned":
      case "prefilled":
      case "filled":
      case "origins":
      case "preference":
      case "outputs":
      case "output":
      case "task":
      case "attach_done":
      case "attach_downloaded":
      case "job_extracted":
      case "job_lookup":
      case "job_imported":
      case "success_checked":
      case "applied":
      case "diagnostics":
        return "ok";
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  const { status } = reply;
  switch (status.kind) {
    case "paired":
      return "ok";
    case "unpaired":
      if (status.notice === "revoked") return "unauthorized";
      if (reply.error !== null) return request.kind === "pair" ? "pair_failed" : "unpaired";
      return request.kind === "disconnect" ? "ok" : "unpaired";
    case "unreachable":
      return "network";
    case "error":
      return "internal";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Field counts for the requests that have them; null for the rest. */
function countsOf({ request, reply }: { request: PanelRequest; reply: PanelReply }): Counts | null {
  const result = reply.result;
  if (result?.kind === "scanned") return counts({ fields: result.fields.length });
  if (result?.kind === "prefilled" && request.kind === "prefill") {
    return counts({
      fields: request.fields.length,
      matched: result.response.matches.length,
      unresolved: result.response.unresolved.length,
    });
  }
  if (result?.kind === "filled" && request.kind === "fill") {
    return counts({
      fields: request.plan.entries.length,
      filled: result.result.filled.length,
      skipped: result.result.skipped.length,
    });
  }
  return null;
}

/** The tab a request acts on, if any. */
function tabIdOf(request: PanelRequest): number | null {
  switch (request.kind) {
    case "scan":
    case "fill":
    case "attach":
    case "job_extract":
    case "success_check":
      return request.tabId;
    default:
      return null;
  }
}

/** The URL whose origin the entry records, without looking up a tab. */
function urlOf(request: PanelRequest): string | null {
  switch (request.kind) {
    case "pair":
      return request.endpoint;
    case "session_claim":
      return request.tabUrl;
    case "revoke_origin":
      return request.origin;
    case "job_lookup":
      return request.url;
    case "job_import":
      return request.edits.applyUrl;
    default:
      return null;
  }
}

/**
 * The entry for one handled panel request. `getTab` reads the tab's current address for requests
 * that act on a tab; only its origin is kept.
 */
export async function requestEntry({
  request,
  reply,
  ts,
  getTab,
}: {
  request: PanelRequest;
  reply: PanelReply;
  ts: number;
  getTab: (tabId: number) => Promise<{ url: string | null } | null>;
}): Promise<DiagnosticEntry> {
  const tabId = tabIdOf(request);
  const url = tabId === null ? urlOf(request) : ((await getTab(tabId).catch(() => null))?.url ?? null);
  const result = reply.result;
  return {
    ts,
    kind: "request",
    request: request.kind,
    origin: originOf(url),
    adapter: result?.kind === "scanned" ? result.adapter : null,
    counts: countsOf({ request, reply }),
    outcome: outcomeOf({ request, reply }),
  };
}

/** Every message kind the worker knows. A refused message is recorded by kind only when it is one. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  ...PanelRequest.options.map((option) => option.shape.kind.value),
  ...RuntimeMessage.options.map((option) => option.shape.kind.value),
]);

function messageKind(message: unknown): string {
  if (typeof message !== "object" || message === null || !("kind" in message)) return "unknown";
  const { kind } = message;
  return typeof kind === "string" && KNOWN_KINDS.has(kind) ? kind : "unknown";
}

/**
 * The entry for a message `routeMessage` rejected. The kind is kept only when it names a known
 * message, so a sender cannot write its own text into the log.
 */
export function refusalEntry({
  message,
  senderUrl,
  reason,
  ts,
}: {
  message: unknown;
  senderUrl: string | undefined;
  reason: Extract<Routed, { kind: "rejected" }>["reason"];
  ts: number;
}): DiagnosticEntry {
  return {
    ts,
    kind: "refusal",
    request: messageKind(message),
    origin: originOf(senderUrl ?? null),
    adapter: null,
    counts: null,
    outcome: reason,
  };
}
