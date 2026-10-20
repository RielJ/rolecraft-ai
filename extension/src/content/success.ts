import type { ScanNonce, SuccessReason } from "@shared/extension";
import type { ImportContentReply } from "../messages-import";
import { byHint, isVisible, visibleText } from "./import";
import type { Measure } from "./scan";

// Success detection on the bound application tab (docs/EXTENSION.md). The worker asks only after the user filled or attached on that tab. The answer is a
// reason code or null, never page text, and it never marks anything applied: the panel asks the
// user, and only their Yes calls confirm-applied.

/** A path or hash segment that names a confirmation page. Query strings are ignored (tracking tags). */
const CONFIRM_SEGMENT =
  /^(?:thank-?you|thanks|thankyou|confirmation|confirmed|success|submitted|complete|application-?(?:received|submitted|complete))$/i;

/** Phrases a confirmation page shows. "Thank you for your interest" (on postings) is not one. */
const CONFIRM_TEXT = [
  /\bthanks?(?: you)? for (?:applying|your application|submitting)\b/i,
  /\bapplication (?:has been|was) (?:received|submitted|sent)\b/i,
  /\bwe(?:'ve|’ve| have) (?:received|got) your application\b/i,
  /\bapplication (?:received|submitted)\b/i,
  /\b(?:successfully|you(?:'ve|’ve| have)(?: successfully)?) (?:submitted|applied)\b/i,
];

/** Text in an alert or error element that means the submit was rejected. */
const ERROR_TEXT =
  /\b(?:errors?|invalid|required|missing|please (?:fix|correct|enter|select|complete|provide|upload)|can(?:'|’|no)t be (?:blank|empty)|try again|went wrong|failed|unable)\b/i;

const NOT_A_FIELD: ReadonlySet<string> = new Set(["hidden", "submit", "button", "reset", "image", "search"]);
const MAX_TEXT = 20_000;
/** Longer "error" elements are containers, not messages. */
const MAX_MESSAGE = 300;

const noMeasure: Measure = () => null;

function isField(element: Element): boolean {
  if (element.localName === "textarea" || element.localName === "select") return true;
  return element.localName === "input" && !NOT_A_FIELD.has((element.getAttribute("type") ?? "text").toLowerCase());
}

/**
 * An application form is on screen: two visible fields, or a visible file input. A lone search box
 * is not one. content/index.ts uses it before counting a page as having shown a form (`formSeen`).
 */
export function formShown(document: Document, measure: Measure): boolean {
  const fields = [...document.querySelectorAll("input, textarea, select")].filter(
    (e) => isField(e) && isVisible(e, measure),
  );
  return fields.length >= 2 || fields.some((e) => e.getAttribute("type")?.toLowerCase() === "file");
}

/** The page shows a rejected submit: an invalid field, or an error message. */
function showsErrors(document: Document, measure: Measure): boolean {
  if ([...document.querySelectorAll('[aria-invalid="true"]')].some((e) => isVisible(e, measure))) return true;
  const alerts = document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]');
  for (const alert of alerts) {
    if (ERROR_TEXT.test(visibleText({ root: alert, max: 500, measure }))) return true;
  }
  // A short message element. A wrapper holding fields (or a whole-app "error-boundary") is not one.
  const hinted = [...byHint(document, "error"), ...byHint(document, "invalid")];
  return hinted.some((e) => {
    if (isField(e) || e.querySelector("input, textarea, select") !== null) return false;
    const text = visibleText({ root: e, max: MAX_MESSAGE + 1, measure });
    return text !== "" && text.length <= MAX_MESSAGE;
  });
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function confirmationUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (parsed === null) return false;
  const segments = `${parsed.pathname}/${parsed.hash.slice(1)}`.split("/");
  return segments.some((segment) => CONFIRM_SEGMENT.test(decoded(segment)));
}

/**
 * Why this page looks like a submitted application, or null. `url` is the page address.
 * `formSeen`: this content script scanned an application form on this same page, so a form that
 * is now gone means it was submitted. A page with an invalid field or an error message is never a
 * signal, whatever its address or text says.
 */
export function detectSuccess(
  document: Document,
  url: string,
  { formSeen = false, measure = noMeasure }: { formSeen?: boolean; measure?: Measure } = {},
): SuccessReason | null {
  if (showsErrors(document, measure)) return null;
  if (confirmationUrl(url)) return "confirmation_url";
  const body = document.body;
  const text = body === null ? "" : visibleText({ root: body, max: MAX_TEXT, measure });
  if (CONFIRM_TEXT.some((pattern) => pattern.test(text))) return "confirmation_text";
  if (formSeen && !formShown(document, measure)) return "form_gone";
  return null;
}

/** The content script's answer to `success_probe`: a reason code or null, nothing else. */
export function successProbeReply({
  document,
  nonce,
  formSeen,
  measure = noMeasure,
}: {
  document: Document;
  nonce: ScanNonce;
  formSeen: boolean;
  measure?: Measure;
}): ImportContentReply {
  const url = document.location?.href ?? "";
  return { kind: "success_probe_result", nonce, reason: detectSuccess(document, url, { formSeen, measure }) };
}
