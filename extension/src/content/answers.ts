import type { FieldDescriptor, ScanNonce } from "@shared/extension";
import { isReferenceField } from "@shared/extension-answers";
import type { ReadAnswerResult } from "../messages-answers";
import type { CurrentScan } from "./files";
import { type Measure, measureInPage, signatureOf, targetState } from "./scan";

/** Reads one explicitly selected text field. Never includes any other field's value. */
export function readAnswer({
  current,
  nonce,
  field,
  measure = measureInPage,
}: {
  current: CurrentScan | null;
  nonce: ScanNonce;
  field: FieldDescriptor;
  measure?: Measure;
}): ReadAnswerResult {
  const unavailable: ReadAnswerResult = { kind: "answer_unavailable", nonce, fieldId: field.fieldId };
  if (current === null || current.nonce !== nonce || !isReferenceField(field)) return unavailable;
  const entry = current.fields.get(field.fieldId);
  if (entry === undefined || JSON.stringify(entry.descriptor) !== JSON.stringify(field)) return unavailable;
  if (
    (entry.target.kind !== "text" && entry.target.kind !== "textarea") ||
    entry.signature !== signatureOf(entry.target)
  )
    return unavailable;
  const element = entry.target.element;
  if (targetState({ target: entry.target, measure }).kind !== "usable") return unavailable;
  const body = element.value;
  if (body.length > 10_000) return unavailable;
  return { kind: "answer_text", nonce, fieldId: field.fieldId, body };
}
