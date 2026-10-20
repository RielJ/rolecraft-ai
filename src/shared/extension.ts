import { z } from "zod";
import { ERROR_CODES, OpportunityId, OutputId, PasteJobInput } from "./api";
import { MustAnswer, OpportunityStatus, OutputKind } from "./enums";

// Contracts shared by the server, the SPA and the Chrome extension (docs/EXTENSION.md).
// Every string and array is capped; test/extension-contracts.test.ts walks the exports to enforce it.
// Schemas that cross the content-script boundary are strict, so an unknown key (a selector, a
// script) is a parse error rather than silently dropped.

// ---------- Ids and shared atoms ----------

export const PairingId = z.uuid().brand<"PairingId">();
export type PairingId = z.infer<typeof PairingId>;
export const ApplicationSessionId = z.uuid().brand<"ApplicationSessionId">();
export type ApplicationSessionId = z.infer<typeof ApplicationSessionId>;
export const PreferenceId = z.uuid().brand<"PreferenceId">();
export type PreferenceId = z.infer<typeof PreferenceId>;

/** Ephemeral id the content script gives a form control for one scan. Never a selector. */
export const FieldId = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .brand<"FieldId">();
export type FieldId = z.infer<typeof FieldId>;

/** Per-scan random value; the worker drops fill and attach messages whose nonce is not the current scan's. */
export const ScanNonce = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]{16,64}$/)
  .brand<"ScanNonce">();
export type ScanNonce = z.infer<typeof ScanNonce>;

const IsoDateTime = z.iso.datetime();
const MAX_URL = 2000;
const HttpUrl = z.url({ protocol: /^https?$/ }).max(MAX_URL);
const Title = z.string().max(300);

// ---------- Limits ----------

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const APPLICATION_SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_PREFILL_FIELDS = 200;
export const MAX_FIELD_OPTIONS = 200;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DIAGNOSTICS_LIMIT = 50;

// ---------- Endpoint ----------

export const DEFAULT_EXTENSION_ENDPOINT = "http://localhost:3000";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin of `raw` when it is a bare origin on loopback HTTP or on HTTPS, else null. A path,
 * query, fragment or credentials are rejected so the endpoint is exactly one origin to grant.
 */
export function endpointOrigin(raw: string): string | null {
  const url = URL.parse(raw);
  if (url === null) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/** The Hanapbuhay server the extension talks to, normalized to its origin. */
export const ExtensionEndpoint = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((raw, ctx) => {
    const origin = endpointOrigin(raw);
    if (origin === null) {
      ctx.issues.push({
        code: "custom",
        input: raw,
        message: "Use http://localhost, http://127.0.0.1 or http://[::1] with a port, or an https:// address.",
      });
      return z.NEVER;
    }
    return origin;
  })
  .pipe(z.string().max(300).brand<"ExtensionEndpoint">());
export type ExtensionEndpoint = z.infer<typeof ExtensionEndpoint>;

// ---------- Pairing ----------

/** Crockford-style alphabet: no 0/O, 1/I/L or U, so a code read off the screen types back cleanly. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

/** A one-time pairing code as typed: case, spaces and the middle dash are ignored. */
export const PairingCode = z
  .string()
  .max(20)
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
  .pipe(
    z
      .string()
      .max(PAIRING_CODE_LENGTH)
      .regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`), "Enter the 8-character code.")
      .brand<"PairingCode">(),
  );
export type PairingCode = z.infer<typeof PairingCode>;

/** `chrome-extension://<32 letters a-p>`, the origin a pairing binds to on claim. */
export const ExtensionOrigin = z
  .string()
  .max(60)
  .regex(/^chrome-extension:\/\/[a-p]{32}$/);
export type ExtensionOrigin = z.infer<typeof ExtensionOrigin>;

/** Bearer token: 32 random bytes, base64url. Only its hash is stored. */
export const PairingToken = z
  .string()
  .max(43)
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand<"PairingToken">();
export type PairingToken = z.infer<typeof PairingToken>;

/** `POST /api/extension-web/pairings`: the SPA asks for a code. The origin binds at claim time. */
export const CreatePairingInput = z.strictObject({});
export type CreatePairingInput = z.infer<typeof CreatePairingInput>;

/** A pairing as the SPA lists it. Carries no code or token material. */
export const PairingDto = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting"), id: PairingId, createdAt: IsoDateTime, codeExpiresAt: IsoDateTime }),
  z.object({
    status: z.literal("active"),
    id: PairingId,
    createdAt: IsoDateTime,
    extensionOrigin: ExtensionOrigin,
    claimedAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
  }),
  z.object({ status: z.literal("expired"), id: PairingId, createdAt: IsoDateTime }),
  z.object({
    status: z.literal("revoked"),
    id: PairingId,
    createdAt: IsoDateTime,
    extensionOrigin: ExtensionOrigin.nullable(),
    revokedAt: IsoDateTime,
  }),
]);
export type PairingDto = z.infer<typeof PairingDto>;

export const PairingList = z.object({ pairings: z.array(PairingDto).max(100) });
export type PairingList = z.infer<typeof PairingList>;

/** The code is shown once, as `ABCD-EFGH`. */
export const CreatePairingResult = z.object({
  pairing: PairingDto,
  code: z
    .string()
    .max(9)
    .regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{4}-[${PAIRING_CODE_ALPHABET}]{4}$`)),
});
export type CreatePairingResult = z.infer<typeof CreatePairingResult>;

/** `POST /api/extension/pair/claim`. The extension origin comes from the `Origin` header. */
export const ClaimPairingInput = z.strictObject({ code: PairingCode });
export type ClaimPairingInput = z.infer<typeof ClaimPairingInput>;

export const ClaimPairingResult = z.object({ pairingId: PairingId, token: PairingToken });
export type ClaimPairingResult = z.infer<typeof ClaimPairingResult>;

export const PingResult = z.object({ ok: z.literal(true), pairingId: PairingId });
export type PingResult = z.infer<typeof PingResult>;

// ---------- Application sessions ----------

export const APPLICATION_SESSION_STATUSES = ["pending", "claimed", "completed", "expired"] as const;
export const ApplicationSessionStatus = z.enum(APPLICATION_SESSION_STATUSES);
export type ApplicationSessionStatus = z.infer<typeof ApplicationSessionStatus>;

/** `POST /api/extension-web/sessions`: the workspace Apply button. */
export const CreateSessionInput = z.strictObject({ opportunityId: OpportunityId });
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export const ApplicationSessionDto = z.object({
  id: ApplicationSessionId,
  opportunityId: OpportunityId,
  status: ApplicationSessionStatus,
  applyUrl: z.string().max(MAX_URL),
  /** `applyUrlKey(applyUrl)` from src/domain/dedup.ts. */
  applyUrlKey: z.string().max(4000),
  title: Title,
  company: Title,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  claimedAt: IsoDateTime.nullable(),
});
export type ApplicationSessionDto = z.infer<typeof ApplicationSessionDto>;

export const CreateSessionResult = z.object({ session: ApplicationSessionDto });
export type CreateSessionResult = z.infer<typeof CreateSessionResult>;

/** `GET /api/extension/sessions/active`. */
export const ActiveSessionResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("active"), session: ApplicationSessionDto }),
]);
export type ActiveSessionResponse = z.infer<typeof ActiveSessionResponse>;

/** `POST /api/extension/sessions/:id/claim`. A URL mismatch is `409 url_mismatch` unless confirmed. */
export const ClaimSessionInput = z.strictObject({
  tabUrl: HttpUrl,
  confirmMismatch: z.boolean().default(false),
});
export type ClaimSessionInput = z.infer<typeof ClaimSessionInput>;

/** `details` of a `409 url_mismatch` answer. */
export const UrlMismatchDetails = z.object({
  sessionUrlKey: z.string().max(4000),
  tabUrlKey: z.string().max(4000).nullable(),
});
export type UrlMismatchDetails = z.infer<typeof UrlMismatchDetails>;

export const ClaimSessionResult = z.object({ session: ApplicationSessionDto });
export type ClaimSessionResult = z.infer<typeof ClaimSessionResult>;

// ---------- Lookup and import ----------

/** `GET /api/extension/opportunities/by-url?url=`. Read-only. */
export const LookupQuery = z.strictObject({ url: HttpUrl });
export type LookupQuery = z.infer<typeof LookupQuery>;

export const LookupResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("found"),
    opportunityId: OpportunityId.nullable(),
    title: Title,
    company: Title,
    /** Null when the job is known but not on the board. */
    status: OpportunityStatus.nullable(),
  }),
]);
export type LookupResult = z.infer<typeof LookupResult>;

/** `POST /api/extension/import`: the visible page, edited by the user. Goes through `addPastedJob`. */
export const ImportJobInput = PasteJobInput.extend({ url: HttpUrl });
export type ImportJobInput = z.infer<typeof ImportJobInput>;

// ---------- Categories ----------

export const PREFILL_GROUPS = ["basics", "eligibility", "voluntary_identity"] as const;
export const PrefillGroup = z.enum(PREFILL_GROUPS);
export type PrefillGroup = z.infer<typeof PrefillGroup>;

export const PREFILL_VALUE_TYPES = ["text", "yesNo", "date", "choice"] as const;
export const PrefillValueType = z.enum(PREFILL_VALUE_TYPES);
export type PrefillValueType = z.infer<typeof PrefillValueType>;

/** Stored choice for "I don't wish to answer" on every voluntary identity category. */
export const DECLINE_VALUE = "decline";

/** Mirrored by a CHECK constraint on `application_preferences.category`. No salary or compensation key, ever. */
export const PREFILL_CATEGORY_KEYS = [
  "given_name",
  "family_name",
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
  "website",
  "references",
  "referral_source",
  "work_authorization",
  "requires_sponsorship",
  "notice_period",
  "start_date",
  "willing_to_relocate",
  "work_arrangement",
  "willing_to_travel",
  "gender",
  "race_ethnicity",
  "veteran_status",
  "disability_status",
] as const;
export const PrefillCategory = z.enum(PREFILL_CATEGORY_KEYS);
export type PrefillCategory = z.infer<typeof PrefillCategory>;

type CategorySpecBase = {
  readonly group: PrefillGroup;
  /** Needs the per-application confirmation checklist before it fills. */
  readonly sensitive: boolean;
  /** Normalized (lowercase, trimmed) labels that match with medium confidence. Unique across categories. */
  readonly labelSynonyms: readonly string[];
};
export type PrefillCategorySpec = CategorySpecBase &
  (
    | { readonly valueType: "text" | "yesNo" | "date" }
    | { readonly valueType: "choice"; readonly choices: readonly [string, ...string[]] }
  );

export const PREFILL_CATEGORIES = {
  given_name: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["first name", "given name", "forename", "legal first name"],
  },
  family_name: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["last name", "family name", "surname", "legal last name"],
  },
  full_name: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["full name", "name", "your name", "legal name", "full legal name"],
  },
  email: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["email", "email address", "e-mail", "e-mail address"],
  },
  phone: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["phone", "phone number", "mobile", "mobile number", "telephone", "contact number"],
  },
  location: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["location", "current location", "city", "current city", "where are you based"],
  },
  linkedin: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["linkedin", "linkedin profile", "linkedin url"],
  },
  github: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["github", "github profile", "github url"],
  },
  portfolio: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["portfolio", "portfolio url", "portfolio link"],
  },
  website: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["website", "personal website", "other website", "blog"],
  },
  references: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["references", "professional references"],
  },
  referral_source: {
    group: "basics",
    valueType: "text",
    sensitive: false,
    labelSynonyms: [
      "how did you hear about us",
      "how did you hear about this job",
      "where did you hear about us",
      "referral source",
    ],
  },
  work_authorization: {
    group: "eligibility",
    valueType: "yesNo",
    sensitive: true,
    labelSynonyms: [
      "work authorization",
      "authorized to work",
      "legally authorized to work",
      "right to work",
      "eligible to work",
    ],
  },
  requires_sponsorship: {
    group: "eligibility",
    valueType: "yesNo",
    sensitive: true,
    labelSynonyms: [
      "sponsorship",
      "require sponsorship",
      "need sponsorship",
      "visa sponsorship",
      "require visa sponsorship",
    ],
  },
  notice_period: {
    group: "eligibility",
    valueType: "text",
    sensitive: false,
    labelSynonyms: ["notice period", "notice", "how much notice"],
  },
  start_date: {
    group: "eligibility",
    valueType: "date",
    sensitive: false,
    labelSynonyms: ["start date", "earliest start date", "when can you start", "date available"],
  },
  willing_to_relocate: {
    group: "eligibility",
    valueType: "yesNo",
    sensitive: false,
    labelSynonyms: ["relocate", "willing to relocate", "open to relocation", "relocation"],
  },
  work_arrangement: {
    group: "eligibility",
    valueType: "choice",
    choices: ["remote", "hybrid", "onsite"],
    sensitive: false,
    labelSynonyms: ["work arrangement", "preferred work arrangement", "work setup", "work location preference"],
  },
  willing_to_travel: {
    group: "eligibility",
    valueType: "yesNo",
    sensitive: false,
    labelSynonyms: ["travel", "willing to travel", "able to travel"],
  },
  gender: {
    group: "voluntary_identity",
    valueType: "choice",
    choices: ["female", "male", "non_binary", DECLINE_VALUE],
    sensitive: true,
    labelSynonyms: ["gender", "gender identity", "sex"],
  },
  race_ethnicity: {
    group: "voluntary_identity",
    valueType: "choice",
    choices: [
      "hispanic_latino",
      "white",
      "black",
      "asian",
      "american_indian_alaska_native",
      "native_hawaiian_pacific_islander",
      "two_or_more",
      DECLINE_VALUE,
    ],
    sensitive: true,
    labelSynonyms: ["race", "ethnicity", "race/ethnicity", "race or ethnicity", "hispanic or latino"],
  },
  veteran_status: {
    group: "voluntary_identity",
    valueType: "choice",
    choices: ["protected_veteran", "not_protected_veteran", DECLINE_VALUE],
    sensitive: true,
    labelSynonyms: ["veteran status", "veteran", "protected veteran"],
  },
  disability_status: {
    group: "voluntary_identity",
    valueType: "choice",
    choices: ["yes", "no", DECLINE_VALUE],
    sensitive: true,
    labelSynonyms: ["disability", "disability status", "do you have a disability"],
  },
} as const satisfies { readonly [K in PrefillCategory]: PrefillCategorySpec };

/**
 * Labels that ask about pay. A matching field is never filled, whatever its category.
 * Word boundaries keep "Corporate", "Accurate", "Payroll", "PayPal" and "Payment" out. Bare
 * "rate" and "pay" still catch unrelated questions such as "Rate your English": the field is
 * left blank and listed, which fails safe. ASCII only; non-English salary labels are not covered.
 */
export const SALARY_LABEL_PATTERN =
  /\b(?:salar(?:y|ies)|compensation|pay|rates?|wages?|remuneration|ctc|income|stipends?|ote)\b/i;

export function isSalaryLabel(label: string): boolean {
  return SALARY_LABEL_PATTERN.test(label);
}

// ---------- Preferences ----------

const ChoiceValue = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/);

/** A saved answer's machine value. The category decides which variant is allowed. */
export const TypedValue = z.discriminatedUnion("valueType", [
  z.strictObject({ valueType: z.literal("text"), value: z.string().trim().min(1).max(2000) }),
  z.strictObject({ valueType: z.literal("yesNo"), value: z.boolean() }),
  z.strictObject({ valueType: z.literal("date"), value: z.iso.date() }),
  z.strictObject({ valueType: z.literal("choice"), value: ChoiceValue }),
]);
export type TypedValue = z.infer<typeof TypedValue>;

/** True when `typedValue` has the category's value type and, for choices, one of its choices. */
export function typedValueFits({
  category,
  typedValue,
}: {
  category: PrefillCategory;
  typedValue: TypedValue;
}): boolean {
  const spec: PrefillCategorySpec = PREFILL_CATEGORIES[category];
  if (spec.valueType !== typedValue.valueType) return false;
  if (spec.valueType === "choice" && typedValue.valueType === "choice") return spec.choices.includes(typedValue.value);
  return true;
}

export const PreferenceScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("opportunity"), opportunityId: OpportunityId }),
]);
export type PreferenceScope = z.infer<typeof PreferenceScope>;

const DisplayText = z.string().trim().min(1).max(2000);

/** `PUT /api/extension/preferences`: upsert by category and scope. Only sent on an explicit save. */
export const PreferenceInput = z
  .strictObject({ category: PrefillCategory, typedValue: TypedValue, displayText: DisplayText, scope: PreferenceScope })
  .refine(typedValueFits, { path: ["typedValue"], message: "That value does not fit this question." });
export type PreferenceInput = z.infer<typeof PreferenceInput>;

export const PreferenceDto = z.object({
  id: PreferenceId,
  category: PrefillCategory,
  typedValue: TypedValue,
  displayText: z.string().max(2000),
  scope: PreferenceScope,
  updatedAt: IsoDateTime,
});
export type PreferenceDto = z.infer<typeof PreferenceDto>;

export const PreferenceList = z.object({ preferences: z.array(PreferenceDto).max(2000) });
export type PreferenceList = z.infer<typeof PreferenceList>;

// ---------- Fields and prefill ----------

export const FIELD_CONTROLS = [
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "file",
  /**
   * A type-ahead widget (role=combobox, aria-autocomplete list|both, aria-haspopup=listbox) whose
   * options are not in the page. Typing text selects nothing, so it is reported but never filled.
   */
  "combobox",
] as const;
export const FieldControl = z.enum(FIELD_CONTROLS);
export type FieldControl = z.infer<typeof FieldControl>;

export const ADAPTER_IDS = ["generic", "greenhouse", "lever", "ashby"] as const;
export const AdapterId = z.enum(ADAPTER_IDS);
export type AdapterId = z.infer<typeof AdapterId>;

export const FieldOption = z.strictObject({ value: z.string().max(300), label: z.string().max(300) });
export type FieldOption = z.infer<typeof FieldOption>;

/** What the content script reports about one visible, editable control. */
export const FieldDescriptor = z.strictObject({
  fieldId: FieldId,
  control: FieldControl,
  /** Resolved from label[for], wrapping label, aria-labelledby, aria-label or fieldset legend. */
  label: z.string().max(500),
  autocomplete: z.string().max(100).nullable(),
  name: z.string().max(200).nullable(),
  required: z.boolean(),
  options: z.array(FieldOption).max(MAX_FIELD_OPTIONS),
  /** Set by a tested ATS adapter; counts as high confidence. */
  adapterCategory: PrefillCategory.nullable(),
});
export type FieldDescriptor = z.infer<typeof FieldDescriptor>;

/** What to put in a control. `file` controls never get one. */
export const FillValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().max(10_000) }),
  z.strictObject({ kind: z.literal("option"), value: z.string().max(300) }),
  z.strictObject({ kind: z.literal("checked"), checked: z.boolean() }),
]);
export type FillValue = z.infer<typeof FillValue>;

export const PREFILL_CONFIDENCES = ["high", "medium"] as const;
export const PrefillConfidence = z.enum(PREFILL_CONFIDENCES);
export type PrefillConfidence = z.infer<typeof PrefillConfidence>;

/** Precedence order, strongest first. */
export const PREFILL_PROVENANCES = ["profile", "job_preference", "global_preference", "generated"] as const;
export const Provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile") }),
  z.object({ kind: z.literal("job_preference"), preferenceId: PreferenceId }),
  z.object({ kind: z.literal("global_preference"), preferenceId: PreferenceId }),
  z.object({ kind: z.literal("generated"), outputId: OutputId }),
]);
export type Provenance = z.infer<typeof Provenance>;

export const FieldMatch = z.object({
  fieldId: FieldId,
  category: PrefillCategory,
  confidence: PrefillConfidence,
  provenance: Provenance,
  value: FillValue,
  /** What the panel shows; may differ from `value` for options. */
  displayText: z.string().max(10_000),
  /** A generated answer not yet reviewed: never preselected, fills only after the user accepts it. */
  needsReview: z.boolean(),
  /** A sensitive category: blocked until the application's checklist is confirmed. */
  needsConfirmation: z.boolean(),
});
export type FieldMatch = z.infer<typeof FieldMatch>;

export const UNRESOLVED_REASONS = [
  "unknown_label",
  "low_confidence",
  "no_value",
  "salary",
  "file_field",
  "no_matching_option",
  "unsupported_control",
] as const;
export const UnresolvedReason = z.enum(UNRESOLVED_REASONS);
export type UnresolvedReason = z.infer<typeof UnresolvedReason>;

export const Unresolved = z.object({
  fieldId: FieldId,
  reason: UnresolvedReason,
  category: PrefillCategory.nullable(),
});
export type Unresolved = z.infer<typeof Unresolved>;

/** `POST /api/extension/sessions/:id/prefill`. */
export const PrefillRequest = z.strictObject({
  nonce: ScanNonce,
  fields: z.array(FieldDescriptor).max(MAX_PREFILL_FIELDS),
});
export type PrefillRequest = z.infer<typeof PrefillRequest>;

export const PrefillResponse = z.object({
  nonce: ScanNonce,
  matches: z.array(FieldMatch).max(MAX_PREFILL_FIELDS),
  unresolved: z.array(Unresolved).max(MAX_PREFILL_FIELDS),
});
export type PrefillResponse = z.infer<typeof PrefillResponse>;

export const FillEntry = z.strictObject({ fieldId: FieldId, value: FillValue });
export type FillEntry = z.infer<typeof FillEntry>;

/** What the worker sends the content script to write. Keyed by field id: no selectors, no code. */
export const FillPlan = z.strictObject({
  nonce: ScanNonce,
  entries: z.array(FillEntry).max(MAX_PREFILL_FIELDS),
});
export type FillPlan = z.infer<typeof FillPlan>;

export const FILL_SKIP_REASONS = [
  "not_empty",
  "hidden",
  "disabled",
  "read_only",
  "stale",
  "missing",
  "salary",
  "file_field",
  "no_matching_option",
] as const;
export const FillSkipReason = z.enum(FILL_SKIP_REASONS);
export type FillSkipReason = z.infer<typeof FillSkipReason>;

export const FillResult = z.strictObject({
  nonce: ScanNonce,
  filled: z.array(FieldId).max(MAX_PREFILL_FIELDS),
  skipped: z.array(z.strictObject({ fieldId: FieldId, reason: FillSkipReason })).max(MAX_PREFILL_FIELDS),
});
export type FillResult = z.infer<typeof FillResult>;

// ---------- Materials, attach, applied ----------

/** An output as the panel lists it: no body. */
export const ExtensionOutputDto = z.object({
  id: OutputId,
  kind: OutputKind,
  included: z.boolean(),
  question: z.string().max(1000).nullable(),
  mustAnswer: MustAnswer.nullable(),
  generatedAt: IsoDateTime.nullable(),
  editedAt: IsoDateTime.nullable(),
  /** Null until "Mark reviewed"; cleared when a draft rewrites the body. */
  reviewedAt: IsoDateTime.nullable(),
  outdated: z.boolean(),
});
export type ExtensionOutputDto = z.infer<typeof ExtensionOutputDto>;

export const ExtensionOutputList = z.object({ outputs: z.array(ExtensionOutputDto).max(100) });
export type ExtensionOutputList = z.infer<typeof ExtensionOutputList>;

/** Panel to worker: attach this output's PDF to this empty file input. */
export const AttachRequest = z.strictObject({
  sessionId: ApplicationSessionId,
  outputId: OutputId,
  fieldId: FieldId,
  nonce: ScanNonce,
});
export type AttachRequest = z.infer<typeof AttachRequest>;

export const ATTACH_REJECT_REASONS = ["not_empty", "stale", "not_file_input", "too_large", "wrong_type"] as const;
export const AttachRejectReason = z.enum(ATTACH_REJECT_REASONS);
export type AttachRejectReason = z.infer<typeof AttachRejectReason>;

const AttachFileName = z
  .string()
  .min(5)
  .max(120)
  .regex(/^[A-Za-z0-9 ._()-]+\.pdf$/);

export const SUCCESS_REASONS = ["confirmation_url", "confirmation_text", "form_gone"] as const;
export const SuccessReason = z.enum(SUCCESS_REASONS);
export type SuccessReason = z.infer<typeof SuccessReason>;

/** `POST /api/extension/sessions/:id/confirm-applied`: only after the user answers Yes. */
export const ConfirmAppliedInput = z.strictObject({ reason: SuccessReason.nullable() });
export type ConfirmAppliedInput = z.infer<typeof ConfirmAppliedInput>;

export const ConfirmAppliedResult = z.object({
  opportunityId: OpportunityId,
  status: OpportunityStatus,
  /** False when it was already Applied or later (the call is idempotent). */
  changed: z.boolean(),
});
export type ConfirmAppliedResult = z.infer<typeof ConfirmAppliedResult>;

// ---------- Runtime messages (worker <-> content script) ----------

export const RuntimeMessage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scan"), nonce: ScanNonce }),
  z.strictObject({
    kind: z.literal("scan_result"),
    nonce: ScanNonce,
    url: HttpUrl,
    adapter: AdapterId,
    fields: z.array(FieldDescriptor).max(MAX_PREFILL_FIELDS),
  }),
  z.strictObject({ kind: z.literal("fill"), ...FillPlan.shape }),
  z.strictObject({ kind: z.literal("fill_result"), ...FillResult.shape }),
  z.strictObject({
    kind: z.literal("attach"),
    nonce: ScanNonce,
    fieldId: FieldId,
    fileName: AttachFileName,
    mimeType: z.literal("application/pdf"),
    dataBase64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
  }),
  z.strictObject({
    kind: z.literal("attach_result"),
    nonce: ScanNonce,
    fieldId: FieldId,
    result: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("attached") }),
      z.strictObject({ kind: z.literal("rejected"), reason: AttachRejectReason }),
    ]),
  }),
]);
export type RuntimeMessage = z.infer<typeof RuntimeMessage>;

// ---------- Diagnostics ----------

/**
 * Why a request did not succeed. The extension checks at compile time that every panel refusal,
 * client failure and routing rejection is listed (extension/src/state/diagnostics.ts).
 */
export const DIAGNOSTIC_ERROR_CODES = [
  ...ERROR_CODES,
  /** The server answered with a body the extension cannot read. */
  "bad_response",
  /** The server could not be reached. */
  "network",
  /** No stored pairing. A revoked one is `unauthorized`. */
  "unpaired",
  /** Pairing did not complete: bad endpoint or code, no host permission, or the server refused the code. */
  "pair_failed",
  "stale_field",
  // Panel refusals (extension/src/messages.ts PANEL_REFUSALS).
  "not_active",
  "unsupported_url",
  "blocked_host",
  "permission_denied",
  "not_bound",
  "bad_reply",
  "tab_changed",
  // Messages the worker would not hear (extension/src/messages.ts routeMessage).
  "foreign_sender",
  "not_top_frame",
  "bad_message",
  // Attach rejections, and a Download fallback Chrome refused.
  ...ATTACH_REJECT_REASONS,
  "download_failed",
] as const;
export const DiagnosticErrorCode = z.enum(DIAGNOSTIC_ERROR_CODES);
export type DiagnosticErrorCode = z.infer<typeof DiagnosticErrorCode>;

export const DiagnosticOutcome = z.union([z.literal("ok"), DiagnosticErrorCode]);
export type DiagnosticOutcome = z.infer<typeof DiagnosticOutcome>;

/** `request`: the worker handled a panel request. `refusal`: it would not hear a message at all. */
export const DIAGNOSTIC_KINDS = ["request", "refusal"] as const;

/**
 * A page or endpoint origin: `https://host[:port]`, or loopback HTTP. No path, query, fragment or
 * user info, so a recorded origin cannot carry an application id or a token.
 */
export const DiagnosticOrigin = z
  .string()
  .max(300)
  .regex(/^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?$/);
export type DiagnosticOrigin = z.infer<typeof DiagnosticOrigin>;

export const MAX_DIAGNOSTIC_ENTRIES = 50;

const Count = z.number().int().min(0).max(10_000);

/**
 * One ring-buffer entry. Metadata only: there is deliberately no value, label, text, URL or token
 * field, and every object is strict. `counts` is null when the request has nothing to count.
 */
export const DiagnosticEntry = z.strictObject({
  ts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(DIAGNOSTIC_KINDS),
  /** The panel request kind, or `unknown` for a message that named no known kind. */
  request: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z_]+$/),
  origin: DiagnosticOrigin.nullable(),
  adapter: AdapterId.nullable(),
  counts: z
    .strictObject({ fields: Count, matched: Count, filled: Count, skipped: Count, unresolved: Count })
    .nullable(),
  outcome: DiagnosticOutcome,
});
export type DiagnosticEntry = z.infer<typeof DiagnosticEntry>;

// ---------- Auth matrix ----------

type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * SPA routes: no auth, like the rest of the app. Mutations need `Content-Type: application/json`
 * and `Origin` equal to the app origin (`app_origin_json`); reads are same-origin and return no
 * token material.
 */
type SpaRoute = {
  readonly caller: "spa";
  readonly auth: "none";
  readonly method: RouteMethod;
  readonly path: `/api/extension-web/${string}`;
  readonly origin: "app_origin_json" | "same_origin_read";
};

/**
 * Extension routes. `code`: one-time pairing code; binds the request's `chrome-extension://` origin.
 * `bearer`: timing-safe token hash compare; `Origin`, if present, must equal the paired origin.
 */
type ExtensionRoute = {
  readonly caller: "extension";
  readonly auth: "code" | "bearer";
  readonly method: RouteMethod;
  readonly path: `/api/extension/${string}`;
  readonly origin: "binds_extension" | "paired_extension_if_present";
};

export type ExtensionAuthRoute = SpaRoute | ExtensionRoute;

/** Every extension-related route, in Hono path syntax. The auth tests iterate it. */
export const EXTENSION_AUTH_MATRIX = [
  { caller: "spa", auth: "none", method: "POST", path: "/api/extension-web/pairings", origin: "app_origin_json" },
  { caller: "spa", auth: "none", method: "GET", path: "/api/extension-web/pairings", origin: "same_origin_read" },
  {
    caller: "spa",
    auth: "none",
    method: "DELETE",
    path: "/api/extension-web/pairings/:id",
    origin: "app_origin_json",
  },
  { caller: "spa", auth: "none", method: "POST", path: "/api/extension-web/sessions", origin: "app_origin_json" },
  { caller: "extension", auth: "code", method: "POST", path: "/api/extension/pair/claim", origin: "binds_extension" },
  ...(
    [
      ["GET", "/api/extension/ping"],
      ["GET", "/api/extension/sessions/active"],
      ["POST", "/api/extension/sessions/:id/claim"],
      ["POST", "/api/extension/sessions/:id/prefill"],
      ["GET", "/api/extension/sessions/:id/outputs"],
      ["PATCH", "/api/extension/sessions/:id/outputs/:outputId"],
      ["POST", "/api/extension/sessions/:id/outputs/:outputId/reviewed"],
      ["GET", "/api/extension/sessions/:id/outputs/:outputId/pdf"],
      ["POST", "/api/extension/sessions/:id/draft"],
      ["POST", "/api/extension/sessions/:id/confirm-applied"],
      ["GET", "/api/extension/tasks/:id"],
      ["GET", "/api/extension/opportunities/by-url"],
      ["POST", "/api/extension/import"],
      ["GET", "/api/extension/preferences"],
      ["PUT", "/api/extension/preferences"],
      ["DELETE", "/api/extension/preferences/:id"],
    ] as const
  ).map(
    ([method, path]): ExtensionRoute => ({
      caller: "extension",
      auth: "bearer",
      method,
      path,
      origin: "paired_extension_if_present",
    }),
  ),
] as const satisfies readonly ExtensionAuthRoute[];
