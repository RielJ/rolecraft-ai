import { MAX_ATTACHMENT_BYTES, RuntimeMessage } from "@shared/extension";
import { type Client, type ClientOutcome, createClient, type Failed, ROUTES } from "../api/client";
import {
  type AttachDownloadRequest,
  type AttachMessage,
  type AttachPanelRequest,
  type AttachPanelResult,
  type AttachRequests,
  bytesToBase64,
  isPdf,
} from "../messages-attach";
import type { SessionBinding, Store } from "../state/storage";
import { type ContentDeps, checkTab, type TabRefusal } from "./content";
import type { PairingDeps } from "./pairing";

// Worker side of file attachment (docs/plans/chrome-extension.md, "Files"). On an Attach click:
// check the session-to-tab binding and the tab, fetch the output's PDF with the bearer token,
// check it is application/pdf, starts with %PDF- and is at most 10 MB, then hand the bytes to the
// content script of the bound tab as base64. The bytes live in this call only: never in
// chrome.storage. The content script checks the scan nonce and the input itself.

/** What attach needs. `attachDeps` builds it from the panel's deps. */
export type AttachDeps = {
  client: Pick<Client, "send">;
  tabs: Pick<ContentDeps, "getTab" | "send">;
  store: Pick<Store, "readBinding">;
  /** chrome.downloads.download; `failed` when Chrome refuses. */
  download(args: { url: string; filename: string }): Promise<"ok" | "failed">;
};

/**
 * `refused` maps to `PanelResult` `refused`; the rest is a client outcome, which panel.ts passes
 * to `fromOutcome` with `scope: "output"` and `ok: (result) => result`.
 */
export type AttachHandled = { kind: "refused"; reason: TabRefusal } | ClientOutcome<AttachPanelResult> | Failed;

type PdfRead =
  | { kind: "pdf"; bytes: Uint8Array; fileName: string }
  | { kind: "rejected"; reason: "wrong_type" | "too_large" };

const FALLBACK_NAME = "Application";
const MAX_BASE_NAME = 116;

/** The `filename*` (RFC 5987) or `filename` parameter of a Content-Disposition header. */
export function dispositionFileName(header: string | null): string | null {
  if (header === null) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header)?.[1];
  if (star !== undefined) {
    try {
      return decodeURIComponent(star);
    } catch {
      return null;
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header);
  return plain?.[1] ?? plain?.[2] ?? null;
}

/**
 * The name the page sees: ASCII letters, digits, space and `._()-`, ending in `.pdf`, at most 120
 * characters (`AttachFileName` in src/shared/extension.ts). Accents are folded ("Résumé" →
 * "Resume"); other characters are dropped, and so are separators they leave empty.
 */
export function attachFileName(raw: string | null): string {
  const trimEnds = (text: string) => text.replace(/^[\s._-]+|[\s._-]+$/g, "");
  const ascii = (raw ?? "")
    .replace(/\.pdf$/i, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*-\s*){2,}/g, " - ");
  const base = trimEnds(trimEnds(ascii).slice(0, MAX_BASE_NAME));
  return `${base === "" ? FALLBACK_NAME : base}.pdf`;
}

/** Read at most `maxBytes`; stop and cancel as soon as the body is longer. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Check a 2xx PDF response: media type, size, magic bytes. Reads the body once. */
export async function readPdf({
  response,
  maxBytes = MAX_ATTACHMENT_BYTES,
}: {
  response: Response;
  maxBytes?: number;
}): Promise<PdfRead> {
  const discard = () => response.body?.cancel().catch(() => undefined);
  const mediaType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/pdf") {
    await discard();
    return { kind: "rejected", reason: "wrong_type" };
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard();
    return { kind: "rejected", reason: "too_large" };
  }
  const bytes = await readCapped(response, maxBytes);
  if (bytes === null) return { kind: "rejected", reason: "too_large" };
  if (!isPdf(bytes)) return { kind: "rejected", reason: "wrong_type" };
  const fileName = attachFileName(dispositionFileName(response.headers.get("Content-Disposition")));
  return { kind: "pdf", bytes, fileName };
}

/** Why this tab may not receive a file now, or null. Same rules as scan and fill (content.ts). */
async function tabRefusal(deps: AttachDeps, request: AttachPanelRequest): Promise<TabRefusal | null> {
  const binding: SessionBinding | null = await deps.store.readBinding();
  if (binding === null || binding.sessionId !== request.sessionId || binding.tabId !== request.tabId) {
    return "not_bound";
  }
  return checkTab({ deps: deps.tabs, tabId: request.tabId });
}

function fetchPdf(deps: AttachDeps, request: AttachRequests) {
  return deps.client.send({ route: ROUTES.outputPdf, params: { id: request.sessionId, outputId: request.outputId } });
}

const ok = (data: AttachPanelResult): AttachHandled => ({ kind: "ok", data });

async function attach(deps: AttachDeps, request: AttachPanelRequest): Promise<AttachHandled> {
  const before = await tabRefusal(deps, request);
  if (before !== null) return { kind: "refused", reason: before };

  const sent = await fetchPdf(deps, request);
  if (sent.kind !== "ok") return sent;
  const pdf = await readPdf({ response: sent.data });
  if (pdf.kind === "rejected") return ok({ kind: "attach_rejected", fieldId: request.fieldId, reason: pdf.reason });

  // The fetch took time: the tab may have moved or the binding been cleared meanwhile.
  const after = await tabRefusal(deps, request);
  if (after !== null) return { kind: "refused", reason: after };

  const message: AttachMessage = {
    kind: "attach",
    nonce: request.nonce,
    fieldId: request.fieldId,
    fileName: pdf.fileName,
    mimeType: "application/pdf",
    dataBase64: bytesToBase64(pdf.bytes),
  };
  let raw: unknown;
  try {
    raw = await deps.tabs.send(request.tabId, message);
  } catch {
    // No content script on the page any more (reload or navigation): the scan is gone.
    return ok({ kind: "attach_rejected", fieldId: request.fieldId, reason: "stale" });
  }
  const reply = RuntimeMessage.safeParse(raw);
  if (
    !reply.success ||
    reply.data.kind !== "attach_result" ||
    reply.data.nonce !== request.nonce ||
    reply.data.fieldId !== request.fieldId
  ) {
    return { kind: "refused", reason: "bad_reply" };
  }
  const { result } = reply.data;
  return ok(
    result.kind === "attached"
      ? { kind: "attach_done", fieldId: request.fieldId, fileName: pdf.fileName }
      : { kind: "attach_rejected", fieldId: request.fieldId, reason: result.reason },
  );
}

/** The fallback after a rejection: same checks on the bytes, then Chrome's Downloads. No page involved. */
async function download(deps: AttachDeps, request: AttachDownloadRequest): Promise<AttachHandled> {
  const binding = await deps.store.readBinding();
  if (binding === null || binding.sessionId !== request.sessionId) return { kind: "refused", reason: "not_bound" };

  const sent = await fetchPdf(deps, request);
  if (sent.kind !== "ok") return sent;
  const pdf = await readPdf({ response: sent.data });
  if (pdf.kind === "rejected") return ok({ kind: "attach_rejected", fieldId: null, reason: pdf.reason });

  const saved = await deps.download({
    url: `data:application/pdf;base64,${bytesToBase64(pdf.bytes)}`,
    filename: pdf.fileName,
  });
  return ok(
    saved === "ok"
      ? { kind: "attach_downloaded", outputId: request.outputId }
      : { kind: "attach_download_failed", outputId: request.outputId },
  );
}

/** `handlePanelRequest` (panel.ts) calls this for `attach` and `attach_download`. */
export async function handleAttach({
  deps,
  request,
}: {
  deps: AttachDeps;
  request: AttachRequests;
}): Promise<AttachHandled> {
  switch (request.kind) {
    case "attach":
      return attach(deps, request);
    case "attach_download":
      return download(deps, request);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** Real Chrome Downloads. `uniquify` keeps an earlier copy instead of overwriting it. */
export function chromeDownload(args: { url: string; filename: string }): Promise<"ok" | "failed"> {
  return chrome.downloads.download({ url: args.url, filename: args.filename, conflictAction: "uniquify" }).then(
    () => "ok" as const,
    () => "failed" as const,
  );
}

/** Build `AttachDeps` from the panel handler's deps. */
export function attachDeps({
  pairing,
  content,
  download = chromeDownload,
}: {
  pairing: PairingDeps;
  content: ContentDeps;
  download?: AttachDeps["download"] | undefined;
}): AttachDeps {
  return { client: createClient(pairing), tabs: content, store: pairing.store, download };
}
