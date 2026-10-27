import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AppError } from "@/server/services/context";
import { ERROR_CODES } from "@/shared/api";
import * as contracts from "@/shared/extension";
import {
  ApplicationSessionId,
  ClaimPairingInput,
  ClaimSessionInput,
  DECLINE_VALUE,
  DiagnosticEntry,
  EXTENSION_AUTH_MATRIX,
  ExtensionEndpoint,
  FieldDescriptor,
  FillPlan,
  isSalaryLabel,
  MAX_PREFILL_FIELDS,
  PairingCode,
  PairingId,
  PREFILL_CATEGORIES,
  PREFILL_CATEGORY_KEYS,
  PreferenceId,
  PreferenceInput,
  PrefillRequest,
  RuntimeMessage,
  SALARY_LABEL_PATTERN,
} from "@/shared/extension";
import * as answerContracts from "@/shared/extension-answers";
import { toApiError } from "@/web/api";

const UUID = "0b9c6f0e-6a53-4a5e-9a4e-3f1f6b1d2c3a";

function field(over: Partial<z.input<typeof FieldDescriptor>> = {}): FieldDescriptor {
  return FieldDescriptor.parse({
    fieldId: "f1",
    control: "text",
    label: "First name",
    autocomplete: "given-name",
    name: null,
    required: true,
    options: [],
    adapterCategory: null,
    ...over,
  });
}

describe("branded ids", () => {
  test("accept a uuid and reject anything else", () => {
    for (const id of [PairingId, ApplicationSessionId, PreferenceId]) {
      expect(id.safeParse(UUID).success).toBe(true);
      expect(id.safeParse("not-a-uuid").success).toBe(false);
    }
  });
});

describe("ExtensionEndpoint", () => {
  test.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["HTTP://LocalHost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://hb.example.com", "https://hb.example.com"],
  ])("accepts %s as %s", (input, origin) => {
    expect<string>(ExtensionEndpoint.parse(input)).toBe(origin);
  });

  test.each([
    "http://192.168.1.5:3000",
    "http://10.0.0.2",
    "http://localhost.evil.com:3000",
    "http://127.0.0.2:3000",
    "http://user:pass@localhost:3000",
    "http://localhost:3000/api",
    "http://localhost:3000/?x=1",
    "http://localhost:3000/#x",
    "ftp://localhost",
    "javascript:alert(1)",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "",
    `https://${"a".repeat(400)}.com`,
  ])("rejects %s", (input) => {
    expect(ExtensionEndpoint.safeParse(input).success).toBe(false);
  });
});

describe("pairing", () => {
  test("code is normalized: case, spaces and the dash are ignored", () => {
    expect<string>(PairingCode.parse("abcd-efgh")).toBe("ABCDEFGH");
    expect<string>(ClaimPairingInput.parse({ code: " ABCD EFGH " }).code).toBe("ABCDEFGH");
  });

  test("code rejects ambiguous characters and wrong length", () => {
    for (const bad of ["ABCD-EFG0", "ABCD-EFGI", "ABCDEFG", "ABCDEFGHJ", "ABCD-EFG1"]) {
      expect(PairingCode.safeParse(bad).success).toBe(false);
    }
  });
});

describe("sessions", () => {
  test("claim defaults confirmMismatch to false and only takes http(s) tab urls", () => {
    expect(ClaimSessionInput.parse({ tabUrl: "https://boards.greenhouse.io/x/jobs/1" }).confirmMismatch).toBe(false);
    expect(ClaimSessionInput.safeParse({ tabUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(ClaimSessionInput.safeParse({ tabUrl: `https://x.com/${"a".repeat(2100)}` }).success).toBe(false);
  });
});

describe("PREFILL_CATEGORIES", () => {
  const identity = ["gender", "race_ethnicity", "veteran_status", "disability_status"] as const;

  test("the key tuple and the table list the same categories in the same order", () => {
    expect(Object.keys(PREFILL_CATEGORIES)).toEqual([...PREFILL_CATEGORY_KEYS]);
  });

  test("groups follow the plan", () => {
    const byGroup = (g: string) => PREFILL_CATEGORY_KEYS.filter((k) => PREFILL_CATEGORIES[k].group === g);
    expect(byGroup("basics")).toEqual([
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
    ]);
    expect(byGroup("eligibility")).toEqual([
      "work_authorization",
      "requires_sponsorship",
      "notice_period",
      "start_date",
      "willing_to_relocate",
      "work_arrangement",
      "willing_to_travel",
    ]);
    expect(byGroup("voluntary_identity")).toEqual([...identity]);
  });

  test("voluntary identity, work authorization and sponsorship are sensitive; nothing else is", () => {
    const sensitive = PREFILL_CATEGORY_KEYS.filter((k) => PREFILL_CATEGORIES[k].sensitive);
    expect(sensitive).toEqual(["work_authorization", "requires_sponsorship", ...identity]);
  });

  test("every identity category offers a decline-to-answer choice", () => {
    for (const key of identity) {
      const spec = PREFILL_CATEGORIES[key];
      expect(spec.valueType).toBe("choice");
      expect(spec.valueType === "choice" && spec.choices.includes(DECLINE_VALUE)).toBe(true);
    }
  });

  test("no salary or compensation category exists", () => {
    for (const key of PREFILL_CATEGORY_KEYS) {
      expect(SALARY_LABEL_PATTERN.test(key.replaceAll("_", " "))).toBe(false);
    }
  });

  test("label synonyms are lowercase, unique across categories, and never salary-like", () => {
    const seen = new Map<string, string>();
    for (const key of PREFILL_CATEGORY_KEYS) {
      for (const synonym of PREFILL_CATEGORIES[key].labelSynonyms) {
        expect<string>(synonym).toBe(synonym.toLowerCase().trim());
        expect(isSalaryLabel(synonym)).toBe(false);
        expect(seen.get(synonym) ?? key).toBe(key);
        seen.set(synonym, key);
      }
    }
  });
});

describe("SALARY_LABEL_PATTERN", () => {
  test.each([
    "Salary",
    "Desired salary (USD)",
    "Salary expectations",
    "Expected compensation",
    "Pay expectation",
    "What are your pay expectations?",
    "Expected monthly rate",
    "Hourly rate",
    "Day-rate",
    "Rates",
    "Minimum wage you'd accept",
    "Wages",
    "Remuneration",
    "Current CTC",
    "Expected ctc (LPA)",
    "Expected income",
    "Stipend",
    "OTE",
  ])("blocks %s", (label) => {
    expect(isSalaryLabel(label)).toBe(true);
  });

  // Word boundaries keep these out. "Rate your …" questions are still blocked (see the docstring):
  // a false positive only leaves a field blank, which fails safe.
  test.each([
    "Corporate email",
    "Accurate",
    "Separate",
    "Availability",
    "Payroll provider",
    "PayPal email",
    "Payment terms",
    "Pirate",
    "Moderate experience",
    "Generated",
    "Decorated",
    "Accept terms",
    "Repayment",
    "Corporation",
  ])("does not block %s", (label) => {
    expect(isSalaryLabel(label)).toBe(false);
  });

  test("is not stateful across calls", () => {
    expect(SALARY_LABEL_PATTERN.global).toBe(false);
    expect(SALARY_LABEL_PATTERN.sticky).toBe(false);
  });
});

describe("PreferenceInput", () => {
  test("accepts a typed value that matches the category", () => {
    const pref = PreferenceInput.parse({
      category: "notice_period",
      typedValue: { valueType: "text", value: "Two weeks" },
      displayText: "Two weeks",
      scope: { kind: "global" },
    });
    expect(pref.category).toBe("notice_period");
    expect(
      PreferenceInput.safeParse({
        category: "start_date",
        typedValue: { valueType: "date", value: "2026-11-01" },
        displayText: "1 November 2026",
        scope: { kind: "opportunity", opportunityId: UUID },
      }).success,
    ).toBe(true);
  });

  test("rejects a value type that does not match the category", () => {
    const result = PreferenceInput.safeParse({
      category: "requires_sponsorship",
      typedValue: { valueType: "text", value: "no" },
      displayText: "No",
      scope: { kind: "global" },
    });
    expect(result.success).toBe(false);
  });

  test("choice must be one of the category's choices; decline is allowed for identity", () => {
    const base = { displayText: "x", scope: { kind: "global" } } as const;
    expect(
      PreferenceInput.safeParse({ ...base, category: "gender", typedValue: { valueType: "choice", value: "decline" } })
        .success,
    ).toBe(true);
    expect(
      PreferenceInput.safeParse({ ...base, category: "gender", typedValue: { valueType: "choice", value: "robot" } })
        .success,
    ).toBe(false);
  });

  test("rejects a salary category, an opportunity scope without id, and long display text", () => {
    const ok = {
      category: "location",
      typedValue: { valueType: "text", value: "Manila" },
      displayText: "Manila",
      scope: { kind: "global" },
    };
    expect(PreferenceInput.safeParse({ ...ok, category: "salary" }).success).toBe(false);
    expect(PreferenceInput.safeParse({ ...ok, scope: { kind: "opportunity" } }).success).toBe(false);
    expect(PreferenceInput.safeParse({ ...ok, displayText: "x".repeat(2001) }).success).toBe(false);
    expect(PreferenceInput.safeParse({ ...ok, displayText: "  " }).success).toBe(false);
  });
});

describe("prefill and fill contracts", () => {
  test("caps fields per request and label length", () => {
    const nonce = "n".repeat(24);
    const fields = Array.from({ length: MAX_PREFILL_FIELDS }, (_, i) => field({ fieldId: `f${i}` }));
    expect(PrefillRequest.safeParse({ nonce, fields }).success).toBe(true);
    expect(PrefillRequest.safeParse({ nonce, fields: [...fields, field({ fieldId: "extra" })] }).success).toBe(false);
    expect(FieldDescriptor.safeParse({ ...field(), label: "x".repeat(501) }).success).toBe(false);
  });

  test("a combobox is a control of its own, so the scan can report it without passing it off as text", () => {
    expect(FieldDescriptor.safeParse(field({ control: "combobox", label: "Gender" })).success).toBe(true);
    expect(FieldDescriptor.safeParse({ ...field(), control: "listbox" }).success).toBe(false);
  });

  test("fill plans are keyed by field id and refuse selectors or code", () => {
    const entry = { fieldId: "f1", value: { kind: "text", text: "Ada" } };
    expect(FillPlan.safeParse({ nonce: "n".repeat(24), entries: [entry] }).success).toBe(true);
    expect(
      FillPlan.safeParse({ nonce: "n".repeat(24), entries: [{ ...entry, selector: "#first_name" }] }).success,
    ).toBe(false);
    expect(FillPlan.safeParse({ nonce: "n".repeat(24), entries: [entry], script: "alert(1)" }).success).toBe(false);
  });

  test("runtime messages are a closed union on kind", () => {
    expect(RuntimeMessage.safeParse({ kind: "scan", nonce: "n".repeat(24) }).success).toBe(true);
    expect(RuntimeMessage.safeParse({ kind: "eval", code: "alert(1)" }).success).toBe(false);
    expect(RuntimeMessage.safeParse({ kind: "scan", nonce: "n".repeat(24), selector: "#x" }).success).toBe(false);
  });

  test("a page cannot push a success signal or a page extract to the worker", () => {
    // Success is only asked for (success_probe) and import only read on a click (read_job).
    expect(RuntimeMessage.safeParse({ kind: "success_signal", reason: "form_gone" }).success).toBe(false);
    expect(RuntimeMessage.safeParse({ kind: "extract_page", nonce: "n".repeat(24) }).success).toBe(false);
    expect(
      RuntimeMessage.safeParse({
        kind: "page_extract",
        nonce: "n".repeat(24),
        url: "https://jobs.example/1",
        title: "t",
        company: "c",
        description: "d",
      }).success,
    ).toBe(false);
  });
});

describe("DiagnosticEntry", () => {
  const entry = {
    ts: 1_760_000_000_000,
    kind: "request",
    request: "fill",
    origin: "https://boards.greenhouse.io",
    adapter: "greenhouse",
    counts: { fields: 12, matched: 8, filled: 6, skipped: 2, unresolved: 4 },
    outcome: "ok",
  };

  test("holds metadata only", () => {
    expect<unknown>(DiagnosticEntry.parse(entry)).toEqual(entry);
    expect(Object.keys(DiagnosticEntry.shape).sort()).toEqual(
      ["adapter", "counts", "kind", "origin", "outcome", "request", "ts"].sort(),
    );
  });

  test("a refusal has no adapter or counts", () => {
    const refusal = {
      ...entry,
      kind: "refusal",
      request: "unknown",
      adapter: null,
      counts: null,
      outcome: "bad_message",
    };
    expect(DiagnosticEntry.safeParse(refusal).success).toBe(true);
    expect(DiagnosticEntry.safeParse({ ...refusal, origin: null }).success).toBe(true);
  });

  test("rejects any value or text field", () => {
    for (const extra of ["value", "text", "label", "url", "token"]) {
      expect(DiagnosticEntry.safeParse({ ...entry, [extra]: "Ada" }).success).toBe(false);
      expect(DiagnosticEntry.safeParse({ ...entry, counts: { ...entry.counts, [extra]: "Ada" } }).success).toBe(false);
    }
  });

  test("origin is scheme, host and port only", () => {
    for (const origin of [
      "https://jobs.example",
      "https://jobs.example:8443",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://[::1]:3000",
    ]) {
      expect(DiagnosticEntry.safeParse({ ...entry, origin }).success).toBe(true);
    }
    for (const origin of [
      "https://jobs.example/",
      "https://jobs.example/apply/1",
      "https://jobs.example?ref=x",
      "https://jobs.example#top",
      "https://ada:secret@jobs.example",
      "http://jobs.example",
      "http://192.168.1.5:3000",
      "chrome-extension://abcdefghijklmnop",
      `https://${"a".repeat(300)}.example`,
    ]) {
      expect(DiagnosticEntry.safeParse({ ...entry, origin }).success).toBe(false);
    }
  });

  test("request is a short snake_case kind and outcome a known code", () => {
    for (const request of ["", "Fill", "fill now", "fill-1", "a".repeat(41)]) {
      expect(DiagnosticEntry.safeParse({ ...entry, request }).success).toBe(false);
    }
    for (const outcome of ["refused", "not_bound", "tab_changed", "bad_response", "network"]) {
      expect(DiagnosticEntry.safeParse({ ...entry, outcome }).success).toBe(outcome !== "refused");
    }
  });

  test("every app error code is a diagnostic outcome", () => {
    for (const code of ERROR_CODES) expect(DiagnosticEntry.safeParse({ ...entry, outcome: code }).success).toBe(true);
  });
});

describe("EXTENSION_AUTH_MATRIX", () => {
  test("lists each route once", () => {
    const keys = EXTENSION_AUTH_MATRIX.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("SPA routes live under extension-web and take no auth", () => {
    const spa = EXTENSION_AUTH_MATRIX.filter((r) => r.caller === "spa");
    expect(spa.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/extension-web/pairings",
      "GET /api/extension-web/pairings",
      "DELETE /api/extension-web/pairings/:id",
      "POST /api/extension-web/sessions",
    ]);
    for (const r of spa) expect(r.auth).toBe("none");
  });

  test("only the claim uses a code; every other extension route needs a bearer token", () => {
    const ext = EXTENSION_AUTH_MATRIX.filter((r) => r.caller === "extension");
    for (const r of ext) expect(r.path.startsWith("/api/extension/")).toBe(true);
    expect(ext.filter((r) => r.auth === "code").map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/extension/pair/claim",
    ]);
    // `auth: "none"` on an extension route is a type error (ExtensionAuthRoute); this checks the data.
    expect(ext.filter((r) => r.auth === "bearer").length).toBe(ext.length - 1);
    expect(ext.length).toBeGreaterThan(5);
  });
});

describe("error codes", () => {
  test("unauthorized is 401 and forbidden_origin is 403", () => {
    expect(ERROR_CODES).toContain("unauthorized");
    expect(ERROR_CODES).toContain("forbidden_origin");
    expect(new AppError({ code: "unauthorized", message: "x" }).status).toBe(401);
    expect(new AppError({ code: "forbidden_origin", message: "x" }).status).toBe(403);
    expect(new AppError({ code: "url_mismatch", message: "x" }).status).toBe(409);
    expect(new AppError({ code: "session_expired", message: "x" }).status).toBe(409);
  });

  test("the SPA client keeps the new codes instead of folding them into internal", async () => {
    for (const [code, status] of [
      ["unauthorized", 401],
      ["forbidden_origin", 403],
    ] as const) {
      const error = await toApiError({
        ok: false,
        status,
        json: async () => ({ error: { code, message: "Pair the extension again." } }),
      });
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });
});

describe("caps", () => {
  // Formats with a fixed shape (uuid, ISO date and datetime) bound themselves.
  const SELF_BOUNDED = new Set(["uuid", "datetime", "date"]);

  function uncapped(schema: z.core.$ZodType, path: string, out: string[], seen: Set<unknown>): void {
    if (seen.has(schema)) return;
    seen.add(schema);
    const def = schema._zod.def;
    const hasMax = (def.checks ?? []).some((c) => c._zod.def.check === "max_length");
    switch (def.type) {
      case "string": {
        const format = "format" in def && typeof def.format === "string" ? def.format : null;
        if (!hasMax && !(format !== null && SELF_BOUNDED.has(format))) out.push(path);
        return;
      }
      case "array":
        if (!hasMax) out.push(path);
        if ("element" in def) uncapped(def.element as z.core.$ZodType, `${path}[]`, out, seen);
        return;
      case "object":
        if ("shape" in def)
          for (const [k, v] of Object.entries(def.shape as Record<string, z.core.$ZodType>))
            uncapped(v, `${path}.${k}`, out, seen);
        return;
      case "union":
        if ("options" in def)
          (def.options as z.core.$ZodType[]).forEach((o, i) => {
            uncapped(o, `${path}|${i}`, out, seen);
          });
        return;
      case "optional":
      case "nullable":
      case "default":
      case "readonly":
        if ("innerType" in def) uncapped(def.innerType as z.core.$ZodType, path, out, seen);
        return;
      case "pipe":
        if ("in" in def) uncapped(def.in as z.core.$ZodType, `${path}<in>`, out, seen);
        return;
      case "record":
        out.push(`${path} (record)`);
        return;
      default:
        return;
    }
  }

  test("every exported string and array schema has a maximum", () => {
    const out: string[] = [];
    for (const [name, value] of Object.entries({ ...contracts, ...answerContracts })) {
      if (value instanceof z.ZodType) uncapped(value, name, out, new Set());
    }
    expect(out).toEqual([]);
  });
});
