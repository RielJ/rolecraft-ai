import type { Contact, StandardAnswers } from "@/shared/api";
import type { FactStatus, MustAnswer } from "@/shared/enums";
import {
  DECLINE_VALUE,
  type ExtensionOutputDto,
  type FieldDescriptor,
  type FieldMatch,
  type FieldOption,
  type FillValue,
  isSalaryLabel,
  PREFILL_CATEGORIES,
  PREFILL_CATEGORY_KEYS,
  type PreferenceDto,
  type PrefillCategory,
  type PrefillConfidence,
  type PrefillResponse,
  type Provenance,
  type ScanNonce,
  type TypedValue,
  typedValueFits,
  type Unresolved,
} from "@/shared/extension";

/**
 * The prefill matcher (docs/EXTENSION.md). Pure: the
 * service loads the layers, this decides which value, if any, each scanned field gets.
 *
 * Per field: a salary label or a file control is never filled; the category comes from an adapter
 * hint, `autocomplete` or input type (high) or a label alias (medium); then the first layer, in
 * precedence order, whose value fits the control wins. Profile free text (work authorization,
 * start date) only fills text controls; options, dates and checkboxes need a typed preference.
 */

// ---------- Input ----------

/** A profile fact the service tied to a category. Only `confirmed` facts are used. */
export type ProfileFact = { status: FactStatus; category: PrefillCategory; text: string };

export type PrefillProfile = {
  contact: Contact;
  /** `salary` is never read. */
  standardAnswers: StandardAnswers;
  facts: readonly ProfileFact[];
};

export type PrefillPreference = Pick<PreferenceDto, "id" | "category" | "typedValue" | "displayText">;

/** An output of the session's opportunity, with its body. Only included, current `answer` outputs are used. */
export type PrefillAnswer = Pick<
  ExtensionOutputDto,
  "id" | "kind" | "included" | "outdated" | "question" | "mustAnswer" | "generatedAt" | "reviewedAt"
> & { body: string | null };

export type PrefillInput = {
  nonce: ScanNonce;
  fields: readonly FieldDescriptor[];
  profile: PrefillProfile;
  jobPreferences: readonly PrefillPreference[];
  globalPreferences: readonly PrefillPreference[];
  answers: readonly PrefillAnswer[];
};

// ---------- Labels and categories ----------

/** Lowercase, drop "(required)", asterisks and punctuation (keeping `-` and `/`), collapse spaces. */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\((?:required|optional)\)/g, " ")
    .replace(/[^a-z0-9/\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXACT_ALIASES = new Map<string, PrefillCategory>();
/** Multi-word synonyms also match as a whole-word phrase inside a longer question. */
const PHRASE_ALIASES: { phrase: string; category: PrefillCategory }[] = [];
for (const category of PREFILL_CATEGORY_KEYS) {
  for (const synonym of PREFILL_CATEGORIES[category].labelSynonyms) {
    const phrase = normalizeLabel(synonym);
    EXACT_ALIASES.set(phrase, category);
    if (phrase.includes(" ")) PHRASE_ALIASES.push({ phrase, category });
  }
}

type LabelResolution = { kind: "match"; category: PrefillCategory } | { kind: "ambiguous" } | { kind: "none" };

function resolveLabel(label: string): LabelResolution {
  const normalized = normalizeLabel(label);
  if (normalized === "") return { kind: "none" };
  const exact = EXACT_ALIASES.get(normalized);
  if (exact !== undefined) return { kind: "match", category: exact };
  const padded = ` ${normalized} `;
  const found = new Set(PHRASE_ALIASES.filter((a) => padded.includes(` ${a.phrase} `)).map((a) => a.category));
  const [only] = found;
  if (only === undefined) return { kind: "none" };
  return found.size === 1 ? { kind: "match", category: only } : { kind: "ambiguous" };
}

/** `autocomplete` field names (the last token, after section and contact-type tokens) that are exact. */
const AUTOCOMPLETE = new Map<string, PrefillCategory>([
  ["given-name", "given_name"],
  ["family-name", "family_name"],
  ["name", "full_name"],
  ["email", "email"],
  ["tel", "phone"],
  ["tel-national", "phone"],
]);

function autocompleteCategory(autocomplete: string | null): PrefillCategory | null {
  const tokens = (autocomplete ?? "").toLowerCase().trim().split(/\s+/);
  const last = tokens.at(-1) === "webauthn" ? tokens.at(-2) : tokens.at(-1);
  return last === undefined ? null : (AUTOCOMPLETE.get(last) ?? null);
}

type CategoryResolution =
  | { kind: "resolved"; category: PrefillCategory; confidence: PrefillConfidence }
  | { kind: "unresolved"; reason: "unknown_label" | "low_confidence" };

function resolveCategory(field: FieldDescriptor): CategoryResolution {
  if (field.adapterCategory !== null) return { kind: "resolved", category: field.adapterCategory, confidence: "high" };
  const byAutocomplete = autocompleteCategory(field.autocomplete);
  if (byAutocomplete !== null) return { kind: "resolved", category: byAutocomplete, confidence: "high" };
  if (field.control === "email") return { kind: "resolved", category: "email", confidence: "high" };
  if (field.control === "tel") return { kind: "resolved", category: "phone", confidence: "high" };
  const byLabel = resolveLabel(field.label);
  switch (byLabel.kind) {
    case "match":
      return { kind: "resolved", category: byLabel.category, confidence: "medium" };
    case "ambiguous":
      return { kind: "unresolved", reason: "low_confidence" };
    case "none":
      return { kind: "unresolved", reason: "unknown_label" };
    default: {
      const _exhaustive: never = byLabel;
      return _exhaustive;
    }
  }
}

/** The label or, for a field the page left unlabelled, its `name` asks about pay. */
function isSalaryField(field: FieldDescriptor): boolean {
  if (isSalaryLabel(field.label)) return true;
  return field.name !== null && isSalaryLabel(field.name.replace(/[^A-Za-z0-9]+/g, " "));
}

// ---------- Candidates, in precedence order ----------

type Source = { kind: "text"; text: string } | { kind: "typed"; typedValue: TypedValue; displayText: string };
type Candidate = { provenance: Provenance; source: Source; needsReview: boolean };

function hostOf(link: string): string | null {
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(link) ? link : `https://${link}`);
  return url === null ? null : url.hostname.toLowerCase();
}

function onHost(link: string, domain: string): boolean {
  const host = hostOf(link);
  return host !== null && (host === domain || host.endsWith(`.${domain}`));
}

function isProfileLink(link: string): boolean {
  return onHost(link, "linkedin.com") || onHost(link, "github.com");
}

/** "Given Family" splits; anything else (one word, "Juan dela Cruz") is ambiguous and does not. */
function splitName(fullName: string): { given: string; family: string } | null {
  const [given, family, ...rest] = fullName.trim().split(/\s+/);
  if (given === undefined || given === "" || family === undefined || rest.length > 0) return null;
  return { given, family };
}

/** Profile free text for a category. `standardAnswers.salary` is not reachable from here. */
function profileText({ contact, standardAnswers }: PrefillProfile, category: PrefillCategory): string | undefined {
  switch (category) {
    case "given_name":
      return splitName(contact.fullName)?.given;
    case "family_name":
      return splitName(contact.fullName)?.family;
    case "full_name":
      return contact.fullName;
    case "email":
      return contact.email;
    case "phone":
      return contact.phone;
    case "location":
      return contact.location;
    case "linkedin":
      return contact.links.find((link) => onHost(link, "linkedin.com"));
    case "github":
      return contact.links.find((link) => onHost(link, "github.com"));
    case "website":
      return contact.links.find((link) => !isProfileLink(link));
    case "references":
      return standardAnswers.references;
    case "notice_period":
      return standardAnswers.notice;
    case "start_date":
      return standardAnswers.start_date;
    case "work_authorization":
      return standardAnswers.work_auth;
    case "portfolio":
    case "referral_source":
    case "requires_sponsorship":
    case "willing_to_relocate":
    case "work_arrangement":
    case "willing_to_travel":
    case "gender":
    case "race_ethnicity":
    case "veteran_status":
    case "disability_status":
      return undefined;
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

const MUST_ANSWER_CATEGORY = {
  salary: null,
  work_auth: "work_authorization",
  notice: "notice_period",
  start_date: "start_date",
  references: "references",
} as const satisfies Record<MustAnswer, PrefillCategory | null>;

/** The category an answer output answers, or null when it is salary, not an answer, or unclear. */
function answerCategory(answer: PrefillAnswer): PrefillCategory | null {
  if (answer.kind !== "answer" || answer.mustAnswer === "salary") return null;
  const question = answer.question ?? "";
  if (isSalaryLabel(question)) return null;
  // The question first: a `work_auth` output may be about sponsorship.
  const byQuestion = resolveLabel(question);
  if (byQuestion.kind === "match") return byQuestion.category;
  if (byQuestion.kind === "ambiguous" || answer.mustAnswer === null) return null;
  return MUST_ANSWER_CATEGORY[answer.mustAnswer];
}

/** Reviewed, and not redrafted since. Unparseable times count as not reviewed. */
function isReviewed({ reviewedAt, generatedAt }: PrefillAnswer): boolean {
  if (reviewedAt === null) return false;
  if (generatedAt === null) return true;
  return Date.parse(reviewedAt) >= Date.parse(generatedAt);
}

function preferenceCandidates(
  preferences: readonly PrefillPreference[],
  category: PrefillCategory,
  kind: "job_preference" | "global_preference",
): Candidate[] {
  return preferences
    .filter((p) => p.category === category && typedValueFits({ category, typedValue: p.typedValue }))
    .map((p) => ({
      provenance: { kind, preferenceId: p.id },
      source: { kind: "typed", typedValue: p.typedValue, displayText: p.displayText },
      needsReview: false,
    }));
}

function candidatesFor(input: PrefillInput, category: PrefillCategory): Candidate[] {
  const profileTexts = [
    profileText(input.profile, category),
    ...input.profile.facts.filter((f) => f.status === "confirmed" && f.category === category).map((f) => f.text),
  ];
  const profile: Candidate[] = profileTexts.flatMap((text) => {
    const trimmed = text?.trim() ?? "";
    return trimmed === ""
      ? []
      : [{ provenance: { kind: "profile" }, source: { kind: "text", text: trimmed }, needsReview: false }];
  });

  const generated: Candidate[] = input.answers.flatMap((answer) => {
    const body = answer.body?.trim() ?? "";
    if (!answer.included || answer.outdated || body === "" || answerCategory(answer) !== category) return [];
    return [
      {
        provenance: { kind: "generated", outputId: answer.id },
        source: { kind: "text", text: body },
        needsReview: !isReviewed(answer),
      },
    ];
  });
  // Stable: reviewed answers before unreviewed ones.
  generated.sort((a, b) => Number(a.needsReview) - Number(b.needsReview));

  return [
    ...profile,
    ...preferenceCandidates(input.jobPreferences, category, "job_preference"),
    ...preferenceCandidates(input.globalPreferences, category, "global_preference"),
    ...generated,
  ];
}

// ---------- Fitting a value to a control ----------

type ControlKind = "text" | "date" | "options" | "checkbox";

function controlKind(field: FieldDescriptor, category: PrefillCategory): ControlKind | null {
  switch (field.control) {
    case "text":
    case "email":
    case "tel":
    case "url":
    case "textarea":
      return "text";
    case "date":
      return "date";
    case "select":
    case "radio":
      return "options";
    case "checkbox":
      return PREFILL_CATEGORIES[category].valueType === "yesNo" && field.options.length === 0 ? "checkbox" : null;
    case "number":
    case "file":
    case "combobox":
      return null;
    default: {
      const _exhaustive: never = field.control;
      return _exhaustive;
    }
  }
}

type Fit =
  | { kind: "fill"; value: FillValue; displayText: string }
  | { kind: "miss"; reason: "no_value" | "no_matching_option" };

const NO_VALUE: Fit = { kind: "miss", reason: "no_value" };

const DECLINE =
  /\b(?:decline|prefer not|rather not|choose not|(?:do not|don t|dont) (?:wish|want)|not (?:to )?(?:say|answer|disclose|self identify))\b/;
const YES = /^(?:yes|y|true)\b/;
const NO = /^(?:no|n|false)\b/;
const YES_NO_PATTERNS = { yes: YES, no: NO };

type Specs = typeof PREFILL_CATEGORIES;
type ChoiceCategory = { [K in PrefillCategory]: Specs[K] extends { valueType: "choice" } ? K : never }[PrefillCategory];
type ChoiceOf<K extends ChoiceCategory> = Specs[K] extends { choices: readonly (infer C extends string)[] } ? C : never;

/** How an option label reads for each stored choice. Decline is shared (`DECLINE`). */
const CHOICE_PATTERNS = {
  gender: { female: /^(?:female|woman)\b/, male: /^(?:male|man)\b/, non_binary: /\bnon[- ]?binary\b/ },
  race_ethnicity: {
    hispanic_latino: /^(?:hispanic|latin[oax])\b/,
    white: /^white\b/,
    black: /^(?:black|african american)\b/,
    asian: /^asian\b/,
    american_indian_alaska_native: /^(?:american indian|alaska)/,
    native_hawaiian_pacific_islander: /^(?:native hawaiian|pacific islander)/,
    two_or_more: /^two or more\b/,
  },
  veteran_status: {
    not_protected_veteran: /\bnot an? (?:protected )?veteran\b/,
    protected_veteran: /^(?!.*\bnot\b).*\bprotected veteran\b/,
  },
  disability_status: YES_NO_PATTERNS,
  work_arrangement: { remote: /\bremote\b/, hybrid: /\bhybrid\b/, onsite: /\b(?:on-?site|on site|in-?office)\b/ },
} as const satisfies { [K in ChoiceCategory]: Record<Exclude<ChoiceOf<K>, typeof DECLINE_VALUE>, RegExp> };

function choicePatterns(category: PrefillCategory): [string, RegExp][] {
  const table: Partial<Record<PrefillCategory, Readonly<Record<string, RegExp>>>> = CHOICE_PATTERNS;
  return Object.entries(table[category] ?? {});
}

/** The one value an option reads as, or null when it reads as none or several. Decline wins. */
function classifyOption(text: string, patterns: [string, RegExp][]): string | null {
  if (DECLINE.test(text)) return DECLINE_VALUE;
  const hits = patterns.filter(([, pattern]) => pattern.test(text));
  const [hit] = hits;
  return hits.length === 1 && hit !== undefined ? hit[0] : null;
}

function optionText(option: FieldOption): string {
  return normalizeLabel(option.label) || normalizeLabel(option.value);
}

function isPlaceholder(option: FieldOption): boolean {
  return (
    option.value.trim() === "" || /^(?:select|choose|please (?:select|choose))\b/.test(normalizeLabel(option.label))
  );
}

/** Exactly one real option must match; otherwise nothing is chosen. */
function pickOption(options: readonly FieldOption[], matches: (text: string) => boolean): Fit {
  const hits = options.filter((option) => !isPlaceholder(option) && matches(optionText(option)));
  const [hit] = hits;
  if (hits.length !== 1 || hit === undefined) return { kind: "miss", reason: "no_matching_option" };
  return { kind: "fill", value: { kind: "option", value: hit.value }, displayText: hit.label.trim() || hit.value };
}

function fitOptions(field: FieldDescriptor, category: PrefillCategory, source: Source): Fit {
  if (source.kind === "text") {
    // Free text only picks an option for text categories, and only on an exact label.
    if (PREFILL_CATEGORIES[category].valueType !== "text") return NO_VALUE;
    const wanted = normalizeLabel(source.text);
    return pickOption(field.options, (text) => text === wanted);
  }
  const { typedValue } = source;
  switch (typedValue.valueType) {
    case "text": {
      const wanted = normalizeLabel(typedValue.value);
      return pickOption(field.options, (text) => text === wanted);
    }
    case "yesNo": {
      const wanted = typedValue.value ? "yes" : "no";
      return pickOption(field.options, (text) => classifyOption(text, Object.entries(YES_NO_PATTERNS)) === wanted);
    }
    case "choice": {
      const patterns = choicePatterns(category);
      return pickOption(field.options, (text) => classifyOption(text, patterns) === typedValue.value);
    }
    case "date":
      return { kind: "miss", reason: "no_matching_option" };
    default: {
      const _exhaustive: never = typedValue;
      return _exhaustive;
    }
  }
}

function fit(field: FieldDescriptor, kind: ControlKind, category: PrefillCategory, source: Source): Fit {
  switch (kind) {
    case "text": {
      const text = source.kind === "text" ? source.text : source.displayText;
      return { kind: "fill", value: { kind: "text", text }, displayText: text };
    }
    case "date":
      return source.kind === "typed" && source.typedValue.valueType === "date"
        ? { kind: "fill", value: { kind: "text", text: source.typedValue.value }, displayText: source.displayText }
        : NO_VALUE;
    case "checkbox":
      return source.kind === "typed" && source.typedValue.valueType === "yesNo"
        ? {
            kind: "fill",
            value: { kind: "checked", checked: source.typedValue.value },
            displayText: source.displayText,
          }
        : NO_VALUE;
    case "options":
      return fitOptions(field, category, source);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// ---------- Matcher ----------

type FieldResult = { kind: "match"; match: FieldMatch } | { kind: "unresolved"; unresolved: Unresolved };

function unresolved(
  field: FieldDescriptor,
  reason: Unresolved["reason"],
  category: PrefillCategory | null,
): FieldResult {
  return { kind: "unresolved", unresolved: { fieldId: field.fieldId, reason, category } };
}

function matchField(input: PrefillInput, field: FieldDescriptor): FieldResult {
  if (isSalaryField(field)) return unresolved(field, "salary", null);
  if (field.control === "file") return unresolved(field, "file_field", null);
  // Before any category or label match: whatever it asks, typing into it selects nothing.
  if (field.control === "combobox") return unresolved(field, "unsupported_control", null);

  const resolution = resolveCategory(field);
  if (resolution.kind === "unresolved") return unresolved(field, resolution.reason, null);
  const { category, confidence } = resolution;

  const kind = controlKind(field, category);
  if (kind === null) return unresolved(field, "unsupported_control", category);

  let reason: "no_value" | "no_matching_option" = "no_value";
  for (const candidate of candidatesFor(input, category)) {
    const result = fit(field, kind, category, candidate.source);
    if (result.kind === "fill") {
      const match: FieldMatch = {
        fieldId: field.fieldId,
        category,
        confidence,
        provenance: candidate.provenance,
        value: result.value,
        displayText: result.displayText,
        needsReview: candidate.needsReview,
        needsConfirmation: PREFILL_CATEGORIES[category].sensitive,
      };
      return { kind: "match", match };
    }
    if (result.reason === "no_matching_option") reason = result.reason;
  }
  return unresolved(field, reason, category);
}

/** Matches every field to at most one value. Matches and unresolved fields keep the scan's order. */
export function matchPrefill(input: PrefillInput): PrefillResponse {
  const matches: FieldMatch[] = [];
  const unresolvedFields: Unresolved[] = [];
  for (const field of input.fields) {
    const result = matchField(input, field);
    if (result.kind === "match") matches.push(result.match);
    else unresolvedFields.push(result.unresolved);
  }
  return { nonce: input.nonce, matches, unresolved: unresolvedFields };
}
