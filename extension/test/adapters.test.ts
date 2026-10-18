import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FieldDescriptor, FieldId, type PrefillCategory, ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { detect } from "../src/adapters";
import { createContentHandler } from "../src/content/index";
import { labelText, primary, type ScanAdapter, scanDocument } from "../src/content/scan";

// Fixtures are trimmed real markup (sources in each file's header comment). Labels below are the
// real ones from those postings.

const fixture = (name: string) => join(import.meta.dir, "fixtures", `${name}.html`);
const GREENHOUSE = fixture("greenhouse");
const LEVER = fixture("lever");
const ASHBY = fixture("ashby");
const GENERIC = fixture("generic");

const GREENHOUSE_URL = "https://job-boards.greenhouse.io/justworks/jobs/5104078";
const LEVER_URL = "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b/apply";
const ASHBY_URL = "https://jobs.ashbyhq.com/replit/2f1de5f1-48c2-4104-a697-a51fe1620508/application";

const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

/** See scan.test.ts: one cast from happy-dom's classes to lib.dom's, at the test boundary. */
async function open(file: string, url: string): Promise<Document> {
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(await Bun.file(file).text());
  return window.document as unknown as Document;
}

/** Deterministic ids, so two scans of one page line up field by field. */
function counter() {
  let n = 0;
  return () => {
    n += 1;
    return FieldId.parse(`field-${String(n).padStart(6, "0")}`);
  };
}

/** Scan with whatever `detect` finds for the page, the way the content script does. */
async function scanAts(file: string, url: string) {
  const document = await open(file, url);
  const adapter = detect(new URL(url).hostname, document);
  const fields = scanDocument({ document, measure: () => null, adapter }).map((f) => f.descriptor);
  return { document, adapter, fields };
}

/** label → category for every field the adapter categorized. */
function categorized(fields: readonly FieldDescriptor[]): Record<string, PrefillCategory> {
  return Object.fromEntries(
    fields.flatMap((f) => (f.adapterCategory === null ? [] : [[f.label, f.adapterCategory] as const])),
  );
}

function field(fields: readonly FieldDescriptor[], label: string): FieldDescriptor {
  const found = fields.find((f) => f.label === label);
  if (found === undefined) throw new Error(`no field labelled ${label}: ${fields.map((f) => f.label).join(" | ")}`);
  return found;
}

describe("detect", () => {
  test("needs the ATS host and the ATS form markup", async () => {
    const cases: [string, string, ScanAdapter["id"] | null][] = [
      [GREENHOUSE, GREENHOUSE_URL, "greenhouse"],
      [GREENHOUSE, "https://boards.greenhouse.io/justworks/jobs/5104078", "greenhouse"],
      [LEVER, LEVER_URL, "lever"],
      [ASHBY, ASHBY_URL, "ashby"],
      // Right markup, wrong host: a company site or a lookalike domain.
      [GREENHOUSE, "https://careers.justworks.com/apply", null],
      [LEVER, "https://jobs.lever.co.attacker.example/apply", null],
      [ASHBY, "https://notashbyhq.com/apply", null],
      // Right host, other markup: a redesign or a page without the form.
      [GENERIC, GREENHOUSE_URL, null],
      [LEVER, ASHBY_URL, null],
      [ASHBY, LEVER_URL, null],
    ];
    for (const [file, url, expected] of cases) {
      const { adapter } = await scanAts(file, url);
      expect({ url, file, adapter: adapter?.id ?? null }).toEqual({ url, file, adapter: expected });
    }
  });
});

describe("greenhouse", () => {
  test("maps contact fields and LinkedIn; names the resume and cover letter uploads", async () => {
    const { fields } = await scanAts(GREENHOUSE, GREENHOUSE_URL);
    expect(categorized(fields)).toEqual({
      "First Name": "given_name",
      "Last Name": "family_name",
      Email: "email",
      Phone: "phone",
      "LinkedIn Profile": "linkedin",
    });
    const files = fields.filter((f) => f.control === "file").map((f) => [f.label, f.adapterCategory]);
    expect(files).toEqual([
      ["Resume/CV", null],
      ["Cover Letter", null],
    ]);
  });

  test("comboboxes (work authorization, sponsorship, EEOC) and custom or salary questions stay unresolved", async () => {
    const { fields, document } = await scanAts(GREENHOUSE, GREENHOUSE_URL);
    for (const label of [
      "Preferred First Name",
      "How did you hear about this job?",
      "Are you currently authorized to work in the U.S. on a full-time basis?",
      "Gender",
      "Are you Hispanic/Latino?",
      "Veteran Status",
      "What are your salary expectations for this role? (Base/OTE)",
    ]) {
      expect({ label, category: field(fields, label).adapterCategory }).toEqual({ label, category: null });
    }
    // Every react-select input is sent as a combobox with its real label, no hint and no autocomplete.
    const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    expect(comboboxes).toHaveLength(10);
    for (const box of comboboxes) {
      const title = document.getElementById(box.getAttribute("aria-labelledby") ?? "");
      if (title === null) throw new Error("combobox without a label");
      const scanned = field(fields, labelText(title));
      expect([scanned.control, scanned.adapterCategory, scanned.autocomplete]).toEqual(["combobox", null, null]);
    }
  });
});

describe("lever", () => {
  test("maps contact, links, standard work authorization and sponsorship cards, and U.S. EEO", async () => {
    const { fields } = await scanAts(LEVER, LEVER_URL);
    expect(categorized(fields)).toEqual({
      "Full name": "full_name",
      Email: "email",
      Phone: "phone",
      "Current location": "location",
      "LinkedIn URL": "linkedin",
      "Github URL": "github",
      "Other Website URL": "website",
      "Are you legally authorized to work in the country for which you are applying?": "work_authorization",
      "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?":
        "requires_sponsorship",
      Gender: "gender",
      Race: "race_ethnicity",
      "Veteran status": "veteran_status",
      "Disability status": "disability_status",
    });
    expect(field(fields, "Resume/CV")).toMatchObject({ control: "file", adapterCategory: null });
  });

  test("card questions get their real label; free-text, checkbox, survey and salary questions stay unresolved", async () => {
    const { fields } = await scanAts(LEVER, LEVER_URL);
    for (const label of [
      // Sponsorship asked as free text (Ro): no Yes/No options, so not certain.
      "Do you now or in the future require sponsorship to work in the United States?",
      "How did you hear about us?",
      "What is your expected compensation range?",
      "What is your age range?",
      "What gender do you identify as?",
      "Current company",
    ]) {
      expect({ label, category: field(fields, label).adapterCategory }).toEqual({ label, category: null });
    }
    // The "Work Eligibility" card is two independent checkboxes: each keeps its option label.
    const card = fields.filter((f) => f.name === "cards[6ddc5e28-c8a7-48e8-a866-635cf69932d2][field0]");
    expect(card.map((f) => [f.label, f.adapterCategory])).toEqual([
      ["Yes", null],
      ["No", null],
    ]);
  });

  test("the disability form's signature lines are not left as a bare Name and Date", async () => {
    const { fields } = await scanAts(LEVER, LEVER_URL);
    const signature = fields.filter((f) => f.name?.startsWith("eeo[disabilitySignature"));
    expect(signature.map((f) => [f.label, f.adapterCategory])).toEqual([
      ["Signature, voluntary self-identification of disability form", null],
      ["Date signed, voluntary self-identification of disability form", null],
    ]);
  });
});

describe("ashby", () => {
  test("maps contact, links and the EEOC radios; names the uploads", async () => {
    const { fields } = await scanAts(ASHBY, ASHBY_URL);
    expect(categorized(fields)).toEqual({
      "Full Name": "full_name",
      Email: "email",
      "Phone Number": "phone",
      "Linkedin Profile URL": "linkedin",
      "Portfolio URL": "portfolio",
      "Github Profile URL": "github",
      Gender: "gender",
      Race: "race_ethnicity",
      "Veteran Status": "veteran_status",
    });
    const files = fields.filter((f) => f.control === "file").map((f) => [f.label, f.adapterCategory]);
    expect(files).toEqual([
      ["Autofill from resume", null],
      ["Resume", null],
      ["Cover Letter", null],
    ]);
    // The valueless EEOC radios are offered by position, so each option names one radio.
    expect(field(fields, "Gender").options.map((o) => o.value)).toEqual(["opt:0", "opt:1", "opt:2"]);
  });

  test("yes/no button questions, the location combobox, custom and salary questions stay unresolved", async () => {
    const { fields } = await scanAts(ASHBY, ASHBY_URL);
    // Work authorization and sponsorship are buttons plus a hidden checkbox: no label, no category.
    const yesNo = fields.filter((f) => f.control === "checkbox");
    expect(yesNo.map((f) => [f.label, f.adapterCategory])).toEqual(Array(5).fill(["", null]));
    // The location type-ahead is a combobox: reported, never categorized.
    expect(field(fields, "Start typing...")).toMatchObject({ control: "combobox", adapterCategory: null });
    for (const label of [
      "Replit Profile URL",
      "What excites you about Replit?",
      "How many years of relevant professional experience do you have?",
      "What is your desired salary range?",
    ]) {
      expect({ label, category: field(fields, label).adapterCategory }).toEqual({ label, category: null });
    }
  });
});

describe("adapter hook", () => {
  test("hints change only the outgoing descriptor: same fields, same order, same signatures", async () => {
    for (const [file, url] of [
      [GREENHOUSE, GREENHOUSE_URL],
      [LEVER, LEVER_URL],
      [ASHBY, ASHBY_URL],
    ] as const) {
      const document = await open(file, url);
      const adapter = detect(new URL(url).hostname, document);
      expect(adapter).not.toBeNull();
      const plain = scanDocument({ document, measure: () => null, makeId: counter() });
      const hinted = scanDocument({ document, measure: () => null, makeId: counter(), adapter });
      expect(hinted.map((f) => f.signature)).toEqual(plain.map((f) => f.signature));
      const strip = ({ label: _l, adapterCategory: _c, ...rest }: FieldDescriptor) => rest;
      expect(hinted.map((f) => strip(f.descriptor))).toEqual(plain.map((f) => strip(f.descriptor)));
    }
  });

  test("a greedy adapter cannot categorize salary, a file, a combobox or a select without options, nor relabel salary", async () => {
    const greedy: ScanAdapter = {
      id: "greenhouse",
      // Relabels "years" as a salary question; everything else as a first name.
      hint: (target) =>
        primary(target).getAttribute("name") === "years"
          ? { adapterCategory: "given_name", labelOverride: "Expected salary" }
          : { adapterCategory: "given_name", labelOverride: "First name" },
    };
    const document = await open(GENERIC, "https://jobs.example/apply");
    const form = document.querySelector("#apply");
    if (form === null) throw new Error("fixture lacks #apply");
    form.insertAdjacentHTML(
      "beforeend",
      `<label>Country <input name="country" role="combobox" aria-autocomplete="list" /></label>
       <label>Pronoun <select name="dup"><option value="x">He</option><option value="x">She</option></select></label>
       <label>Team <select name="empty"><option value="">Choose…</option></select></label>`,
    );
    const fields = scanDocument({ document, measure: () => null, adapter: greedy }).map((f) => f.descriptor);
    const byName = (name: string) => fields.find((f) => f.name === name);

    expect(byName("rate")).toMatchObject({ label: "Expected monthly rate", adapterCategory: null });
    expect(byName("resume")).toMatchObject({ label: "First name", adapterCategory: null });
    expect(byName("country")).toMatchObject({ label: "Country", adapterCategory: null });
    expect(byName("years")).toMatchObject({ label: "Expected salary", adapterCategory: null });
    expect(byName("empty")).toMatchObject({ label: "First name", adapterCategory: null });
    expect(byName("first_name")).toMatchObject({ label: "First name", adapterCategory: "given_name" });
    // Clashing values are offered by position, and the tokens are writable: the category stays.
    expect(byName("dup")).toMatchObject({
      adapterCategory: "given_name",
      options: [{ value: "opt:0" }, { value: "opt:1" }],
    });
  });

  test("no adapter: the generic scan is unchanged", async () => {
    const document = await open(GENERIC, "https://jobs.example/apply");
    expect(detect("jobs.example", document)).toBeNull();
    const before = scanDocument({ document, measure: () => null, makeId: counter() });
    const after = scanDocument({ document, measure: () => null, makeId: counter(), adapter: null });
    expect(after).toEqual(before);
    expect(after.every((f) => f.descriptor.adapterCategory === null)).toBe(true);
  });
});

describe("content handler", () => {
  test("on Greenhouse: reports the adapter, sends its hints, and fills a hinted field", async () => {
    const document = await open(GREENHOUSE, GREENHOUSE_URL);
    const handle = createContentHandler({ document, measure: () => null });
    const reply = handle({ kind: "scan", nonce: NONCE });
    if (reply?.kind !== "scan_result") throw new Error("scan failed");
    expect(reply.adapter).toBe("greenhouse");
    const first = field(reply.fields, "First Name");
    expect(first.adapterCategory).toBe("given_name");

    const filled = handle({
      kind: "fill",
      nonce: NONCE,
      entries: [{ fieldId: first.fieldId, value: { kind: "text", text: "Ana" } }],
    });
    expect(filled).toMatchObject({ kind: "fill_result", filled: [first.fieldId], skipped: [] });
    const input = document.getElementById("first_name");
    expect(input !== null && "value" in input ? input.value : null).toBe("Ana");
  });

  test("the same markup off the ATS host is scanned generically", async () => {
    const document = await open(GREENHOUSE, "https://careers.justworks.com/apply");
    const reply = createContentHandler({ document, measure: () => null })({ kind: "scan", nonce: NONCE });
    if (reply?.kind !== "scan_result") throw new Error("scan failed");
    expect(reply.adapter).toBe("generic");
    expect(reply.fields.every((f) => f.adapterCategory === null)).toBe(true);
  });
});
