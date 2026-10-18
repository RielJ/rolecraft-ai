import type { PrefillCategory } from "@shared/extension";
import { type FieldHint, primary, type ScanAdapter, type ScanTarget } from "../content/scan";
import { linkCategory, textHint, titleText, yesNoCategory } from "./common";

// Lever postings (jobs.lever.co/<company>/<posting>/apply). Fixture: test/fixtures/lever.html.
//
// Native controls with stable names. Each question sits in `.application-question` with its title
// in `.application-label` (company "cards" put it in `.application-label .text`, not tied to the
// inputs, so the generic scan sees no label). The U.S. EEO section uses `eeo[...]` names.

export const LEVER_HOSTS: ReadonlySet<string> = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);

/** The application form Lever renders on a posting's apply page. */
export const LEVER_MARKER = "form#application-form .application-question";

const STANDARD: ReadonlyMap<string, PrefillCategory> = new Map([
  ["name", "full_name"],
  ["email", "email"],
  ["phone", "phone"],
  ["location", "location"],
]);

const EEO: ReadonlyMap<string, PrefillCategory> = new Map([
  ["eeo[gender]", "gender"],
  ["eeo[race]", "race_ethnicity"],
  ["eeo[veteran]", "veteran_status"],
  ["eeo[disability]", "disability_status"],
]);

/**
 * The disability form's signature lines are labelled just "Name" and "Date". Said in full, so the
 * label match doesn't take them for the applicant's name or a start date.
 */
const SIGNATURE: ReadonlyMap<string, string> = new Map([
  ["eeo[disabilitySignature]", "Signature, voluntary self-identification of disability form"],
  ["eeo[disabilitySignatureDate]", "Date signed, voluntary self-identification of disability form"],
]);

/** The question's title, read from the question block around the control. */
function questionTitle(element: Element): string {
  const block = element.closest(".application-question");
  const label = block?.querySelector(".application-label") ?? null;
  return titleText(label?.querySelector(".text") ?? label);
}

function categoryHint(target: ScanTarget, name: string, title: string): FieldHint | null {
  const standard = STANDARD.get(name);
  if (standard !== undefined) return textHint(target, standard);
  // `urls[LinkedIn]`, `urls[Github]`, `urls[Other Website]`…
  if (name.startsWith("urls[") && name.endsWith("]")) return textHint(target, linkCategory(name.slice(5, -1)));
  // Select or radio group: the scan keeps the category only when the options are writable.
  const eeo = EEO.get(name);
  if (eeo !== undefined) return { adapterCategory: eeo };
  const yesNo = name.startsWith("cards[") ? yesNoCategory(target, title) : null;
  return yesNo === null ? null : { adapterCategory: yesNo };
}

function hint(target: ScanTarget): FieldHint | null {
  // One checkbox of a multi-select is one option, not the question: its own label ("Yes",
  // "He/him") is the honest one, and the question's would let a yes/no answer tick "No".
  if (target.kind === "checkbox") return null;
  const element = primary(target);
  const name = element.getAttribute("name") ?? "";
  const signature = SIGNATURE.get(name);
  if (signature !== undefined) return { labelOverride: signature };
  const title = questionTitle(element);
  return { ...(title === "" ? {} : { labelOverride: title }), ...categoryHint(target, name, title) };
}

export const lever: ScanAdapter = { id: "lever", hint };
