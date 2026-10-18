import { describe, expect, test } from "bun:test";
import { type Contact, OutputId, type StandardAnswers } from "@/shared/api";
import {
  type FieldDescriptor,
  FieldId,
  type FieldMatch,
  type FieldOption,
  PreferenceId,
  type PrefillCategory,
  PrefillResponse,
  ScanNonce,
  type TypedValue,
  type Unresolved,
} from "@/shared/extension";
import {
  matchPrefill,
  type PrefillAnswer,
  type PrefillInput,
  type PrefillPreference,
  type ProfileFact,
} from "./prefill";

// ---------- Builders ----------

const NONCE = ScanNonce.parse("scan-nonce-0123456789");

let fieldSeq = 0;
function field(over: Partial<Omit<FieldDescriptor, "fieldId">> & { label: string }): FieldDescriptor {
  fieldSeq++;
  return {
    fieldId: FieldId.parse(`f${fieldSeq}`),
    control: "text",
    autocomplete: null,
    name: null,
    required: false,
    options: [],
    adapterCategory: null,
    ...over,
  };
}

function options(...labels: string[]): FieldOption[] {
  return labels.map((label, i) => ({ value: String(i), label }));
}

const YES_NO = options("Yes", "No");

let idSeq = 0;
function uuid(): string {
  idSeq++;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

function pref(category: PrefillCategory, typedValue: TypedValue, displayText: string): PrefillPreference {
  return { id: PreferenceId.parse(uuid()), category, typedValue, displayText };
}

function answer(over: Partial<PrefillAnswer>): PrefillAnswer {
  return {
    id: OutputId.parse(uuid()),
    kind: "answer",
    included: true,
    outdated: false,
    question: null,
    mustAnswer: null,
    body: null,
    generatedAt: "2026-10-16T08:00:00.000Z",
    reviewedAt: "2026-10-16T09:00:00.000Z",
    ...over,
  };
}

const CONTACT: Contact = {
  fullName: "Maria Santos",
  email: "maria@example.com",
  phone: "+63 917 555 0101",
  location: "Quezon City, Philippines",
  links: ["https://www.linkedin.com/in/msantos", "github.com/msantos", "https://msantos.dev"],
};

const STANDARD: StandardAnswers = {
  salary: "PHP 150,000 per month",
  work_auth: "Philippine citizen; no visa needed to work for a PH entity.",
  notice: "30 days",
  start_date: "Two weeks after offer",
  references: "Available on request",
};

function run(
  fields: FieldDescriptor[],
  over: {
    contact?: Partial<Contact>;
    standardAnswers?: StandardAnswers;
    facts?: ProfileFact[];
    jobPreferences?: PrefillPreference[];
    globalPreferences?: PrefillPreference[];
    answers?: PrefillAnswer[];
  } = {},
) {
  const input: PrefillInput = {
    nonce: NONCE,
    fields,
    profile: {
      contact: { ...CONTACT, ...over.contact },
      standardAnswers: over.standardAnswers ?? STANDARD,
      facts: over.facts ?? [],
    },
    jobPreferences: over.jobPreferences ?? [],
    globalPreferences: over.globalPreferences ?? [],
    answers: over.answers ?? [],
  };
  const response = matchPrefill(input);
  // Every response must satisfy the wire contract.
  PrefillResponse.parse(response);
  return response;
}

function matchOf(f: FieldDescriptor, over: Parameters<typeof run>[1] = {}): FieldMatch {
  const response = run([f], over);
  expect(response.unresolved).toEqual([]);
  const [m] = response.matches;
  if (m === undefined) throw new Error("no match");
  return m;
}

function unresolvedOf(f: FieldDescriptor, over: Parameters<typeof run>[1] = {}): Unresolved {
  const response = run([f], over);
  expect(response.matches).toEqual([]);
  const [u] = response.unresolved;
  if (u === undefined) throw new Error("no unresolved");
  return u;
}

// Preferences used by the ATS tables.
const ELIGIBILITY_PREFS = [
  pref("work_authorization", { valueType: "yesNo", value: true }, "Yes"),
  pref("requires_sponsorship", { valueType: "yesNo", value: false }, "No"),
  pref("start_date", { valueType: "date", value: "2026-11-02" }, "November 2, 2026"),
  pref("portfolio", { valueType: "text", value: "https://msantos.dev/work" }, "https://msantos.dev/work"),
  pref("referral_source", { valueType: "text", value: "LinkedIn" }, "LinkedIn"),
  pref("willing_to_relocate", { valueType: "yesNo", value: false }, "No"),
  pref("gender", { valueType: "choice", value: "female" }, "Female"),
  pref("race_ethnicity", { valueType: "choice", value: "decline" }, "Decline to answer"),
  pref("veteran_status", { valueType: "choice", value: "not_protected_veteran" }, "Not a protected veteran"),
  pref("disability_status", { valueType: "choice", value: "decline" }, "Decline to answer"),
];

type Row = {
  ats: string;
  field: Omit<Partial<FieldDescriptor>, "fieldId"> & { label: string };
  category: PrefillCategory;
  confidence: "high" | "medium";
  /** Expected text, or the label of the option that should be chosen. */
  fill: { text: string } | { option: string } | { checked: boolean };
  provenance: FieldMatch["provenance"]["kind"];
  sensitive: boolean;
};

const ROWS: Row[] = [
  // Greenhouse
  {
    ats: "greenhouse",
    field: { label: "First Name *", autocomplete: "given-name" },
    category: "given_name",
    confidence: "high",
    fill: { text: "Maria" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "Last Name *" },
    category: "family_name",
    confidence: "medium",
    fill: { text: "Santos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "Email *", control: "email" },
    category: "email",
    confidence: "high",
    fill: { text: "maria@example.com" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "Phone", control: "tel" },
    category: "phone",
    confidence: "high",
    fill: { text: "+63 917 555 0101" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "LinkedIn Profile" },
    category: "linkedin",
    confidence: "medium",
    fill: { text: "https://www.linkedin.com/in/msantos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "Website" },
    category: "website",
    confidence: "medium",
    fill: { text: "https://msantos.dev" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "greenhouse",
    field: { label: "Are you legally authorized to work in the United States? *", control: "select", options: YES_NO },
    category: "work_authorization",
    confidence: "medium",
    fill: { option: "Yes" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "greenhouse",
    field: {
      label: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?",
      control: "select",
      options: [{ value: "", label: "Please select" }, ...YES_NO],
    },
    category: "requires_sponsorship",
    confidence: "medium",
    fill: { option: "No" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "greenhouse",
    field: {
      label: "Gender",
      control: "select",
      adapterCategory: "gender",
      options: options("Male", "Female", "Decline To Self Identify"),
    },
    category: "gender",
    confidence: "high",
    fill: { option: "Female" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "greenhouse",
    field: {
      label: "Race",
      control: "select",
      adapterCategory: "race_ethnicity",
      options: options(
        "American Indian or Alaskan Native",
        "Asian",
        "Black or African American",
        "Hispanic or Latino",
        "White",
        "Native Hawaiian or Other Pacific Islander",
        "Two or More Races",
        "Decline To Self Identify",
      ),
    },
    category: "race_ethnicity",
    confidence: "high",
    fill: { option: "Decline To Self Identify" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "greenhouse",
    field: {
      label: "Veteran Status",
      control: "select",
      options: options(
        "I am not a protected veteran",
        "I identify as one or more of the classifications of protected veteran",
        "I don't wish to answer",
      ),
    },
    category: "veteran_status",
    confidence: "medium",
    fill: { option: "I am not a protected veteran" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "greenhouse",
    field: {
      label: "Disability Status",
      control: "select",
      options: options(
        "Yes, I have a disability (or previously had a disability)",
        "No, I do not have a disability and have not had one in the past",
        "I do not want to answer",
      ),
    },
    category: "disability_status",
    confidence: "medium",
    fill: { option: "I do not want to answer" },
    provenance: "global_preference",
    sensitive: true,
  },
  // Lever
  {
    ats: "lever",
    field: { label: "Full name✱", name: "name" },
    category: "full_name",
    confidence: "medium",
    fill: { text: "Maria Santos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "Email✱", control: "email", name: "email" },
    category: "email",
    confidence: "high",
    fill: { text: "maria@example.com" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "Phone", name: "phone" },
    category: "phone",
    confidence: "medium",
    fill: { text: "+63 917 555 0101" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "Current location", name: "location" },
    category: "location",
    confidence: "medium",
    fill: { text: "Quezon City, Philippines" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "LinkedIn URL", name: "urls[LinkedIn]" },
    category: "linkedin",
    confidence: "medium",
    fill: { text: "https://www.linkedin.com/in/msantos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "GitHub URL", name: "urls[GitHub]" },
    category: "github",
    confidence: "medium",
    fill: { text: "github.com/msantos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "Portfolio URL", name: "urls[Portfolio]" },
    category: "portfolio",
    confidence: "medium",
    fill: { text: "https://msantos.dev/work" },
    provenance: "global_preference",
    sensitive: false,
  },
  {
    ats: "lever",
    field: { label: "How did you hear about this job?", control: "select", options: options("LinkedIn", "Referral") },
    category: "referral_source",
    confidence: "medium",
    fill: { option: "LinkedIn" },
    provenance: "global_preference",
    sensitive: false,
  },
  // Ashby
  {
    ats: "ashby",
    field: { label: "Name", autocomplete: "name" },
    category: "full_name",
    confidence: "high",
    fill: { text: "Maria Santos" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "ashby",
    field: { label: "Email", control: "email", autocomplete: "email" },
    category: "email",
    confidence: "high",
    fill: { text: "maria@example.com" },
    provenance: "profile",
    sensitive: false,
  },
  {
    ats: "ashby",
    field: { label: "Do you require visa sponsorship?", control: "radio", options: YES_NO },
    category: "requires_sponsorship",
    confidence: "medium",
    fill: { option: "No" },
    provenance: "global_preference",
    sensitive: true,
  },
  {
    ats: "ashby",
    field: { label: "When can you start?", control: "date" },
    category: "start_date",
    confidence: "medium",
    fill: { text: "2026-11-02" },
    provenance: "global_preference",
    sensitive: false,
  },
  {
    ats: "ashby",
    field: { label: "Are you willing to relocate?", control: "checkbox" },
    category: "willing_to_relocate",
    confidence: "medium",
    fill: { checked: false },
    provenance: "global_preference",
    sensitive: false,
  },
  {
    ats: "ashby",
    field: { label: "What is your notice period?", control: "textarea" },
    category: "notice_period",
    confidence: "medium",
    fill: { text: "30 days" },
    provenance: "profile",
    sensitive: false,
  },
];

describe("matchPrefill: ATS labels", () => {
  for (const row of ROWS) {
    test(`${row.ats}: ${row.field.label}`, () => {
      const f = field(row.field);
      const m = matchOf(f, { globalPreferences: ELIGIBILITY_PREFS });
      expect(m.fieldId).toBe(f.fieldId);
      expect(m.category).toBe(row.category);
      expect(m.confidence).toBe(row.confidence);
      expect(m.provenance.kind).toBe(row.provenance);
      expect(m.needsConfirmation).toBe(row.sensitive);
      expect(m.needsReview).toBe(false);
      if ("text" in row.fill) expect(m.value).toEqual({ kind: "text", text: row.fill.text });
      else if ("checked" in row.fill) expect(m.value).toEqual({ kind: "checked", checked: row.fill.checked });
      else {
        const label = row.fill.option;
        const chosen = f.options.find((o) => o.label === label);
        expect(m.value).toEqual({ kind: "option", value: chosen?.value ?? "missing" });
        expect(m.displayText).toBe(label);
      }
    });
  }

  const UNRESOLVED: [string, Omit<Partial<FieldDescriptor>, "fieldId"> & { label: string }, Unresolved["reason"]][] = [
    ["greenhouse custom question", { label: "Why do you want to work at Acme?", control: "textarea" }, "unknown_label"],
    ["greenhouse resume", { label: "Resume/CV", control: "file" }, "file_field"],
    ["lever resume", { label: "Resume/CV✱", control: "file", name: "resume" }, "file_field"],
    ["ashby cover letter", { label: "Cover Letter", control: "file" }, "file_field"],
    ["lever additional info", { label: "Additional information", control: "textarea" }, "unknown_label"],
    ["greenhouse salary", { label: "What are your salary expectations?" }, "salary"],
    ["lever pay", { label: "Desired pay (USD)" }, "salary"],
    ["ashby compensation", { label: "Compensation expectations" }, "salary"],
    ["generic CTC", { label: "Expected CTC" }, "salary"],
    ["generic wage", { label: "Desired hourly wage" }, "salary"],
    ["generic remuneration", { label: "Remuneration expectations" }, "salary"],
    ["empty label, salary name", { label: "", name: "job_application[expected_salary]" }, "salary"],
    ["empty label", { label: "" }, "unknown_label"],
  ];

  for (const [name, spec, reason] of UNRESOLVED) {
    test(`unresolved: ${name}`, () => {
      const f = field(spec);
      const u = unresolvedOf(f, { globalPreferences: ELIGIBILITY_PREFS });
      expect(u.fieldId).toBe(f.fieldId);
      expect(u.reason).toBe(reason);
    });
  }
});

describe("matchPrefill: precedence", () => {
  const cebu = pref("location", { valueType: "text", value: "Cebu City" }, "Cebu City");
  const davao = pref("location", { valueType: "text", value: "Davao City" }, "Davao City");

  test("profile beats a conflicting preference", () => {
    const m = matchOf(field({ label: "Location" }), { jobPreferences: [cebu], globalPreferences: [davao] });
    expect(m.value).toEqual({ kind: "text", text: "Quezon City, Philippines" });
    expect(m.provenance).toEqual({ kind: "profile" });
  });

  test("per-job preference beats global", () => {
    const m = matchOf(field({ label: "Location" }), {
      contact: { location: "" },
      jobPreferences: [cebu],
      globalPreferences: [davao],
    });
    expect(m.value).toEqual({ kind: "text", text: "Cebu City" });
    expect(m.provenance).toEqual({ kind: "job_preference", preferenceId: cebu.id });
  });

  test("global preference beats a reviewed answer", () => {
    const out = answer({ question: "Location", body: "Manila" });
    const m = matchOf(field({ label: "Location" }), {
      contact: { location: "" },
      globalPreferences: [davao],
      answers: [out],
    });
    expect(m.provenance).toEqual({ kind: "global_preference", preferenceId: davao.id });
  });

  test("a reviewed answer fills when nothing above has a value", () => {
    const out = answer({ question: "How did you hear about us?", body: "A friend at Acme told me." });
    const m = matchOf(field({ label: "How did you hear about us?", control: "textarea" }), { answers: [out] });
    expect(m.category).toBe("referral_source");
    expect(m.provenance).toEqual({ kind: "generated", outputId: out.id });
    expect(m.value).toEqual({ kind: "text", text: "A friend at Acme told me." });
    expect(m.needsReview).toBe(false);
  });

  test("a higher layer that cannot fill the control falls through to the next", () => {
    // Profile free text cannot pick an option; the typed preference can.
    const m = matchOf(
      field({ label: "Are you authorized to work in the Philippines?", control: "radio", options: YES_NO }),
      {
        globalPreferences: [pref("work_authorization", { valueType: "yesNo", value: true }, "Yes")],
      },
    );
    expect(m.provenance.kind).toBe("global_preference");
    expect(m.displayText).toBe("Yes");
  });

  test("a confirmed fact fills; a pending fact is ignored", () => {
    const f = field({ label: "How did you hear about us?" });
    const pending: ProfileFact = { status: "pending", category: "referral_source", text: "Pending source" };
    const confirmed: ProfileFact = { status: "confirmed", category: "referral_source", text: "Confirmed source" };
    expect(unresolvedOf(f, { facts: [pending] }).reason).toBe("no_value");
    const m = matchOf(f, { facts: [pending, confirmed] });
    expect(m.value).toEqual({ kind: "text", text: "Confirmed source" });
    expect(m.provenance).toEqual({ kind: "profile" });
  });

  test("a pending fact does not beat a preference", () => {
    const m = matchOf(field({ label: "How did you hear about us?" }), {
      facts: [{ status: "pending", category: "referral_source", text: "Pending source" }],
      globalPreferences: [pref("referral_source", { valueType: "text", value: "LinkedIn" }, "LinkedIn")],
    });
    expect(m.provenance.kind).toBe("global_preference");
  });

  test("a preference whose value does not fit its category is ignored", () => {
    const bad = pref("requires_sponsorship", { valueType: "text", value: "maybe" }, "maybe");
    const u = unresolvedOf(field({ label: "Do you require visa sponsorship?", control: "radio", options: YES_NO }), {
      globalPreferences: [bad],
    });
    expect(u).toMatchObject({ reason: "no_value", category: "requires_sponsorship" });
  });
});

describe("matchPrefill: salary", () => {
  const salaryOutput = answer({
    mustAnswer: "salary",
    question: "What is your expected monthly rate?",
    body: "PHP 150,000",
  });

  test('a salary output never fills a field labelled "Expected monthly rate"', () => {
    const u = unresolvedOf(field({ label: "Expected monthly rate" }), {
      answers: [salaryOutput],
      globalPreferences: ELIGIBILITY_PREFS,
    });
    expect(u).toEqual({ fieldId: u.fieldId, reason: "salary", category: null });
  });

  test("a salary label wins over an adapter category", () => {
    const u = unresolvedOf(field({ label: "Expected pay", adapterCategory: "notice_period" }));
    expect(u.reason).toBe("salary");
  });

  test("standardAnswers.salary and salary outputs never reach any field", () => {
    const fields = [
      field({ label: "Expected monthly rate" }),
      field({ label: "What is your expected monthly rate?", control: "textarea" }),
      field({ label: "Notice period", adapterCategory: "notice_period" }),
      field({ label: "References" }),
      field({ label: "Anything else?", control: "textarea" }),
    ];
    const response = run(fields, {
      standardAnswers: { salary: "PHP 150,000 per month" },
      answers: [salaryOutput, answer({ mustAnswer: "salary", question: "Notice period", body: "PHP 150,000" })],
    });
    const json = JSON.stringify(response);
    expect(json).not.toContain("150,000");
  });
});

describe("matchPrefill: generated answers", () => {
  const notice = field({ label: "Notice period", control: "textarea" });
  const noProfile = { standardAnswers: {} };

  test("an unreviewed answer comes back with needsReview", () => {
    const out = answer({
      mustAnswer: "notice",
      question: "What is your notice period?",
      body: "One month",
      reviewedAt: null,
    });
    const m = matchOf(notice, { ...noProfile, answers: [out] });
    expect(m.needsReview).toBe(true);
    expect(m.provenance).toEqual({ kind: "generated", outputId: out.id });
  });

  test("an answer reviewed before it was redrafted needs review again", () => {
    const out = answer({
      mustAnswer: "notice",
      question: "What is your notice period?",
      body: "One month",
      generatedAt: "2026-10-16T10:00:00.000Z",
      reviewedAt: "2026-10-16T09:00:00.000Z",
    });
    expect(matchOf(notice, { ...noProfile, answers: [out] }).needsReview).toBe(true);
  });

  test("a hand-written answer that was reviewed fills", () => {
    const out = answer({ mustAnswer: "notice", question: "Notice?", body: "One month", generatedAt: null });
    expect(matchOf(notice, { ...noProfile, answers: [out] }).needsReview).toBe(false);
  });

  test("a reviewed answer is preferred over an unreviewed one for the same category", () => {
    const unreviewed = answer({ mustAnswer: "notice", question: "Notice?", body: "Two months", reviewedAt: null });
    const reviewed = answer({ mustAnswer: "notice", question: "Notice?", body: "One month" });
    const m = matchOf(notice, { ...noProfile, answers: [unreviewed, reviewed] });
    expect(m.provenance).toEqual({ kind: "generated", outputId: reviewed.id });
  });

  const ineligible: [string, Partial<PrefillAnswer>][] = [
    ["excluded", { included: false }],
    ["outdated", { outdated: true }],
    ["empty body", { body: "   " }],
    ["no body", { body: null }],
    ["not an answer", { kind: "letter" }],
  ];
  for (const [name, over] of ineligible) {
    test(`an ${name} output is not used`, () => {
      const out = answer({ mustAnswer: "notice", question: "Notice?", body: "One month", ...over });
      expect(unresolvedOf(notice, { ...noProfile, answers: [out] }).reason).toBe("no_value");
    });
  }

  test("a work_auth output about sponsorship maps to requires_sponsorship, by its question", () => {
    const out = answer({
      mustAnswer: "work_auth",
      question: "Will you require visa sponsorship?",
      body: "No, I will not need sponsorship.",
    });
    const sponsor = field({ label: "Will you require visa sponsorship?", control: "textarea" });
    const auth = field({ label: "Work authorization", control: "textarea" });
    const response = run([sponsor, auth], { ...noProfile, answers: [out] });
    expect(response.matches.map((m) => [m.fieldId, m.category])).toEqual([[sponsor.fieldId, "requires_sponsorship"]]);
    expect(response.unresolved).toEqual([
      { fieldId: auth.fieldId, reason: "no_value", category: "work_authorization" },
    ]);
  });
});

describe("matchPrefill: free text and typed values", () => {
  test("profile work_auth free text fills a textarea", () => {
    const m = matchOf(field({ label: "Work authorization", control: "textarea" }));
    expect(m.value).toEqual({ kind: "text", text: STANDARD.work_auth ?? "" });
    expect(m.needsConfirmation).toBe(true);
  });

  test("profile work_auth free text never picks a yes/no option", () => {
    const u = unresolvedOf(
      field({ label: "Are you legally authorized to work in the US?", control: "select", options: YES_NO }),
    );
    expect(u).toMatchObject({ reason: "no_value", category: "work_authorization" });
  });

  test("profile start_date free text never fills a date input", () => {
    const u = unresolvedOf(field({ label: "Start date", control: "date" }));
    expect(u).toMatchObject({ reason: "no_value", category: "start_date" });
  });

  test("profile start_date free text fills a text input", () => {
    expect(matchOf(field({ label: "Earliest start date" })).value).toEqual({
      kind: "text",
      text: "Two weeks after offer",
    });
  });

  test("a yes/no preference fills a text input with its display text", () => {
    const m = matchOf(field({ label: "Willing to relocate" }), {
      globalPreferences: [pref("willing_to_relocate", { valueType: "yesNo", value: true }, "Yes, within Luzon")],
    });
    expect(m.value).toEqual({ kind: "text", text: "Yes, within Luzon" });
  });

  test("a typed text preference picks a select option only on an exact label match", () => {
    const f = field({
      label: "How did you hear about us?",
      control: "select",
      options: options("LinkedIn Jobs", "Referral"),
    });
    const u = unresolvedOf(f, {
      globalPreferences: [pref("referral_source", { valueType: "text", value: "LinkedIn" }, "LinkedIn")],
    });
    expect(u).toMatchObject({ reason: "no_matching_option", category: "referral_source" });
  });
});

describe("matchPrefill: option matching", () => {
  const sponsorshipYes = [pref("requires_sponsorship", { valueType: "yesNo", value: true }, "Yes")];
  const sponsorshipNo = [pref("requires_sponsorship", { valueType: "yesNo", value: false }, "No")];
  const label = "Will you now or in the future require visa sponsorship?";

  test("long yes/no option labels normalize", () => {
    const opts = options("Yes, I will require sponsorship", "No, I will not require sponsorship");
    expect(
      matchOf(field({ label, control: "radio", options: opts }), { globalPreferences: sponsorshipNo }).displayText,
    ).toBe("No, I will not require sponsorship");
  });

  test("yes/no matches on option value when labels are blank", () => {
    const opts = [
      { value: "true", label: "" },
      { value: "false", label: "" },
    ];
    expect(
      matchOf(field({ label, control: "select", options: opts }), { globalPreferences: sponsorshipYes }).value,
    ).toEqual({
      kind: "option",
      value: "true",
    });
  });

  test("two options that both read as yes are not confident", () => {
    const opts = options("Yes", "Yes, in the future", "No");
    const u = unresolvedOf(field({ label, control: "select", options: opts }), { globalPreferences: sponsorshipYes });
    expect(u).toMatchObject({ reason: "no_matching_option", category: "requires_sponsorship" });
  });

  test("a decline option is never read as no", () => {
    const opts = options("Yes", "No, I don't wish to answer");
    const u = unresolvedOf(field({ label, control: "select", options: opts }), { globalPreferences: sponsorshipNo });
    expect(u.reason).toBe("no_matching_option");
  });

  test("decline maps to the decline option", () => {
    const f = field({
      label: "Gender",
      control: "radio",
      options: options("Male", "Female", "Non-binary", "I prefer not to say"),
    });
    const m = matchOf(f, { globalPreferences: [pref("gender", { valueType: "choice", value: "decline" }, "Decline")] });
    expect(m.displayText).toBe("I prefer not to say");
  });

  test('"Male" does not match "Female"', () => {
    const f = field({ label: "Gender", control: "select", options: options("Female", "Male") });
    const m = matchOf(f, { globalPreferences: [pref("gender", { valueType: "choice", value: "male" }, "Male")] });
    expect(m.displayText).toBe("Male");
  });

  test("no option for the stored choice is unresolved", () => {
    const f = field({ label: "Gender", control: "select", options: options("Female", "Male") });
    const u = unresolvedOf(f, {
      globalPreferences: [pref("gender", { valueType: "choice", value: "non_binary" }, "Non-binary")],
    });
    expect(u).toMatchObject({ reason: "no_matching_option", category: "gender" });
  });

  test("work arrangement choices", () => {
    const f = field({
      label: "Preferred work arrangement",
      control: "select",
      options: options("Remote", "Hybrid", "On-site"),
    });
    const m = matchOf(f, {
      globalPreferences: [pref("work_arrangement", { valueType: "choice", value: "onsite" }, "On-site")],
    });
    expect(m.displayText).toBe("On-site");
  });
});

describe("matchPrefill: confidence and controls", () => {
  test("ambiguous label containing two categories is low confidence", () => {
    const u = unresolvedOf(field({ label: "Are you authorized to work here, or will you require sponsorship?" }));
    expect(u).toEqual({ fieldId: u.fieldId, reason: "low_confidence", category: null });
  });

  test("a single-word synonym only matches the whole label", () => {
    expect(unresolvedOf(field({ label: "Company name" })).reason).toBe("unknown_label");
    expect(unresolvedOf(field({ label: "Is travel reimbursed?" })).reason).toBe("unknown_label");
  });

  test("autocomplete with section tokens is high confidence", () => {
    const m = matchOf(field({ label: "Your e-mail please", autocomplete: "section-apply email" }));
    expect(m).toMatchObject({ category: "email", confidence: "high" });
  });

  test("a file field never gets a value, even with an adapter category", () => {
    const u = unresolvedOf(field({ label: "Email", control: "file", adapterCategory: "email" }));
    expect(u.reason).toBe("file_field");
  });

  test("a number input is unsupported", () => {
    expect(unresolvedOf(field({ label: "Phone", control: "number" })).reason).toBe("unsupported_control");
  });

  test("a combobox is unsupported before any category or label match, whatever the profile holds", () => {
    const over = {
      facts: [] as ProfileFact[],
      globalPreferences: [...ELIGIBILITY_PREFS, pref("gender", { valueType: "choice", value: "female" }, "Female")],
    };
    // The same questions on a plain control do match: only the control stops them.
    expect(
      matchOf(field({ label: "Gender", options: options("Male", "Female"), control: "select" }), over).category,
    ).toBe("gender");
    expect(
      matchOf(
        field({ label: "Are you currently authorized to work in the U.S.?", control: "select", options: YES_NO }),
        over,
      ).category,
    ).toBe("work_authorization");

    for (const f of [
      field({ label: "Gender", control: "combobox" }),
      field({ label: "Are you currently authorized to work in the U.S.?", control: "combobox" }),
      field({ label: "Email", control: "combobox", autocomplete: "email", adapterCategory: "email" }),
    ]) {
      expect(unresolvedOf(f, over)).toEqual({ fieldId: f.fieldId, reason: "unsupported_control", category: null });
    }
  });

  test("a checkbox for a text category is unsupported", () => {
    expect(unresolvedOf(field({ label: "Location", control: "checkbox" })).reason).toBe("unsupported_control");
  });

  test("a name with more than two words does not split into given and family names", () => {
    const response = run(
      [field({ label: "First name" }), field({ label: "Last name" }), field({ label: "Full name" })],
      {
        contact: { fullName: "Juan dela Cruz" },
      },
    );
    expect(response.unresolved.map((u) => [u.category, u.reason])).toEqual([
      ["given_name", "no_value"],
      ["family_name", "no_value"],
    ]);
    expect(response.matches.map((m) => m.value)).toEqual([{ kind: "text", text: "Juan dela Cruz" }]);
  });

  test("an empty profile value is no value", () => {
    expect(unresolvedOf(field({ label: "Phone" }), { contact: { phone: "  " } })).toMatchObject({
      reason: "no_value",
      category: "phone",
    });
  });

  test("matches and unresolved keep field order and echo the nonce", () => {
    const a = field({ label: "Email", control: "email" });
    const b = field({ label: "Favourite colour" });
    const c = field({ label: "Phone", control: "tel" });
    const response = run([a, b, c]);
    expect(response.nonce).toBe(NONCE);
    expect(response.matches.map((m) => m.fieldId)).toEqual([a.fieldId, c.fieldId]);
    expect(response.unresolved.map((u) => u.fieldId)).toEqual([b.fieldId]);
  });
});
