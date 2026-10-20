import { type FieldId, type FillEntry, type FillSkipReason, type FillValue, isSalaryLabel } from "@shared/extension";
import {
  type Choice,
  isCombobox,
  type Measure,
  radioChoices,
  radioState,
  type ScannedField,
  type ScanTarget,
  selectChoices,
  signatureOf,
  targetState,
} from "./scan";

// Writes a fill plan into the fields of the current scan. Rules (docs/EXTENSION.md):
// rescan each field and compare its signature first; never touch file inputs, salary fields,
// non-empty, hidden, disabled or read-only controls; never click buttons or submit. Values go
// through the native setter plus `input`/`change`, so React-controlled inputs see the change.
// `FillPlan` has no overwrite flag, so a non-empty field is never written.

export type FillOutcome = {
  filled: FieldId[];
  skipped: { fieldId: FieldId; reason: FillSkipReason }[];
};

type Written = { kind: "filled" } | { kind: "skipped"; reason: FillSkipReason };
const skip = (reason: FillSkipReason): Written => ({ kind: "skipped", reason });
const FILLED: Written = { kind: "filled" };

/**
 * The prototype's setter for `property`, skipping any own-property override. React replaces
 * `value` on the element instance to track it; assigning through that override makes React think
 * nothing changed, and the next render puts the old value back.
 */
function nativeSet(
  element: Element,
  property: "value" | "checked" | "selectedIndex",
  value: string | boolean | number,
): boolean {
  for (
    let proto: object | null = Object.getPrototypeOf(element);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    const setter = Object.getOwnPropertyDescriptor(proto, property)?.set;
    if (setter !== undefined) {
      setter.call(element, value);
      return true;
    }
  }
  return false;
}

function announce(element: Element): void {
  const view = element.ownerDocument.defaultView;
  if (view === null) return;
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
}

function writeText(element: HTMLInputElement | HTMLTextAreaElement, value: FillValue): Written {
  if (value.kind !== "text") return skip("no_matching_option");
  if (element.value !== "") return skip("not_empty");
  if (!nativeSet(element, "value", value.text)) return skip("read_only");
  // Date and number inputs sanitize a bad value to "": leave the field empty and say so.
  if (element.value !== value.text) {
    nativeSet(element, "value", "");
    return skip("no_matching_option");
  }
  announce(element);
  return FILLED;
}

/**
 * The option `value` names, looked up the same way the scan offered it: by the page's value, or by
 * position when the page's values clash. The caller has already matched the scan's signature, so
 * the choices are the ones the plan was made against.
 */
function chosen<E extends HTMLOptionElement | HTMLInputElement>(
  field: ScannedField,
  choices: readonly Choice<E>[],
  value: string,
): E | undefined {
  if (!field.descriptor.options.some((o) => o.value === value)) return undefined;
  return choices.find((c) => c.option.value === value)?.element;
}

function writeSelect(field: ScannedField, element: HTMLSelectElement, value: FillValue): Written {
  if (value.kind !== "option") return skip("no_matching_option");
  if (element.value !== "") return skip("not_empty");
  const option = chosen(field, selectChoices(element), value.value);
  if (option === undefined || option.disabled || option.value === "") return skip("no_matching_option");
  const before = element.selectedIndex;
  // `select.value = v` picks the first option with that value, which is the wrong one when values clash.
  const unique = Array.from(element.options).find((o) => o.value === option.value) === option;
  const set = unique ? nativeSet(element, "value", option.value) : nativeSet(element, "selectedIndex", option.index);
  if (!set) return skip("read_only");
  // Never leave a different option selected than the one the plan names.
  if (element.options[element.selectedIndex] !== option) {
    nativeSet(element, "selectedIndex", before);
    return skip("no_matching_option");
  }
  announce(element);
  return FILLED;
}

/**
 * Toggles go through `click()`, which is how a user changes them and what React listens to for
 * checkbox and radio `onChange`. Only ever called on `type=checkbox|radio` inputs, never a button.
 */
function toggleOn(element: HTMLInputElement): Written {
  element.click();
  // The page may cancel the click (preventDefault): treat it like a control that would not change.
  return element.checked ? FILLED : skip("read_only");
}

function writeCheckbox(element: HTMLInputElement, value: FillValue): Written {
  if (value.kind !== "checked") return skip("no_matching_option");
  if (element.checked) return skip("not_empty");
  // Unchecked already is the requested state: nothing to write.
  return value.checked ? toggleOn(element) : FILLED;
}

function writeRadio(
  field: ScannedField,
  radios: readonly HTMLInputElement[],
  value: FillValue,
  measure: Measure,
): Written {
  if (value.kind !== "option") return skip("no_matching_option");
  if (radios.some((r) => r.checked)) return skip("not_empty");
  const radio = chosen(field, radioChoices(radios), value.value);
  if (radio === undefined) return skip("no_matching_option");
  const state = radioState({ radio, measure });
  if (state.kind === "blocked") return skip(state.reason);
  return toggleOn(radio);
}

function write(field: ScannedField, target: ScanTarget, value: FillValue, measure: Measure): Written {
  switch (target.kind) {
    case "text":
    case "textarea":
      return writeText(target.element, value);
    case "select":
      return writeSelect(field, target.element, value);
    case "checkbox":
      return writeCheckbox(target.element, value);
    case "radio":
      return writeRadio(field, target.elements, value, measure);
    case "file":
      return skip("file_field");
    case "combobox":
      return skip("no_matching_option");
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function elementsOf(target: ScanTarget): readonly Element[] {
  return target.kind === "radio" ? target.elements : [target.element];
}

function fillOne(field: ScannedField | undefined, entry: FillEntry, measure: Measure): Written {
  if (field === undefined) return skip("missing");
  // Checked before anything reads the page again: these two never fill, whatever the plan says.
  if (field.target.kind === "file") return skip("file_field");
  if (isSalaryLabel(field.descriptor.label)) return skip("salary");
  const state = targetState({ target: field.target, measure });
  if (state.kind === "blocked") return skip(state.reason);
  if (signatureOf(field.target) !== field.signature) return skip("stale");
  // Read live, so a box that became a type-ahead widget after the scan is refused too. Typing into
  // one selects no option; the closest reason is that no option could be matched.
  if (elementsOf(field.target).some(isCombobox)) return skip("no_matching_option");
  return write(field, field.target, entry.value, measure);
}

/** Apply `entries` to the fields of the scan they were planned against. Each id is used once. */
export function fillFields({
  fields,
  entries,
  measure,
}: {
  fields: ReadonlyMap<FieldId, ScannedField>;
  entries: readonly FillEntry[];
  measure: Measure;
}): FillOutcome {
  const outcome: FillOutcome = { filled: [], skipped: [] };
  const seen = new Set<FieldId>();
  for (const entry of entries) {
    if (seen.has(entry.fieldId)) continue;
    seen.add(entry.fieldId);
    const result = fillOne(fields.get(entry.fieldId), entry, measure);
    if (result.kind === "filled") outcome.filled.push(entry.fieldId);
    else outcome.skipped.push({ fieldId: entry.fieldId, reason: result.reason });
  }
  return outcome;
}
