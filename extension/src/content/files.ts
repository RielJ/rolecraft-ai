import { type AttachRejectReason, type FieldId, MAX_ATTACHMENT_BYTES, type ScanNonce } from "@shared/extension";
import { type AttachMessage, type AttachResultMessage, base64ToBytes, isPdf } from "../messages-attach";
import { type Measure, type ScannedField, signatureOf, targetState } from "./scan";

// Puts one PDF the worker fetched into one file input of the current scan (docs/EXTENSION.md,
// "Attach files"). Only the exact input the scan gave this field id, only while it
// is still present, visible, enabled, unchanged, empty and accepts PDF. Sets the file through
// DataTransfer, fires `input` and `change`, and never clicks or submits. Keeps no reference to
// the bytes or the File after it returns.

/** The scan content/index.ts keeps in its closure: nonce plus the field id → element map. */
export type CurrentScan = { nonce: ScanNonce; fields: ReadonlyMap<FieldId, ScannedField> };

/** Puts `file` on `input`. The default uses DataTransfer; tests may pass another. */
export type FileAssigner = (input: HTMLInputElement, file: File) => void;

type Target = { kind: "ready"; input: HTMLInputElement } | { kind: "rejected"; reason: AttachRejectReason };

const PDF_ACCEPT_TOKENS: ReadonlySet<string> = new Set([".pdf", "application/pdf", "application/*", "*/*"]);

/** True when a file picker with this `accept` attribute would offer a PDF. Empty accepts anything. */
export function acceptsPdf(accept: string): boolean {
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
  return tokens.length === 0 || tokens.some((t) => PDF_ACCEPT_TOKENS.has(t));
}

/**
 * The input to write, or why not. The scan only lists usable inputs, so an input that is now
 * missing, hidden, disabled or described differently means the form changed: `stale`.
 */
export function attachTarget({
  current,
  nonce,
  fieldId,
  measure,
}: {
  current: CurrentScan | null;
  nonce: ScanNonce;
  fieldId: FieldId;
  measure: Measure;
}): Target {
  const reject = (reason: AttachRejectReason): Target => ({ kind: "rejected", reason });
  if (current === null || current.nonce !== nonce) return reject("stale");
  const field = current.fields.get(fieldId);
  if (field === undefined) return reject("stale");
  const { target } = field;
  if (target.kind !== "file") return reject("not_file_input");
  const input = target.element;
  if (targetState({ target, measure }).kind !== "usable") return reject("stale");
  if (input.type !== "file") return reject("not_file_input");
  if (signatureOf(target) !== field.signature) return reject("stale");
  if (!acceptsPdf(input.accept)) return reject("wrong_type");
  if ((input.files?.length ?? 0) > 0 || input.value !== "") return reject("not_empty");
  return { kind: "ready", input };
}

/** What a user's file pick does: a FileList of one, set on the input. */
export function assignWithDataTransfer(input: HTMLInputElement, file: File): void {
  const view = input.ownerDocument.defaultView;
  if (view === null) return;
  const transfer = new view.DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
}

/** Handle one `attach` message against the current scan. Always answers with an `attach_result`. */
export function attachFile({
  current,
  message,
  measure,
  assign = assignWithDataTransfer,
  maxBytes = MAX_ATTACHMENT_BYTES,
}: {
  current: CurrentScan | null;
  message: AttachMessage;
  measure: Measure;
  assign?: FileAssigner;
  maxBytes?: number;
}): AttachResultMessage {
  const answer = (result: AttachResultMessage["result"]): AttachResultMessage => ({
    kind: "attach_result",
    nonce: message.nonce,
    fieldId: message.fieldId,
    result,
  });
  const reject = (reason: AttachRejectReason) => answer({ kind: "rejected", reason });

  const target = attachTarget({ current, nonce: message.nonce, fieldId: message.fieldId, measure });
  if (target.kind === "rejected") return reject(target.reason);
  const { input } = target;

  const bytes = base64ToBytes(message.dataBase64);
  if (bytes === null) return reject("wrong_type");
  if (bytes.length > maxBytes) return reject("too_large");
  if (!isPdf(bytes)) return reject("wrong_type");

  const view = input.ownerDocument.defaultView;
  if (view === null) return reject("stale");
  const file = new view.File([bytes], message.fileName, { type: message.mimeType });
  assign(input, file);
  // Some widgets replace or lock the FileList; only report what the input now holds.
  const taken = input.files;
  if (taken?.length !== 1 || taken[0]?.name !== message.fileName) return reject("not_file_input");

  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  return answer({ kind: "attached" });
}
