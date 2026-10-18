import "../zod-setup";
import { RuntimeMessage } from "@shared/extension";
import { blockedSite } from "@shared/hosts";
import { detect } from "../adapters";
import { ImportContentReply, ImportContentRequest } from "../messages-import";
import { attachFile, type CurrentScan } from "./files";
import { fillFields } from "./fill";
import { readJobReply } from "./import";
import { type Measure, measureInPage, scanDocument } from "./scan";
import { formShown, successProbeReply } from "./success";

// Content script entry. The worker injects it with chrome.scripting.executeScript into the active
// tab's top frame (isolated world) after a user gesture: activeTab or a granted optional origin.
// Built as one classic script (IIFE), so it must not rely on module chunks.
//
// Rules: never read chrome.storage, never listen to window.postMessage, talk to the worker over
// chrome.runtime only. The field id → element map lives in this closure and nowhere else.

const MAX_URL = 2000;

function pageUrl(location: Location): string {
  return location.href.length <= MAX_URL ? location.href : (location.origin + location.pathname).slice(0, MAX_URL);
}

type Incoming =
  | { kind: "runtime"; message: RuntimeMessage }
  | { kind: "import"; message: ImportContentRequest }
  | { kind: "none" };

/** The two worker → page schemas. Their kinds do not overlap, so trying both is unambiguous. */
function parseIncoming(raw: unknown): Incoming {
  const runtime = RuntimeMessage.safeParse(raw);
  if (runtime.success) return { kind: "runtime", message: runtime.data };
  const asked = ImportContentRequest.safeParse(raw);
  return asked.success ? { kind: "import", message: asked.data } : { kind: "none" };
}

export type ContentReply = RuntimeMessage | ImportContentReply;

/**
 * Handles one message from the worker and returns the reply, or null for no reply. Answers
 * `scan`, `fill`, `attach`, `read_job` and `success_probe`; every reply is parsed against its
 * schema before it leaves. On a blocked host nothing is read, scanned or written.
 *
 * `formSeen`: this page showed an application form the user worked with, so a form that later goes
 * away reads as `form_gone`. Set when a scan found fields, a fill wrote one, or an attach went in,
 * and only while `formShown` agrees an application form is on screen: a lone search box never
 * counts. Never cleared on this document (a single-page app may swap the form for a thank-you view
 * and be scanned again).
 */
export function createContentHandler({ document, measure }: { document: Document; measure: Measure }) {
  let current: CurrentScan | null = null;
  let formSeen = false;
  const noteForm = () => {
    if (formShown(document, measure)) formSeen = true;
  };

  function runtimeReply(message: RuntimeMessage, location: Location): RuntimeMessage | null {
    switch (message.kind) {
      case "scan": {
        const adapter = detect(location.hostname, document);
        const scanned = scanDocument({ document, measure, adapter });
        current = { nonce: message.nonce, fields: new Map(scanned.map((f) => [f.descriptor.fieldId, f])) };
        if (scanned.length > 0) noteForm();
        return {
          kind: "scan_result",
          nonce: message.nonce,
          url: pageUrl(location),
          adapter: adapter?.id ?? "generic",
          fields: scanned.map((f) => f.descriptor),
        };
      }
      case "fill": {
        // A plan for another (or no) scan: write nothing, and say every entry is stale.
        if (current?.nonce !== message.nonce) {
          const skipped = message.entries.map((e) => ({ fieldId: e.fieldId, reason: "stale" as const }));
          return { kind: "fill_result", nonce: message.nonce, filled: [], skipped };
        }
        const outcome = fillFields({ fields: current.fields, entries: message.entries, measure });
        if (outcome.filled.length > 0) noteForm();
        return { kind: "fill_result", nonce: message.nonce, ...outcome };
      }
      case "attach": {
        const reply = attachFile({ current, message, measure });
        if (reply.result.kind === "attached") noteForm();
        return reply;
      }
      case "scan_result":
      case "fill_result":
      case "attach_result":
        // Replies travel the other way; a page-side copy of one is not answered.
        return null;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  function importReply(message: ImportContentRequest): ImportContentReply | null {
    switch (message.kind) {
      case "read_job":
        return readJobReply({ document, nonce: message.nonce, measure });
      case "success_probe":
        return successProbeReply({ document, nonce: message.nonce, formSeen, measure });
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  return (raw: unknown): ContentReply | null => {
    const incoming = parseIncoming(raw);
    const location = document.location;
    if (incoming.kind === "none" || location === null || blockedSite(location.href) !== null) return null;
    switch (incoming.kind) {
      case "runtime": {
        const reply = runtimeReply(incoming.message, location);
        const checked = RuntimeMessage.safeParse(reply);
        return reply !== null && checked.success ? checked.data : null;
      }
      case "import": {
        const reply = importReply(incoming.message);
        const checked = ImportContentReply.safeParse(reply);
        return reply !== null && checked.success ? checked.data : null;
      }
      default: {
        const exhaustive: never = incoming;
        return exhaustive;
      }
    }
  };
}

declare global {
  /** Set in the isolated world (the page cannot see it) once the listener is installed. */
  var hanapbuhayContentInstalled: true | undefined;
}

/** Runs once per page even when injected again: the isolated world keeps the first listener. */
function install(): void {
  if (window.top !== window || globalThis.hanapbuhayContentInstalled === true) return;
  globalThis.hanapbuhayContentInstalled = true;
  const handle = createContentHandler({ document, measure: measureInPage });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only the worker (or our panel) via chrome.tabs.sendMessage: same extension, not from a tab.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
    const reply = handle(message);
    if (reply !== null) sendResponse(reply);
    return false;
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.id !== undefined && typeof window !== "undefined") install();
