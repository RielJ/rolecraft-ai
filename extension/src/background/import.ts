import { AddJobResult } from "@shared/api";
import { ConfirmAppliedResult, type ImportJobInput, LookupResult } from "@shared/extension";
import { createClient, ROUTES } from "../api/client";
import type { PanelReply } from "../messages";
import {
  ImportContentReply,
  type ImportContentRequest,
  type ImportEdits,
  type ImportPanelRequest,
} from "../messages-import";
import {
  type ContentDeps,
  checkTab,
  fromOutcome,
  localReply,
  refusedReply,
  storedStatus,
  type TabRefusal,
} from "./content";
import type { PairingDeps } from "./pairing";

// Worker side of import and success detection (docs/plans/chrome-extension.md, Task 14).
// - `job_extract` and `success_check` only read the tab; neither calls the server.
// - `job_lookup` is a read-only server call.
// - `job_import` and `confirm_applied` are the only writes. The panel sends them only from the
//   Import click and the "Yes" click; nothing here sends them on its own.
// handlePanelRequest (panel.ts) routes the five request kinds here.

export type ImportDeps = {
  pairing: PairingDeps;
  content: Pick<ContentDeps, "getTab" | "inject" | "newNonce">;
  /** chrome.tabs.sendMessage to frame 0; resolves with the raw reply. `chromeSendImport` is the real one. */
  sendContent(tabId: number, message: ImportContentRequest): Promise<unknown>;
};

type Request<K extends ImportPanelRequest["kind"]> = Extract<ImportPanelRequest, { kind: K }>;

/** Inject (idempotent) and ask the content script one question with a fresh nonce. */
async function askTab(
  deps: ImportDeps,
  tabId: number,
  kind: ImportContentRequest["kind"],
): Promise<ImportContentReply | TabRefusal> {
  const refusal = await checkTab({ deps: deps.content, tabId });
  if (refusal !== null) return refusal;
  if ((await deps.content.inject(tabId)) === "denied") return "permission_denied";
  const nonce = deps.content.newNonce();
  const raw = await deps.sendContent(tabId, { kind, nonce }).catch(() => undefined);
  const reply = ImportContentReply.safeParse(raw);
  if (!reply.success || reply.data.nonce !== nonce) return "bad_reply";
  return reply.data;
}

async function extract(deps: ImportDeps, request: Request<"job_extract">): Promise<PanelReply> {
  const status = await storedStatus(deps.pairing.store);
  if (status.kind !== "paired") return { status, error: null };
  const reply = await askTab(deps, request.tabId, "read_job");
  if (typeof reply === "string") return refusedReply(deps, reply);
  if (reply.kind !== "read_job_result") return refusedReply(deps, "bad_reply");
  return localReply(deps, { kind: "job_extracted", draft: reply.draft });
}

/** `ImportJobInput` has no location field, so a location goes on the description's first line. */
export function importInput(edits: ImportEdits): ImportJobInput {
  const location = edits.location.trim();
  const description = edits.description.trim();
  const mentioned = location === "" || description.toLowerCase().includes(location.toLowerCase());
  return {
    url: edits.applyUrl,
    title: edits.title.trim(),
    company: edits.company.trim(),
    description: mentioned ? description : `Location: ${location}\n\n${description}`,
  };
}

async function successCheck(deps: ImportDeps, request: Request<"success_check">): Promise<PanelReply> {
  const binding = await deps.pairing.store.readBinding();
  if (binding === null || binding.sessionId !== request.sessionId || binding.tabId !== request.tabId) {
    return refusedReply(deps, "not_bound");
  }
  const reply = await askTab(deps, request.tabId, "success_probe");
  if (typeof reply === "string") return refusedReply(deps, reply);
  if (reply.kind !== "success_probe_result") return refusedReply(deps, "bad_reply");
  return localReply(deps, { kind: "success_checked", reason: reply.reason });
}

async function confirmApplied(deps: ImportDeps, request: Request<"confirm_applied">): Promise<PanelReply> {
  const binding = await deps.pairing.store.readBinding();
  if (binding === null || binding.sessionId !== request.sessionId) return refusedReply(deps, "not_bound");
  const outcome = await createClient(deps.pairing).call({
    route: ROUTES.confirmApplied,
    params: { id: request.sessionId },
    body: { reason: request.reason },
    schema: ConfirmAppliedResult,
  });
  return fromOutcome({ deps, outcome, scope: "session", ok: (result) => ({ kind: "applied", result }) });
}

/**
 * Answers the five import and success requests. `routeMessage` already checked the sender is this
 * extension's own page and the request parses.
 */
export async function handleImport({
  deps,
  request,
}: {
  deps: ImportDeps;
  request: ImportPanelRequest;
}): Promise<PanelReply> {
  switch (request.kind) {
    case "job_extract":
      return extract(deps, request);
    case "job_lookup":
      return fromOutcome({
        deps,
        scope: "none",
        outcome: await createClient(deps.pairing).call({
          route: ROUTES.lookup,
          query: { url: request.url },
          schema: LookupResult,
        }),
        ok: (lookup) => ({ kind: "job_lookup", lookup }),
      });
    case "job_import":
      return fromOutcome({
        deps,
        scope: "none",
        outcome: await createClient(deps.pairing).call({
          route: ROUTES.importJob,
          body: importInput(request.edits),
          schema: AddJobResult,
        }),
        ok: (result) => ({ kind: "job_imported", result }),
      });
    case "success_check":
      return successCheck(deps, request);
    case "confirm_applied":
      return confirmApplied(deps, request);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** The real `sendContent`: frame 0 only. */
export function chromeSendImport(tabId: number, message: ImportContentRequest): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}
