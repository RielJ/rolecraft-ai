import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FieldDescriptor, FieldId, type RuntimeMessage, ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { detect } from "../src/adapters";
import { type ContentDeps, newScanNonce, scanTab, type TabRefusal } from "../src/background/content";
import {
  approvalFor,
  type PermissionsApi,
  requestOriginAccess,
  revokeOriginAccess,
  syncGrantedOrigins,
} from "../src/background/permissions";
import { createContentHandler } from "../src/content/index";
import { type Box, boxLooksHidden, scanDocument } from "../src/content/scan";
import { createStore, type KeyValueArea } from "../src/state/storage";

const FIXTURE = join(import.meta.dir, "fixtures", "generic.html");
const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

/**
 * A fixture page in its own happy-dom window: no scripts, no network. happy-dom's classes are not
 * the lib.dom types, so the one cast to `Document` lives here, at the test boundary.
 */
async function openFixture(url = "https://jobs.example/apply"): Promise<Document> {
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(await Bun.file(FIXTURE).text());
  return window.document as unknown as Document;
}

const noLayout = () => null;

describe("scanDocument", () => {
  test("reports visible, editable controls in document order with resolved labels", async () => {
    const document = await openFixture();
    const fields = scanDocument({ document, measure: noLayout }).map((f) => f.descriptor);
    expect(fields.map(({ fieldId: _id, ...rest }) => rest)).toEqual([
      {
        control: "text",
        label: "First name",
        autocomplete: "given-name",
        name: "first_name",
        required: true,
        options: [],
        adapterCategory: null,
      },
      // Wrapping label: the nested control contributes no text.
      {
        control: "text",
        label: "Last name",
        autocomplete: null,
        name: "last_name",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "email",
        label: "Email address",
        autocomplete: null,
        name: "email",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "tel",
        label: "Phone number",
        autocomplete: null,
        name: "phone",
        required: false,
        options: [],
        adapterCategory: null,
      },
      // Placeholder only as the last resort.
      {
        control: "url",
        label: "LinkedIn profile",
        autocomplete: null,
        name: "linkedin",
        required: false,
        options: [],
        adapterCategory: null,
      },
      // Already filled: still reported, fill leaves it alone.
      {
        control: "text",
        label: "Current city",
        autocomplete: null,
        name: "location",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "number",
        label: "Years of experience",
        autocomplete: null,
        name: "years",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "date",
        label: "Earliest start date",
        autocomplete: null,
        name: "start",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "textarea",
        label: "Why do you want to work here?",
        autocomplete: null,
        name: "why",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "select",
        label: "Preferred work arrangement",
        autocomplete: null,
        name: "arrangement",
        required: false,
        // Disabled options are not offered.
        options: [
          { value: "", label: "Select…" },
          { value: "remote", label: "Remote" },
          { value: "hybrid", label: "Hybrid" },
        ],
        adapterCategory: null,
      },
      {
        control: "radio",
        label: "Will you require visa sponsorship?",
        autocomplete: null,
        name: "sponsorship",
        required: false,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        adapterCategory: null,
      },
      {
        control: "checkbox",
        label: "I am willing to relocate",
        autocomplete: null,
        name: "relocate",
        required: false,
        options: [],
        adapterCategory: null,
      },
      {
        control: "file",
        label: "Resume",
        autocomplete: null,
        name: "resume",
        required: false,
        options: [],
        adapterCategory: null,
      },
      // Salary is reported so the server can list it as unresolved; fill refuses it.
      {
        control: "text",
        label: "Expected monthly rate",
        autocomplete: null,
        name: "rate",
        required: false,
        options: [],
        adapterCategory: null,
      },
    ]);
  });

  test("skips password, hidden, read-only, disabled, invisible, honeypot, CAPTCHA and unsupported controls", async () => {
    const document = await openFixture();
    const names = scanDocument({ document, measure: noLayout }).map((f) => f.descriptor.name);
    for (const skipped of [
      "password",
      "csrf",
      "ref",
      "disabled_field",
      "locked_field",
      "collapsed_field",
      "hidden_attr_field",
      "aria_hidden_field",
      "invisible_field",
      "transparent_field",
      "contact_me_by_fax",
      "honeypot",
      "g-recaptcha-response",
      "captcha_answer",
      "q",
      "langs",
    ]) {
      expect(names).not.toContain(skipped);
    }
  });

  test("each descriptor parses strictly and has a fresh opaque id; nothing selector-like is sent", async () => {
    const document = await openFixture();
    const first = scanDocument({ document, measure: noLayout });
    const second = scanDocument({ document, measure: noLayout });
    for (const { descriptor } of first) expect(FieldDescriptor.parse(descriptor)).toEqual(descriptor);
    const ids = first.map((f) => f.descriptor.fieldId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(FieldId.safeParse(id).success).toBe(true);
      expect(id).not.toContain("first");
    }
    const again = new Set(second.map((f) => f.descriptor.fieldId));
    expect(ids.some((id) => again.has(id))).toBe(false);
    expect(Object.keys(first[0]?.descriptor ?? {}).sort()).toEqual(
      ["adapterCategory", "autocomplete", "control", "fieldId", "label", "name", "options", "required"].sort(),
    );
  });

  test("a control the layout puts off-screen or at 1px is skipped", async () => {
    const document = await openFixture();
    const phone = document.querySelector('[name="phone"]');
    const measure = (element: Element): Box | null =>
      element === phone ? { left: -10_000, top: 40, width: 200, height: 30 } : null;
    const names = scanDocument({ document, measure }).map((f) => f.descriptor.name);
    expect(names).not.toContain("phone");
    expect(names).toContain("email");
  });

  test("a visually hidden radio with a visible label still counts", async () => {
    const document = await openFixture();
    const radios = new Set(document.querySelectorAll('[name="sponsorship"]'));
    const measure = (element: Element): Box | null =>
      radios.has(element) ? { left: 10, top: 10, width: 1, height: 1 } : null;
    const names = scanDocument({ document, measure }).map((f) => f.descriptor.name);
    expect(names).toContain("sponsorship");
  });
});

// Real ATS upload widgets hide the native file input (Greenhouse `visually-hidden`, Lever's
// `invisible-resume-upload`, Ashby's `tabindex=-1` dropzone input) and show a styled button
// instead. happy-dom has no layout, so the injected `measure` plays the browser: the native inputs
// (and Greenhouse's visually hidden labels) measure 1×1 or 0×0, everything else measures normally.
const ATS = {
  greenhouse: { file: "greenhouse", url: "https://job-boards.greenhouse.io/justworks/jobs/5104078" },
  lever: { file: "lever", url: "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b/apply" },
  ashby: { file: "ashby", url: "https://jobs.ashbyhq.com/replit/2f1de5f1-48c2-4104-a697-a51fe1620508/application" },
} as const;

async function openAts(name: keyof typeof ATS): Promise<Document> {
  const { file, url } = ATS[name];
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(await Bun.file(join(import.meta.dir, "fixtures", `${file}.html`)).text());
  return window.document as unknown as Document;
}

const SHOWN: Box = { left: 10, top: 10, width: 200, height: 32 };
const ONE_PX: Box = { left: 10, top: 10, width: 1, height: 1 };
const NO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };

/** Native file inputs and `.visually-hidden` elements measure tiny; everything else is laid out. */
function atsLayout(tiny: Box) {
  return (element: Element): Box =>
    (element.tagName === "INPUT" && element.getAttribute("type") === "file") ||
    element.classList.contains("visually-hidden")
      ? tiny
      : SHOWN;
}

function scanAts(document: Document, measure: (element: Element) => Box | null) {
  const adapter = detect(new URL(document.URL).hostname, document);
  return scanDocument({ document, measure, adapter }).map((f) => f.descriptor);
}

const fileLabels = (fields: readonly FieldDescriptor[]) =>
  fields.filter((f) => f.control === "file").map((f) => f.label);

describe("visually hidden file inputs", () => {
  test("the ATS upload widgets each count as a file field with their label", async () => {
    const expected = {
      greenhouse: ["Resume/CV", "Cover Letter"],
      lever: ["Resume/CV"],
      ashby: ["Autofill from resume", "Resume", "Cover Letter"],
    };
    for (const name of ["greenhouse", "lever", "ashby"] as const) {
      for (const tiny of [ONE_PX, NO_BOX]) {
        const document = await openAts(name);
        expect({ name, tiny, files: fileLabels(scanAts(document, atsLayout(tiny))) }).toEqual({
          name,
          tiny,
          files: expected[name],
        });
      }
    }
  });

  test("Lever's opacity:0 input still counts through its visible wrapping label", async () => {
    const document = await openAts("lever");
    document.getElementById("resume-upload-input")?.setAttribute("style", "opacity: 0");
    expect(fileLabels(scanAts(document, atsLayout(ONE_PX)))).toEqual(["Resume/CV"]);
  });

  test("hidden, inert, aria-hidden, display:none or disabled still drop it, on the input or an ancestor", async () => {
    const changes: [string, (input: Element) => void][] = [
      ["hidden", (input) => input.setAttribute("hidden", "")],
      ["inert", (input) => input.setAttribute("inert", "")],
      ["aria-hidden", (input) => input.setAttribute("aria-hidden", "true")],
      ["display:none", (input) => input.setAttribute("style", "display: none")],
      ["visibility:hidden", (input) => input.setAttribute("style", "visibility: hidden")],
      ["disabled", (input) => input.setAttribute("disabled", "")],
      ["hidden wrapper", (input) => input.parentElement?.setAttribute("hidden", "")],
      ["display:none wrapper", (input) => input.parentElement?.setAttribute("style", "display: none")],
      ["inert section", (input) => input.closest(".field-wrapper")?.setAttribute("inert", "")],
    ];
    for (const [what, change] of changes) {
      const document = await openAts("greenhouse");
      const resume = document.getElementById("resume");
      if (resume === null) throw new Error("no resume input");
      change(resume);
      expect({ what, files: fileLabels(scanAts(document, atsLayout(ONE_PX))) }).toEqual({
        what,
        files: ["Cover Letter"],
      });
    }
  });

  test("a tiny file input with no visible label or upload wrapper is dropped", async () => {
    const document = await openFixture();
    const form = document.querySelector("form");
    if (form === null) throw new Error("no form");
    form.insertAdjacentHTML(
      "beforeend",
      `<div class="stray"><p>Portfolio</p><input type="file" name="stray" /></div>
       <label for="lonely" class="tiny">Lonely</label><input id="lonely" type="file" name="lonely" />
       <div class="dead"><button type="button" class="tiny">Upload</button><input type="file" name="dead" /></div>
       <label for="tucked">Resume</label><div hidden><input id="tucked" type="file" name="tucked" /></div>`,
    );
    const tiny = new Set(document.querySelectorAll('input[type="file"], .tiny'));
    const measure = (element: Element): Box | null => (tiny.has(element) ? ONE_PX : SHOWN);
    const names = scanDocument({ document, measure }).map((f) => f.descriptor.name);
    expect(names).not.toContain("stray");
    expect(names).not.toContain("lonely");
    expect(names).not.toContain("dead");
    // A shown label doesn't rescue an input inside a hidden container.
    expect(names).not.toContain("tucked");
  });

  test("a tiny text box with a visible label is still dropped", async () => {
    const document = await openFixture();
    const phone = document.querySelector('[name="phone"]');
    const measure = (element: Element): Box | null => (element === phone ? ONE_PX : SHOWN);
    expect(scanDocument({ document, measure }).map((f) => f.descriptor.name)).not.toContain("phone");
  });
});

describe("boxLooksHidden", () => {
  test.each([
    [{ left: 10, top: 10, width: 200, height: 30 }, false],
    [{ left: 10, top: 5000, width: 200, height: 30 }, false],
    [{ left: 10, top: 10, width: 0, height: 30 }, true],
    [{ left: 10, top: 10, width: 1, height: 1 }, true],
    [{ left: -9999, top: 10, width: 200, height: 30 }, true],
    [{ left: 10, top: -500, width: 200, height: 30 }, true],
  ] satisfies [Box, boolean][])("%o → %p", (box, hidden) => {
    expect(boxLooksHidden(box)).toBe(hidden);
  });
});

describe("content handler: scan", () => {
  test("answers a scan with the worker's nonce and the generic adapter", async () => {
    const document = await openFixture();
    const handle = createContentHandler({ document, measure: noLayout });
    const reply = handle({ kind: "scan", nonce: NONCE });
    expect(reply).toMatchObject({
      kind: "scan_result",
      nonce: NONCE,
      url: "https://jobs.example/apply",
      adapter: "generic",
    });
    expect(reply?.kind === "scan_result" ? reply.fields.length : 0).toBe(14);
  });

  test("refuses to scan a blocked host", async () => {
    const document = await openFixture("https://www.linkedin.com/jobs/apply/1");
    const handle = createContentHandler({ document, measure: noLayout });
    expect(handle({ kind: "scan", nonce: NONCE })).toBeNull();
  });

  test("ignores anything that is not a RuntimeMessage", async () => {
    const document = await openFixture();
    const handle = createContentHandler({ document, measure: noLayout });
    expect(handle({ kind: "scan", nonce: NONCE, selector: "#first" })).toBeNull();
    expect(handle({ kind: "eval", code: "alert(1)" })).toBeNull();
  });
});

// ---------- Worker side ----------

function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}

type FakeTab = { active: boolean; url: string | null };

function fakeDeps({
  tab,
  inject = "ok",
  reply,
}: {
  tab: FakeTab | null;
  inject?: "ok" | "denied";
  reply: (message: RuntimeMessage) => unknown;
}): ContentDeps & { injected: number[]; sent: RuntimeMessage[] } {
  const injected: number[] = [];
  const sent: RuntimeMessage[] = [];
  return {
    injected,
    sent,
    store: createStore({ local: memoryArea(), session: memoryArea() }),
    getTab: async () => tab,
    inject: async (tabId) => {
      injected.push(tabId);
      return inject;
    },
    send: async (_tabId, message) => {
      sent.push(message);
      return reply(message);
    },
    newNonce: () => NONCE,
  };
}

const APPLY_TAB = { active: true, url: "https://jobs.example/apply" };
const scanReply = (message: RuntimeMessage) => ({
  kind: "scan_result",
  nonce: message.kind === "scan" ? message.nonce : "x",
  url: APPLY_TAB.url,
  adapter: "generic",
  fields: [],
});

describe("scanTab (worker)", () => {
  test("injects into the active tab's top frame, then scans with a fresh nonce", async () => {
    const deps = fakeDeps({ tab: APPLY_TAB, reply: scanReply });
    expect(await scanTab({ deps, tabId: 7 })).toEqual({
      kind: "scanned",
      result: { kind: "scan_result", nonce: NONCE, url: APPLY_TAB.url, adapter: "generic", fields: [] },
    });
    expect(deps.injected).toEqual([7]);
    expect(deps.sent).toEqual([{ kind: "scan", nonce: NONCE }]);
  });

  test.each([
    [{ active: true, url: "https://www.indeed.com/apply" }, "blocked_host"],
    [{ active: true, url: "https://ph.jobstreet.com/job/1" }, "blocked_host"],
    [{ active: false, url: "https://jobs.example/apply" }, "not_active"],
    [{ active: true, url: "chrome://settings" }, "unsupported_url"],
    [{ active: true, url: null }, "unsupported_url"],
  ] satisfies [FakeTab, TabRefusal][])("%o is refused before injection: %p", async (tab, reason) => {
    const deps = fakeDeps({ tab, reply: scanReply });
    expect(await scanTab({ deps, tabId: 7 })).toEqual({ kind: "refused", reason });
    expect(deps.injected).toEqual([]);
    expect(deps.sent).toEqual([]);
  });

  test("no host access or activeTab grant → permission_denied, nothing sent", async () => {
    const deps = fakeDeps({ tab: APPLY_TAB, inject: "denied", reply: scanReply });
    expect(await scanTab({ deps, tabId: 7 })).toEqual({ kind: "refused", reason: "permission_denied" });
    expect(deps.sent).toEqual([]);
  });

  test("a reply with another nonce, the wrong kind, or no reply is not trusted", async () => {
    for (const reply of [
      () => ({ ...scanReply({ kind: "scan", nonce: NONCE }), nonce: "another-nonce-000001" }),
      () => ({ kind: "fill_result", nonce: NONCE, filled: [], skipped: [] }),
      () => ({ ...scanReply({ kind: "scan", nonce: NONCE }), extra: "#first" }),
      () => undefined,
    ]) {
      const deps = fakeDeps({ tab: APPLY_TAB, reply });
      expect(await scanTab({ deps, tabId: 7 })).toEqual({ kind: "refused", reason: "bad_reply" });
    }
  });

  test("newScanNonce fits the contract and differs each call", () => {
    const a = newScanNonce();
    expect(ScanNonce.safeParse(a).success).toBe(true);
    expect(newScanNonce()).not.toBe(a);
  });
});

// ---------- Origin permissions ----------

function fakePermissions(granted: string[] = []): PermissionsApi & { granted: string[]; requested: string[][] } {
  const state = { granted: [...granted], requested: [] as string[][] };
  return {
    ...state,
    get granted() {
      return state.granted;
    },
    get requested() {
      return state.requested;
    },
    async request({ origins }) {
      state.requested.push(origins);
      state.granted.push(...origins);
      return true;
    },
    async remove({ origins }) {
      state.granted = state.granted.filter((o) => !origins.includes(o));
      return true;
    },
    async contains({ origins }) {
      return origins.every((o) => state.granted.includes(o));
    },
    async getAll() {
      return { origins: [...state.granted] };
    },
  };
}

describe("origin permissions", () => {
  test("approvalFor: https only, one origin, never a blocked host", () => {
    expect(approvalFor("https://boards.example.com/jobs/1?x=1")).toEqual({
      kind: "approvable",
      origin: "https://boards.example.com",
      pattern: "https://boards.example.com/*",
    });
    expect(approvalFor("http://boards.example.com/")).toEqual({ kind: "refused", reason: "unsupported_url" });
    expect(approvalFor("chrome://extensions")).toEqual({ kind: "refused", reason: "unsupported_url" });
    expect(approvalFor("https://www.linkedin.com/jobs/1")).toEqual({ kind: "refused", reason: "blocked_host" });
  });

  test("requestOriginAccess asks for exactly the page's origin, and never for a blocked host", async () => {
    const permissions = fakePermissions();
    expect(await requestOriginAccess({ url: "https://jobs.example/apply", permissions })).toEqual({
      kind: "granted",
      origin: "https://jobs.example",
    });
    expect(permissions.requested).toEqual([["https://jobs.example/*"]]);

    expect(await requestOriginAccess({ url: "https://glassdoor.com/job/1", permissions })).toEqual({
      kind: "refused",
      reason: "blocked_host",
    });
    expect(permissions.requested).toHaveLength(1);
  });

  test("granted origins in storage mirror Chrome's grants, minus loopback, wildcards and blocked hosts", async () => {
    const local = memoryArea();
    const store = createStore({ local, session: memoryArea() });
    const permissions = fakePermissions([
      "http://localhost/*",
      "https://jobs.example/*",
      "https://*/*",
      "https://www.linkedin.com/*",
    ]);
    expect(await syncGrantedOrigins({ store, permissions })).toEqual(["https://jobs.example"]);
    expect((await store.readLocal()).grantedOrigins).toEqual(["https://jobs.example"]);

    expect(await revokeOriginAccess({ origin: "https://jobs.example", store, permissions })).toEqual([]);
    expect(permissions.granted).not.toContain("https://jobs.example/*");
    expect((await store.readLocal()).grantedOrigins).toEqual([]);
  });
});
