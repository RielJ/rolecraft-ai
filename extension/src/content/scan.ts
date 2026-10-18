import {
  type AdapterId,
  type FieldControl,
  type FieldDescriptor,
  FieldId,
  type FieldOption,
  isSalaryLabel,
  MAX_FIELD_OPTIONS,
  MAX_PREFILL_FIELDS,
  type PrefillCategory,
} from "@shared/extension";

// Generic form scan (docs/plans/chrome-extension.md, "Content script"). Top frame only. Reports
// visible, editable controls as `FieldDescriptor`s keyed by a per-scan random id. The id → element
// map stays in this content script's memory: no selector, path or element reference ever leaves.

/** A control's box in page coordinates (viewport rect plus scroll). */
export type Box = { left: number; top: number; width: number; height: number };

/** Layout probe. `null` means "unknown" (no layout engine), and the box check is skipped. */
export type Measure = (element: Element) => Box | null;

/**
 * True when a box is too small to see or lies entirely above or left of the page: the 1px
 * "visually hidden" clip and the `left: -9999px` honeypot. Below the fold is fine.
 */
export function boxLooksHidden(box: Box): boolean {
  if (box.width < 2 || box.height < 2) return true;
  return box.left + box.width <= 0 || box.top + box.height <= 0;
}

/** The real browser's measure. In test DOMs without layout, pass `() => null` instead. */
export function measureInPage(element: Element): Box {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return {
    left: rect.left + (view?.scrollX ?? 0),
    top: rect.top + (view?.scrollY ?? 0),
    width: rect.width,
    height: rect.height,
  };
}

type TextControl = Extract<FieldControl, "text" | "email" | "tel" | "url" | "number" | "date">;

/** What a field id points at. A radio group is one field. */
export type ScanTarget =
  | { kind: "text"; control: TextControl; element: HTMLInputElement }
  | { kind: "textarea"; element: HTMLTextAreaElement }
  | { kind: "select"; element: HTMLSelectElement }
  | { kind: "checkbox"; element: HTMLInputElement }
  | { kind: "radio"; elements: readonly [HTMLInputElement, ...HTMLInputElement[]] }
  | { kind: "file"; element: HTMLInputElement }
  /** A type-ahead widget: reported so the user sees it, never written. */
  | { kind: "combobox"; element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement };

/**
 * A type-ahead widget (react-select and friends) whose options are not in the page: typing text
 * selects nothing, so neither the matcher nor fill may treat it as a text box.
 */
export function isCombobox(element: Element): boolean {
  const autocomplete = element.getAttribute("aria-autocomplete");
  return (
    element.getAttribute("role") === "combobox" ||
    autocomplete === "list" ||
    autocomplete === "both" ||
    element.getAttribute("aria-haspopup") === "listbox"
  );
}

export type ScannedField = {
  descriptor: FieldDescriptor;
  target: ScanTarget;
  /** The descriptor minus its id, serialized. A different value at fill time means the field changed. */
  signature: string;
};

export type TargetState =
  | { kind: "usable" }
  | { kind: "blocked"; reason: "missing" | "hidden" | "disabled" | "read_only" };

const TEXT_TYPES: ReadonlyMap<string, TextControl> = new Map([
  ["", "text"],
  ["text", "text"],
  ["email", "email"],
  ["tel", "tel"],
  ["url", "url"],
  ["number", "number"],
  ["date", "date"],
]);

/** Content of these never counts as label text. */
const NON_LABEL_TAGS: ReadonlySet<string> = new Set([
  "input",
  "select",
  "textarea",
  "option",
  "script",
  "style",
  "button",
]);
const CAPTCHA_PATTERN = /captcha|recaptcha|hcaptcha|turnstile/i;
const CAPTCHA_LABEL = /captcha|characters (?:you see|shown|above|below)|not a robot/i;
const HONEYPOT_PATTERN = /honey|hpot|(?:^|[_-])hp(?:$|[_-])|bot[_-]?(?:trap|check|field)/i;
const HONEYPOT_LABEL =
  /\b(?:leave|keep) (?:this )?(?:field |box |input )?(?:blank|empty)\b|\bdo(?: not|n't) (?:fill|enter|type|complete)\b/i;

const MAX_LABEL = 500;
const MAX_OPTION = 300;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Text of a label-ish node, minus nested controls and anything hidden inside it. */
export function labelText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parts.push(child.textContent ?? "");
      else if (isElement(child)) {
        if (NON_LABEL_TAGS.has(child.localName)) continue;
        if (child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true") continue;
        walk(child);
      }
    }
  };
  walk(root);
  return collapse(parts.join(" ")).replace(/\s*\*+$/, "");
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function labelsOf(element: HTMLElement): Element[] {
  const found: Element[] = [];
  if (element.id !== "") {
    for (const label of element.ownerDocument.querySelectorAll("label")) {
      if (label.htmlFor === element.id) found.push(label);
    }
  }
  const wrapping = element.closest("label");
  if (wrapping !== null && !found.includes(wrapping)) found.push(wrapping);
  return found;
}

function ariaLabel(element: Element): string {
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter((id) => id !== "");
  const referenced = ids
    .map((id) => element.ownerDocument.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
    .map(labelText)
    .join(" ");
  if (collapse(referenced) !== "") return collapse(referenced);
  return collapse(element.getAttribute("aria-label") ?? "");
}

/** label[for], wrapping label, aria-labelledby, aria-label, then placeholder. */
function ownLabel(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const fromLabels = labelsOf(element)
    .map(labelText)
    .find((text) => text !== "");
  if (fromLabels !== undefined) return fromLabels;
  const aria = ariaLabel(element);
  if (aria !== "") return aria;
  return "placeholder" in element ? collapse(element.placeholder) : "";
}

/** A radio group is named by its fieldset legend, else its `role=radiogroup` container. */
function groupLabel(first: HTMLInputElement): string {
  const fieldset = first.closest("fieldset");
  const legend = fieldset === null ? undefined : Array.from(fieldset.children).find((c) => c.localName === "legend");
  if (legend !== undefined) {
    const text = labelText(legend);
    if (text !== "") return text;
  }
  const group = first.closest('[role="radiogroup"]');
  return group === null ? "" : ariaLabel(group);
}

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function attr(element: Element, name: string, max: number): string | null {
  const value = element.getAttribute(name)?.trim() ?? "";
  return value === "" ? null : cap(value, max);
}

function controlOf(target: ScanTarget): FieldControl {
  return target.kind === "text" ? target.control : target.kind;
}

export function primary(target: ScanTarget): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return target.kind === "radio" ? target.elements[0] : target.element;
}

function isRequired(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  return element.required || element.getAttribute("aria-required") === "true";
}

/** One option the descriptor offers, and the element it stands for. Fill writes the element. */
export type Choice<E extends HTMLOptionElement | HTMLInputElement> = { option: FieldOption; element: E };

/** Value of option `index` when the page's own values can't name each option apart. */
const optionToken = (index: number) => `opt:${index}`;

const hasDuplicates = (values: readonly string[]) => new Set(values).size !== values.length;

/**
 * A select's options. When two selectable options share a value, `select.value = v` would pick
 * whichever comes first, so every option is offered as a positional token instead. Options with
 * value "" are the placeholder and never get written, so they don't count as a clash.
 */
export function selectChoices(element: HTMLSelectElement): Choice<HTMLOptionElement>[] {
  const options = Array.from(element.options);
  const tokens = hasDuplicates(options.map((o) => o.value).filter((v) => v !== ""));
  return options
    .filter((o) => !o.disabled && (tokens || o.value.length <= MAX_OPTION))
    .slice(0, MAX_FIELD_OPTIONS)
    .map((o) => ({
      element: o,
      option: { value: tokens ? optionToken(o.index) : o.value, label: cap(collapse(o.label || o.text), MAX_OPTION) },
    }));
}

/**
 * A radio group's options. Radios without a `value` attribute all read as "on" (Ashby's EEOC
 * questions), and an empty value looks like a placeholder to the matcher: either way the raw
 * values can't name one radio, so every radio is offered as a positional token instead.
 */
export function radioChoices(radios: readonly HTMLInputElement[]): Choice<HTMLInputElement>[] {
  const values = radios.map((r) => r.value);
  const tokens = hasDuplicates(values) || values.some((v) => v.trim() === "");
  return radios
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => tokens || element.value.length <= MAX_OPTION)
    .slice(0, MAX_FIELD_OPTIONS)
    .map(({ element, index }) => ({
      element,
      option: {
        value: tokens ? optionToken(index) : element.value,
        label: cap(ownLabel(element) || element.value, MAX_OPTION),
      },
    }));
}

function optionsOf(target: ScanTarget): FieldOption[] {
  switch (target.kind) {
    case "select":
      return selectChoices(target.element).map((c) => c.option);
    case "radio":
      return radioChoices(target.elements).map((c) => c.option);
    case "text":
    case "textarea":
    case "checkbox":
    case "file":
    case "combobox":
      return [];
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** The descriptor for a target, without its id. Rebuilt at fill time to detect a changed field. */
export function describeTarget(target: ScanTarget): Omit<FieldDescriptor, "fieldId"> {
  const element = primary(target);
  return {
    control: controlOf(target),
    label: cap(target.kind === "radio" ? groupLabel(target.elements[0]) : ownLabel(element), MAX_LABEL),
    // A combobox's autocomplete token would only invite the matcher to plan a text fill.
    autocomplete: target.kind === "combobox" ? null : attr(element, "autocomplete", 100),
    name: attr(element, "name", 200),
    required: target.kind === "radio" ? target.elements.some(isRequired) : isRequired(element),
    options: optionsOf(target),
    adapterCategory: null,
  };
}

export function signatureOf(target: ScanTarget): string {
  return JSON.stringify(describeTarget(target));
}

// ---------- ATS adapter hints ----------

/**
 * What an ATS adapter knows about one control: a better label, and a category only when it is
 * certain. Never a value. `adapterCategory` counts as high confidence on the server.
 */
export type FieldHint = { adapterCategory?: PrefillCategory; labelOverride?: string };

/** A detected ATS (src/adapters). Hints change the outgoing descriptor only, never the signature. */
export type ScanAdapter = { id: Exclude<AdapterId, "generic">; hint: (target: ScanTarget) => FieldHint | null };

/** The writable option values are unique and non-empty, so a matched option names one control. */
function optionsWritable(options: readonly FieldOption[]): boolean {
  const values = options.map((o) => o.value).filter((v) => v !== "");
  return values.length > 0 && new Set(values).size === values.length;
}

/** Whether fill can write a category's answer into this control correctly. */
function takesCategory(target: ScanTarget, options: readonly FieldOption[]): boolean {
  switch (target.kind) {
    case "text":
    case "textarea":
    case "checkbox":
      return true;
    case "select":
    case "radio":
      return optionsWritable(options);
    case "file":
    case "combobox":
      return false;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/**
 * The descriptor with an adapter's hint applied. No hint at all for a field whose own label looks
 * like salary (no adapter can relabel it out of the salary block) or for a combobox (a cleaner
 * label would only make a widget fill can't drive look matchable). A category is dropped on a
 * control fill can't write it into, and on a label that (now) looks like salary.
 */
function withHint(
  described: Omit<FieldDescriptor, "fieldId">,
  target: ScanTarget,
  hint: FieldHint | null,
): Omit<FieldDescriptor, "fieldId"> {
  if (hint === null || isSalaryLabel(described.label) || isCombobox(primary(target))) return described;
  const override = cap(collapse(hint.labelOverride ?? ""), MAX_LABEL);
  const label = override === "" ? described.label : override;
  const category = hint.adapterCategory ?? null;
  const keep = category !== null && !isSalaryLabel(label) && takesCategory(target, described.options);
  return { ...described, label, adapterCategory: keep ? category : null };
}

// ---------- Visibility and editability ----------

function hiddenInTree(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") {
      return true;
    }
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.opacity === "0") return true;
    // `visibility` inherits, so the element's own computed value covers its ancestors.
    if (node === element && (style.visibility === "hidden" || style.visibility === "collapse")) return true;
  }
  return false;
}

function isShown(element: Element, measure: Measure): boolean {
  if (hiddenInTree(element)) return false;
  const box = measure(element);
  return box === null || !boxLooksHidden(box);
}

/**
 * Hidden on purpose, not just styled away: `hidden`, `inert`, `aria-hidden`, `display:none` or
 * `visibility:hidden` on the element itself. Opacity and size don't count here; a styled upload
 * button or label stands in for those.
 */
function removedByAuthor(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;
  if (
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return true;
  }
  const style = view.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
}

const UPLOAD_TRIGGER = 'button, [role="button"], a, label';

/**
 * The styled control an upload widget shows instead of its file input: the input's parent, when
 * it holds no other form control and is itself a button, link or label, or holds a shown one
 * (Greenhouse's "Attach" button, Lever's wrapping link, Ashby's dropzone). A form or section that
 * merely contains the input and some other button is not a wrapper.
 */
function uploadWrapperShown(input: Element, measure: Measure): boolean {
  const parent = input.parentElement;
  if (parent === null || !isShown(parent, measure)) return false;
  const controls = parent.querySelectorAll("input, select, textarea");
  if (controls.length !== 1 || controls[0] !== input) return false;
  if (parent.matches(UPLOAD_TRIGGER)) return true;
  return [...parent.querySelectorAll(UPLOAD_TRIGGER)].some((t) => isShown(t, measure));
}

/**
 * Toggles and file inputs are often visually hidden behind a styled label or upload button; a
 * shown label counts for both, and a shown upload wrapper counts for file inputs. Fail-closed:
 * the input must not be hidden by the author, and no ancestor may be hidden at all.
 */
function controlShown(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, measure: Measure) {
  if (isShown(element, measure)) return true;
  const parent = element.parentElement;
  if (parent === null || hiddenInTree(parent)) return false;
  // `type` is "select-one" or "textarea" for the other two, so these only admit inputs.
  if (element.type === "checkbox" || element.type === "radio") {
    return labelsOf(element).some((l) => isShown(l, measure));
  }
  if (element.type === "file") {
    if (removedByAuthor(element)) return false;
    return labelsOf(element).some((l) => isShown(l, measure)) || uploadWrapperShown(element, measure);
  }
  return false;
}

function elementState(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  measure: Measure,
): TargetState {
  if (!element.isConnected) return { kind: "blocked", reason: "missing" };
  if (!controlShown(element, measure)) return { kind: "blocked", reason: "hidden" };
  if (
    element.disabled ||
    element.closest("fieldset[disabled]") !== null ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    return { kind: "blocked", reason: "disabled" };
  }
  const readOnly = "readOnly" in element && element.readOnly;
  if (readOnly || element.getAttribute("aria-readonly") === "true") return { kind: "blocked", reason: "read_only" };
  return { kind: "usable" };
}

/** Whether a scanned control can be written now. A radio group needs every radio connected. */
export function targetState({ target, measure }: { target: ScanTarget; measure: Measure }): TargetState {
  if (target.kind !== "radio") return elementState(target.element, measure);
  if (target.elements.some((r) => !r.isConnected)) return { kind: "blocked", reason: "missing" };
  const states = target.elements.map((r) => elementState(r, measure));
  return states.find((s) => s.kind === "usable") ?? states[0] ?? { kind: "blocked", reason: "missing" };
}

/** One radio's state, for filling a specific choice. */
export function radioState({ radio, measure }: { radio: HTMLInputElement; measure: Measure }): TargetState {
  return elementState(radio, measure);
}

function looksLikeTrap(target: ScanTarget, label: string): boolean {
  const element = primary(target);
  const ownTokens = [element.getAttribute("name"), element.id, element.getAttribute("class")].join(" ");
  if (HONEYPOT_PATTERN.test(ownTokens) || HONEYPOT_LABEL.test(label)) return true;
  if (CAPTCHA_LABEL.test(label)) return true;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (CAPTCHA_PATTERN.test([node.getAttribute("name"), node.id, node.getAttribute("class")].join(" "))) return true;
  }
  // Text boxes taken out of the tab order are a classic honeypot. Radios use roving tabindex, so not those.
  const typing = target.kind === "text" || target.kind === "textarea" || target.kind === "combobox";
  return typing && element.tabIndex < 0 && element.hasAttribute("tabindex");
}

// ---------- Scan ----------

function inputTarget(input: HTMLInputElement): Exclude<ScanTarget, { kind: "radio" }> | "radio" | null {
  const type = (input.getAttribute("type") ?? "").trim().toLowerCase();
  const text = TEXT_TYPES.get(type);
  if (text !== undefined) return { kind: "text", control: text, element: input };
  if (type === "checkbox") return { kind: "checkbox", element: input };
  if (type === "file") return { kind: "file", element: input };
  if (type === "radio") return "radio";
  // password, hidden, search, submit, button, image, range, color, time, month, week, datetime-local…
  return null;
}

/** All radios sharing the input's form and name, in document order. A nameless radio is its own group. */
function radioGroup(first: HTMLInputElement, all: readonly HTMLInputElement[]): HTMLInputElement[] {
  if (first.name === "") return [first];
  return all.filter((r) => r.type === "radio" && r.name === first.name && r.form === first.form);
}

/** Random field id: 12 base64url characters. Not derived from anything on the page. */
export function newFieldId(): FieldId {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const text = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return FieldId.parse(text);
}

/** Scan the top document for visible, editable, supported controls. At most `MAX_PREFILL_FIELDS`. */
export function scanDocument({
  document,
  measure,
  makeId = newFieldId,
  adapter = null,
}: {
  document: Document;
  measure: Measure;
  makeId?: () => FieldId;
  /** Detected ATS, or null for the generic scan. */
  adapter?: ScanAdapter | null;
}): ScannedField[] {
  const view = document.defaultView;
  if (view === null) return [];
  const controls = Array.from(document.querySelectorAll("input, select, textarea"));
  const inputs = controls.filter((c): c is HTMLInputElement => c instanceof view.HTMLInputElement);
  const grouped = new Set<Element>();
  const ids = new Set<string>();
  const out: ScannedField[] = [];

  for (const control of controls) {
    if (out.length >= MAX_PREFILL_FIELDS) break;
    if (grouped.has(control)) continue;
    let target: ScanTarget | null = null;
    if (control instanceof view.HTMLInputElement) {
      const found = inputTarget(control);
      if (found === "radio") {
        const group = radioGroup(control, inputs);
        for (const radio of group) grouped.add(radio);
        const [first, ...rest] = group.filter((r) => elementState(r, measure).kind === "usable");
        target = first === undefined ? null : { kind: "radio", elements: [first, ...rest] };
      } else {
        target = found;
      }
    } else if (control instanceof view.HTMLTextAreaElement) {
      target = { kind: "textarea", element: control };
    } else if (control instanceof view.HTMLSelectElement && !control.multiple) {
      target = { kind: "select", element: control };
    }
    if (target !== null && target.kind !== "radio" && target.kind !== "file" && isCombobox(target.element)) {
      target = { kind: "combobox", element: target.element };
    }
    if (target === null || targetState({ target, measure }).kind !== "usable") continue;

    const described = describeTarget(target);
    if (looksLikeTrap(target, described.label)) continue;
    let fieldId = makeId();
    while (ids.has(fieldId)) fieldId = makeId();
    ids.add(fieldId);
    // The signature stays the generic description: fill rebuilds it without the adapter.
    const descriptor = { fieldId, ...withHint(described, target, adapter?.hint(target) ?? null) };
    out.push({ descriptor, target, signature: JSON.stringify(described) });
  }
  return out;
}
