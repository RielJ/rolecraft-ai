import { OutputId } from "@shared/api";
import {
  ApplicationSessionId,
  AttachRejectReason,
  AttachRequest,
  FieldId,
  MAX_ATTACHMENT_BYTES,
  type RuntimeMessage,
} from "@shared/extension";
import { z } from "zod";

// File attachment messages (docs/EXTENSION.md). messages.ts spreads
// `ATTACH_PANEL_REQUESTS` into `PanelRequest` and `ATTACH_PANEL_RESULTS` into `PanelResult`. This module must not import values from ./messages: messages.ts imports this
// one, and a cycle would leave these schemas undefined at load.
//
// Worker <-> content messages are `attach` and `attach_result` in `RuntimeMessage`
// (src/shared/extension.ts), already strict. The bytes travel in that message only, never in
// chrome.storage.

const TabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Attach this output's PDF to this file field of the current scan. Only sent from an Attach click.
 * The worker checks the session-to-tab binding and the tab; the content script checks the nonce.
 */
export const AttachPanelRequest = z.strictObject({ kind: z.literal("attach"), tabId: TabId, ...AttachRequest.shape });
export type AttachPanelRequest = z.infer<typeof AttachPanelRequest>;

/** Save the PDF to Downloads instead, after an attach was rejected. Only sent from a click. */
export const AttachDownloadRequest = z.strictObject({
  kind: z.literal("attach_download"),
  sessionId: ApplicationSessionId,
  outputId: OutputId,
});
export type AttachDownloadRequest = z.infer<typeof AttachDownloadRequest>;

/** For `z.discriminatedUnion("kind", [...existing, ...ATTACH_PANEL_REQUESTS])` in messages.ts. */
export const ATTACH_PANEL_REQUESTS = [AttachPanelRequest, AttachDownloadRequest] as const;
export const AttachRequests = z.discriminatedUnion("kind", ATTACH_PANEL_REQUESTS);
export type AttachRequests = z.infer<typeof AttachRequests>;

/** Sanitized PDF name the worker hands the page: ASCII, at most 120 characters. */
const FileName = z
  .string()
  .max(120)
  .regex(/^[A-Za-z0-9 ._()-]+\.pdf$/);

/** For `z.discriminatedUnion("kind", [...existing, ...ATTACH_PANEL_RESULTS])` in messages.ts. */
export const ATTACH_PANEL_RESULTS = [
  z.object({ kind: z.literal("attach_done"), fieldId: FieldId, fileName: FileName }),
  /** `fieldId` is null when a download was refused for the same reason. */
  z.object({ kind: z.literal("attach_rejected"), fieldId: FieldId.nullable(), reason: AttachRejectReason }),
  z.object({ kind: z.literal("attach_downloaded"), outputId: OutputId }),
  z.object({ kind: z.literal("attach_download_failed"), outputId: OutputId }),
] as const;
export const AttachPanelResult = z.discriminatedUnion("kind", ATTACH_PANEL_RESULTS);
export type AttachPanelResult = z.infer<typeof AttachPanelResult>;

export type AttachMessage = Extract<RuntimeMessage, { kind: "attach" }>;
export type AttachResultMessage = Extract<RuntimeMessage, { kind: "attach_result" }>;

// ---------- Bytes ----------

/** `%PDF-`, the first five bytes of every PDF. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export function isPdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, i) => bytes[i] === byte);
}

export const MAX_ATTACHMENT_BASE64 = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/** Chunked so a 10 MB file does not overflow the argument limit of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** Null when `text` is not base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
