import { DEFAULT_EXTENSION_ENDPOINT, type FillPlan, RuntimeMessage, ScanNonce } from "@shared/extension";
import { blockedSite } from "@shared/hosts";
import type { ClientOutcome, Failed, FailureCode } from "../api/client";
import type { ConnectionStatus, PanelRefusal, PanelReply, PanelResult } from "../messages";
import type { Store } from "../state/storage";
import type { PairingDeps } from "./pairing";

// Worker side of scan and fill. The content script is injected on demand with
// chrome.scripting.executeScript into the active tab's top frame, only after the user acted: the
// panel click that asks for a scan, under activeTab or a granted optional origin (permissions.ts).
// Chrome itself refuses the injection when neither grant holds.
//
// Also the two pieces every tab-facing handler shares (panel.ts, files.ts, import.ts): the tab
// check, and turning a server outcome into a panel reply.

type ScanResult = Extract<RuntimeMessage, { kind: "scan_result" }>;
type FillResultMessage = Extract<RuntimeMessage, { kind: "fill_result" }>;

export type TabRefusal =
  | "not_active"
  | "unsupported_url"
  | "blocked_host"
  | "permission_denied"
  | "not_bound"
  | "bad_reply";

export type ScanOutcome = { kind: "scanned"; result: ScanResult } | { kind: "refused"; reason: TabRefusal };
export type FillTabOutcome = { kind: "filled"; result: FillResultMessage } | { kind: "refused"; reason: TabRefusal };

/** What scan and fill need from Chrome. `chromeContentDeps` builds the real one. */
export type ContentDeps = {
  store: Pick<Store, "readBinding">;
  getTab(tabId: number): Promise<{ active: boolean; url: string | null } | null>;
  /** executeScript into frame 0. `denied` when Chrome refuses (no activeTab or origin grant). */
  inject(tabId: number): Promise<"ok" | "denied">;
  /** chrome.tabs.sendMessage to frame 0; resolves with the raw reply. */
  send(tabId: number, message: RuntimeMessage): Promise<unknown>;
  newNonce(): ScanNonce;
};

/** 24 random bytes as base64url: 32 characters, inside `ScanNonce`'s 16–64. */
export function newScanNonce(): ScanNonce {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return ScanNonce.parse(
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  );
}

/**
 * Why the worker will not touch this tab now, or null: not an http(s) page, a site whose terms
 * forbid automated tools (src/shared/hosts.ts), or not the tab the user is looking at.
 */
export async function checkTab({
  deps,
  tabId,
}: {
  deps: Pick<ContentDeps, "getTab">;
  tabId: number;
}): Promise<TabRefusal | null> {
  const tab = await deps.getTab(tabId);
  if (tab === null || tab.url === null) return "unsupported_url";
  const url = URL.parse(tab.url);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return "unsupported_url";
  if (blockedSite(tab.url) !== null) return "blocked_host";
  if (!tab.active) return "not_active";
  return null;
}

/** Inject into the active tab's top frame and scan it with a fresh nonce. */
export async function scanTab({ deps, tabId }: { deps: ContentDeps; tabId: number }): Promise<ScanOutcome> {
  const refusal = await checkTab({ deps, tabId });
  if (refusal !== null) return { kind: "refused", reason: refusal };
  if ((await deps.inject(tabId)) === "denied") return { kind: "refused", reason: "permission_denied" };

  const nonce = deps.newNonce();
  const raw = await deps.send(tabId, { kind: "scan", nonce }).catch(() => undefined);
  const reply = RuntimeMessage.safeParse(raw);
  if (!reply.success || reply.data.kind !== "scan_result" || reply.data.nonce !== nonce) {
    return { kind: "refused", reason: "bad_reply" };
  }
  return { kind: "scanned", result: reply.data };
}

/**
 * Send a fill plan to the tab the application session is bound to. The content script checks the
 * nonce and each field's signature; the worker checks the reply only names planned fields.
 */
export async function fillTab({
  deps,
  tabId,
  plan,
}: {
  deps: ContentDeps;
  tabId: number;
  plan: FillPlan;
}): Promise<FillTabOutcome> {
  const refusal = await checkTab({ deps, tabId });
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const binding = await deps.store.readBinding();
  if (binding === null || binding.tabId !== tabId) return { kind: "refused", reason: "not_bound" };

  const raw = await deps.send(tabId, { kind: "fill", ...plan }).catch(() => undefined);
  const reply = RuntimeMessage.safeParse(raw);
  if (!reply.success || reply.data.kind !== "fill_result" || reply.data.nonce !== plan.nonce) {
    return { kind: "refused", reason: "bad_reply" };
  }
  const planned = new Set<string>(plan.entries.map((e) => e.fieldId));
  const named = [...reply.data.filled, ...reply.data.skipped.map((s) => s.fieldId)];
  if (named.some((id) => !planned.has(id))) return { kind: "refused", reason: "bad_reply" };
  return { kind: "filled", result: reply.data };
}

/** Real Chrome APIs. Injection targets frame 0 only; no `allFrames`. */
export function chromeContentDeps(store: Pick<Store, "readBinding">): ContentDeps {
  return {
    store,
    getTab: (tabId) =>
      chrome.tabs.get(tabId).then(
        (tab) => ({ active: tab.active, url: tab.url ?? null }),
        () => null,
      ),
    inject: (tabId) =>
      chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }).then(
        () => "ok" as const,
        () => "denied" as const,
      ),
    send: (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
    newNonce: newScanNonce,
  };
}

/**
 * Messages a content script starts, already checked for sender id, top frame and schema by
 * `routeMessage`. Every content exchange is a worker → content request answered through
 * `sendResponse` (scan, fill, attach here and in files.ts; read_job and success_probe in
 * import.ts), so a content script sending a request or a result unprompted is ignored. In
 * particular a page cannot report success on its own: the panel asks.
 */
export async function handleContentMessage(_args: {
  deps: PairingDeps;
  message: RuntimeMessage;
  tabId: number;
  url: string;
}): Promise<null> {
  return null;
}

// ---------- Replies ----------

/** What the reply helpers need: storage, for the connection status and the binding. */
export type ReplyDeps = { pairing: { store: Store } };

/** Paired as far as storage knows. Server calls correct this from their own outcome. */
export async function storedStatus(store: Store): Promise<ConnectionStatus> {
  const { endpoint, pairing } = await store.readLocal();
  if (endpoint === null || pairing === null) {
    return { kind: "unpaired", endpoint: endpoint ?? DEFAULT_EXTENSION_ENDPOINT, notice: null };
  }
  return { kind: "paired", endpoint, pairingId: pairing.pairingId };
}

/** A reply with the stored status and this result. */
export async function localReply(deps: ReplyDeps, result: PanelResult): Promise<PanelReply> {
  return { status: await storedStatus(deps.pairing.store), error: null, result };
}

export function refusedReply(deps: ReplyDeps, reason: PanelRefusal): Promise<PanelReply> {
  return localReply(deps, { kind: "refused", reason });
}

/**
 * What a server route answers about, which decides whether its failure means the bound session is
 * gone:
 * - `session`: the route looks up the session (prefill, outputs list, draft, task, confirm-applied),
 *   so its not_found is the session's;
 * - `output`: one output of the session (reviewed, PDF). The server's not_found here may be the
 *   output's alone, so only session_expired counts; a later session route catches a lost session;
 * - `none`: not about the session (lookup, import, preferences).
 */
export type OutcomeScope = "session" | "output" | "none";

/** Whether a failed call with this scope and code means the bound session is gone. */
function dropsBinding({ scope, code }: { scope: OutcomeScope; code: FailureCode }): boolean {
  switch (scope) {
    case "session":
      return code === "session_expired" || code === "not_found";
    case "output":
      return code === "session_expired";
    case "none":
      return false;
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

/**
 * Turn a client outcome into a reply: unpaired and unreachable change the status (the panel shows
 * the pairing screen), an app error fails. A failure that means the session is gone
 * (`dropsBinding`) drops the binding.
 */
export async function fromOutcome<T>({
  deps,
  outcome,
  ok,
  scope,
}: {
  deps: ReplyDeps;
  outcome: ClientOutcome<T> | Failed;
  ok: (data: T) => PanelResult | Promise<PanelResult>;
  scope: OutcomeScope;
}): Promise<PanelReply> {
  const store = deps.pairing.store;
  switch (outcome.kind) {
    case "ok":
      return localReply(deps, await ok(outcome.data));
    case "unpaired": {
      const { endpoint } = await store.readLocal();
      return {
        status: { kind: "unpaired", endpoint: endpoint ?? DEFAULT_EXTENSION_ENDPOINT, notice: "revoked" },
        error: null,
      };
    }
    case "unreachable": {
      const { endpoint } = await store.readLocal();
      return { status: { kind: "unreachable", endpoint: endpoint ?? DEFAULT_EXTENSION_ENDPOINT }, error: null };
    }
    case "failed": {
      if (dropsBinding({ scope, code: outcome.code })) await store.clearBinding();
      const message = outcome.message.slice(0, 500);
      return { ...(await localReply(deps, { kind: "failed", code: outcome.code, message })), error: message };
    }
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
