import type { PrefillCategory } from "@shared/extension";
import { type FieldHint, primary, type ScanAdapter, type ScanTarget } from "../content/scan";
import { linkCategory, textHint, titleText } from "./common";

// Ashby job boards (jobs.ashbyhq.com/<company>/<posting>/application). Rendered client-side.
// Fixture: test/fixtures/ashby.html.
//
// Each question is a `[data-field-path]` entry titled by `.ashby-application-form-question-title`.
// System fields have fixed paths (`_systemfield_name`, `_systemfield_eeoc_gender`…); company
// questions use a UUID path. Yes/No questions are two buttons plus a hidden checkbox: fill never
// clicks buttons, so those get nothing (labelling the checkbox would let a "yes" tick it while the
// form keeps its own state). EEOC radios have no `value`; the scan offers them by position.

export const ASHBY_HOSTS: ReadonlySet<string> = new Set(["jobs.ashbyhq.com"]);

/** The application form Ashby renders on a posting's application tab. */
export const ASHBY_MARKER = ".ashby-application-form-container [data-field-path]";

const SYSTEM: ReadonlyMap<string, PrefillCategory> = new Map([
  ["_systemfield_name", "full_name"],
  ["_systemfield_email", "email"],
  ["_systemfield_eeoc_gender", "gender"],
  ["_systemfield_eeoc_race", "race_ethnicity"],
  ["_systemfield_eeoc_veteran_status", "veteran_status"],
]);

function categoryHint(target: ScanTarget, path: string, title: string): FieldHint | null {
  const system = SYSTEM.get(path);
  if (system !== undefined) {
    return target.kind === "radio" || target.kind === "select" ? { adapterCategory: system } : textHint(target, system);
  }
  if (target.kind === "text" && target.control === "tel") return { adapterCategory: "phone" };
  return textHint(target, linkCategory(title));
}

function hint(target: ScanTarget): FieldHint | null {
  const element = primary(target);
  // "Autofill from resume" uploader above the form: name it, so it isn't mistaken for the resume field.
  const autofill = element.closest(".ashby-application-form-autofill-uploader");
  if (autofill !== null) {
    const title = titleText(autofill.querySelector(".ashby-application-form-autofill-input-title"));
    return title === "" ? null : { labelOverride: title };
  }
  if (element.closest(".ashby-application-form-input-yesno") !== null) return null;
  const entry = element.closest("[data-field-path]");
  if (entry === null) return null;
  const title = titleText(entry.querySelector(".ashby-application-form-question-title"));
  const path = entry.getAttribute("data-field-path") ?? "";
  return { ...(title === "" ? {} : { labelOverride: title }), ...categoryHint(target, path, title) };
}

export const ashby: ScanAdapter = { id: "ashby", hint };
