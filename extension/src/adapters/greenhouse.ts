import type { PrefillCategory } from "@shared/extension";
import { type FieldHint, primary, type ScanAdapter, type ScanTarget } from "../content/scan";
import { linkCategory, textHint, titleText } from "./common";

// Greenhouse job boards (job-boards.greenhouse.io, boards.greenhouse.io; the legacy board URLs
// now serve the same React form). Fixture: test/fixtures/greenhouse.html.
//
// Standard fields are plain inputs with stable ids. Every single-choice question (country, work
// authorization, sponsorship, EEOC) is a react-select combobox whose options are not in the DOM:
// those get no category here, and the scan drops one on any combobox anyway.

export const GREENHOUSE_HOSTS: ReadonlySet<string> = new Set([
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.eu.greenhouse.io",
  "boards.eu.greenhouse.io",
]);

/** The application form Greenhouse renders on a posting. */
export const GREENHOUSE_MARKER = "form#application-form .application--questions";

const STANDARD: ReadonlyMap<string, PrefillCategory> = new Map([
  ["first_name", "given_name"],
  ["last_name", "family_name"],
  ["email", "email"],
  ["phone", "phone"],
]);

/** "Resume/CV" or "Cover Letter": the upload group's heading, not the hidden "Attach" label. */
function uploadLabel(element: Element): string {
  const group = element.closest('[role="group"][aria-labelledby]');
  const id = group?.getAttribute("aria-labelledby") ?? "";
  return id === "" ? "" : titleText(element.ownerDocument.getElementById(id));
}

function hint(target: ScanTarget): FieldHint | null {
  const element = primary(target);
  if (target.kind === "file") {
    const label = uploadLabel(element);
    return label === "" ? null : { labelOverride: label };
  }
  const standard = STANDARD.get(element.id);
  if (standard !== undefined) return textHint(target, standard);
  // Custom questions are `question_<id>`; only the standard profile links are certain.
  if (/^question_\d+$/.test(element.id)) {
    const label = titleText(element.ownerDocument.getElementById(`${element.id}-label`));
    return textHint(target, linkCategory(label));
  }
  return null;
}

export const greenhouse: ScanAdapter = { id: "greenhouse", hint };
