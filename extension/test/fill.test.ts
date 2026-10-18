import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type FieldDescriptor,
  FieldId,
  type FillEntry,
  type FillValue,
  type RuntimeMessage,
  ScanNonce,
} from "@shared/extension";
import { Window } from "happy-dom";
import { type ContentDeps, fillTab } from "../src/background/content";
import { createContentHandler } from "../src/content/index";
import { createStore, type KeyValueArea } from "../src/state/storage";

const FIXTURE = join(import.meta.dir, "fixtures", "generic.html");
const ASHBY = join(import.meta.dir, "fixtures", "ashby.html");
const GREENHOUSE = join(import.meta.dir, "fixtures", "greenhouse.html");
const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const OTHER_NONCE = ScanNonce.parse("scan-nonce-0000000002");
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

/** See scan.test.ts: one cast from happy-dom's classes to lib.dom's, at the test boundary. */
async function openFixture(url = "https://jobs.example/apply", fixture = FIXTURE): Promise<Document> {
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(await Bun.file(fixture).text());
  return window.document as unknown as Document;
}

function query<T extends Element>(document: Document, selector: string, kind: { new (): T } | undefined): T {
  const found = document.querySelector(selector);
  if (found === null || kind === undefined || !(found instanceof kind)) throw new Error(`fixture lacks ${selector}`);
  return found;
}
const input = (d: Document, name: string) => query(d, `[name="${name}"]`, d.defaultView?.HTMLInputElement);
const select = (d: Document, name: string) => query(d, `[name="${name}"]`, d.defaultView?.HTMLSelectElement);
const textarea = (d: Document, name: string) => query(d, `[name="${name}"]`, d.defaultView?.HTMLTextAreaElement);

/** Scan the fixture through the content handler; returns field ids by `name` and a fill helper. */
async function scanned(url?: string, { fixture = FIXTURE, prepare = () => {} }: ScanSetup = {}) {
  const document = await openFixture(url, fixture);
  prepare(document);
  const handle = createContentHandler({ document, measure: () => null });
  const reply = handle({ kind: "scan", nonce: NONCE });
  if (reply?.kind !== "scan_result") throw new Error("scan failed");
  const fields = reply.fields;
  const ids = new Map(reply.fields.map((f) => [f.name ?? "", f.fieldId]));
  const id = (name: string): FieldId => {
    const found = ids.get(name);
    if (found === undefined) throw new Error(`no field ${name}`);
    return found;
  };
  const fill = (entries: FillEntry[], nonce: ScanNonce = NONCE) => {
    const result = handle({ kind: "fill", nonce, entries });
    if (result?.kind !== "fill_result") throw new Error("fill failed");
    return result;
  };
  return { document, handle, id, fill, fields };
}
type ScanSetup = { fixture?: string; prepare?: (document: Document) => void };

const text = (t: string): FillValue => ({ kind: "text", text: t });
const option = (value: string): FillValue => ({ kind: "option", value });
const checked = (on: boolean): FillValue => ({ kind: "checked", checked: on });

describe("fill", () => {
  test("writes empty fields of every kind and announces each with bubbling input and change", async () => {
    const { document, id, fill } = await scanned();
    const events: string[] = [];
    const form = query(document, "#apply", document.defaultView?.HTMLFormElement);
    for (const type of ["input", "change"]) {
      form.addEventListener(type, (e) => {
        const target = e.target;
        const name = target !== null && "name" in target ? String(target.name) : "?";
        events.push(`${type}:${name}`);
      });
    }

    const result = fill([
      { fieldId: id("first_name"), value: text("Ana") },
      { fieldId: id("email"), value: text("ana@example.com") },
      { fieldId: id("phone"), value: text("+63 917 000 0000") },
      { fieldId: id("start"), value: text("2026-11-02") },
      { fieldId: id("why"), value: text("Because.") },
      { fieldId: id("arrangement"), value: option("remote") },
      { fieldId: id("sponsorship"), value: option("no") },
      { fieldId: id("relocate"), value: checked(true) },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.filled).toHaveLength(8);
    expect(input(document, "first_name").value).toBe("Ana");
    expect(input(document, "email").value).toBe("ana@example.com");
    expect(input(document, "phone").value).toBe("+63 917 000 0000");
    expect(input(document, "start").value).toBe("2026-11-02");
    expect(textarea(document, "why").value).toBe("Because.");
    expect(select(document, "arrangement").value).toBe("remote");
    expect(query(document, '[name="sponsorship"][value="no"]', document.defaultView?.HTMLInputElement).checked).toBe(
      true,
    );
    expect(input(document, "relocate").checked).toBe(true);
    for (const name of ["first_name", "email", "phone", "start", "why", "arrangement", "sponsorship", "relocate"]) {
      expect(events).toContain(`input:${name}`);
      expect(events).toContain(`change:${name}`);
    }
  });

  test("React-style controlled input: the value goes through the native setter, not the instance override", async () => {
    const { document, id, fill } = await scanned();
    const element = input(document, "first_name");
    // What React does: an own `value` property that records the last value it saw, so an
    // `input` event only counts as a change when the DOM value differs from that record.
    const proto = Object.getPrototypeOf(element);
    const native = Object.getOwnPropertyDescriptor(proto, "value");
    if (native?.get === undefined || native.set === undefined) throw new Error("no native value accessor");
    const { get, set } = native;
    let tracked = "";
    Object.defineProperty(element, "value", {
      configurable: true,
      get() {
        return get.call(this);
      },
      set(v: string) {
        tracked = String(v);
        set.call(this, v);
      },
    });
    const onChange: string[] = [];
    element.addEventListener("input", () => {
      const current = get.call(element);
      if (current !== tracked) {
        tracked = current;
        onChange.push(current);
      }
    });

    expect(fill([{ fieldId: id("first_name"), value: text("Ana") }]).filled).toEqual([id("first_name")]);
    expect(onChange).toEqual(["Ana"]);
  });

  test("an existing value is never overwritten, whether typed by the user or in the markup", async () => {
    const { document, id, fill } = await scanned();
    input(document, "last_name").value = "Typed by user";
    const result = fill([
      { fieldId: id("location"), value: text("Cebu") },
      { fieldId: id("last_name"), value: text("Reyes") },
    ]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([
      { fieldId: id("location"), reason: "not_empty" },
      { fieldId: id("last_name"), reason: "not_empty" },
    ]);
    expect(input(document, "location").value).toBe("Manila");
    expect(input(document, "last_name").value).toBe("Typed by user");
  });

  test("a chosen select option, radio or ticked checkbox counts as non-empty", async () => {
    const { document, id, fill } = await scanned();
    select(document, "arrangement").value = "hybrid";
    query(document, '[name="sponsorship"][value="yes"]', document.defaultView?.HTMLInputElement).checked = true;
    input(document, "relocate").checked = true;
    const result = fill([
      { fieldId: id("arrangement"), value: option("remote") },
      { fieldId: id("sponsorship"), value: option("no") },
      { fieldId: id("relocate"), value: checked(false) },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["not_empty", "not_empty", "not_empty"]);
    expect(select(document, "arrangement").value).toBe("hybrid");
    expect(input(document, "relocate").checked).toBe(true);
  });

  test("salary is never filled, even when the plan asks", async () => {
    const { document, id, fill } = await scanned();
    const result = fill([{ fieldId: id("rate"), value: text("100000") }]);
    expect(result).toMatchObject({ filled: [], skipped: [{ fieldId: id("rate"), reason: "salary" }] });
    expect(input(document, "rate").value).toBe("");
  });

  test("file inputs are never touched", async () => {
    const { document, id, fill } = await scanned();
    const result = fill([{ fieldId: id("resume"), value: text("C:\\fakepath\\resume.pdf") }]);
    expect(result.skipped).toEqual([{ fieldId: id("resume"), reason: "file_field" }]);
    expect(input(document, "resume").value).toBe("");
    expect(input(document, "resume").files?.length ?? 0).toBe(0);
  });

  test("a field hidden, disabled or made read-only after the scan is skipped", async () => {
    const { document, id, fill } = await scanned();
    input(document, "email").style.display = "none";
    input(document, "phone").disabled = true;
    input(document, "linkedin").readOnly = true;
    const result = fill([
      { fieldId: id("email"), value: text("ana@example.com") },
      { fieldId: id("phone"), value: text("1") },
      { fieldId: id("linkedin"), value: text("https://linkedin.com/in/ana") },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["hidden", "disabled", "read_only"]);
    expect(input(document, "email").value).toBe("");
  });

  test("stale fields are rejected: changed label, changed options, removed or unknown field", async () => {
    const { document, id, fill } = await scanned();
    const firstLabel = query(document, 'label[for="first"]', document.defaultView?.HTMLLabelElement);
    firstLabel.textContent = "Expected salary";
    const extra = document.createElement("option");
    extra.value = "four_day_week";
    extra.textContent = "Four-day week";
    select(document, "arrangement").append(extra);
    input(document, "years").remove();

    const result = fill([
      { fieldId: id("first_name"), value: text("Ana") },
      { fieldId: id("arrangement"), value: option("remote") },
      { fieldId: id("years"), value: text("5") },
      { fieldId: FieldId.parse("unknown-field"), value: text("x") },
    ]);
    expect(result.filled).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["stale", "stale", "missing", "missing"]);
    expect(input(document, "first_name").value).toBe("");
    expect(select(document, "arrangement").value).toBe("");
  });

  test("an option the descriptor did not offer, a disabled option or the wrong value kind is not written", async () => {
    const { document, id, fill } = await scanned();
    const result = fill([
      { fieldId: id("arrangement"), value: option("onsite") },
      { fieldId: id("sponsorship"), value: option("maybe") },
      { fieldId: id("relocate"), value: text("yes") },
      { fieldId: id("first_name"), value: checked(true) },
      { fieldId: id("start"), value: text("next Monday") },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "no_matching_option",
      "no_matching_option",
      "no_matching_option",
      "no_matching_option",
      "no_matching_option",
    ]);
    expect(select(document, "arrangement").value).toBe("");
    expect(input(document, "start").value).toBe("");
  });

  test("a plan for another scan, or before any scan, writes nothing and reports every entry stale", async () => {
    const { document, id, fill } = await scanned();
    const result = fill([{ fieldId: id("first_name"), value: text("Ana") }], OTHER_NONCE);
    expect(result).toEqual({
      kind: "fill_result",
      nonce: OTHER_NONCE,
      filled: [],
      skipped: [{ fieldId: id("first_name"), reason: "stale" }],
    });
    expect(input(document, "first_name").value).toBe("");

    const fresh = createContentHandler({ document, measure: () => null });
    expect(
      fresh({ kind: "fill", nonce: NONCE, entries: [{ fieldId: id("first_name"), value: text("Ana") }] }),
    ).toMatchObject({
      filled: [],
      skipped: [{ reason: "stale" }],
    });
    expect(input(document, "first_name").value).toBe("");
  });

  test("a new scan retires the previous nonce", async () => {
    const { handle, id, fill } = await scanned();
    const old = id("first_name");
    handle({ kind: "scan", nonce: OTHER_NONCE });
    expect(fill([{ fieldId: old, value: text("Ana") }], NONCE).skipped).toEqual([{ fieldId: old, reason: "stale" }]);
  });

  test("never submits the form or clicks a button", async () => {
    const { document, id, fill } = await scanned();
    let submits = 0;
    let buttonClicks = 0;
    query(document, "#apply", document.defaultView?.HTMLFormElement).addEventListener("submit", (e) => {
      submits += 1;
      e.preventDefault();
    });
    query(document, "#submit", document.defaultView?.HTMLButtonElement).addEventListener("click", () => {
      buttonClicks += 1;
    });
    fill([
      { fieldId: id("first_name"), value: text("Ana") },
      { fieldId: id("sponsorship"), value: option("yes") },
      { fieldId: id("relocate"), value: checked(true) },
    ]);
    expect(submits).toBe(0);
    expect(buttonClicks).toBe(0);
  });

  test("radios without a value attribute (Ashby EEOC): fill checks the radio the plan names, not the first", async () => {
    // Every option of these groups reads as value "on". Real markup: tests/fixtures/ashby.html.
    const { document, fields, fill } = await scanned("https://jobs.ashbyhq.com/replit/x/application", {
      fixture: ASHBY,
    });
    const gender = fields.find((f) => f.name?.endsWith("__systemfield_eeoc_gender"));
    if (gender === undefined) throw new Error("no gender field");
    expect(gender.options.map((o) => o.label)).toEqual(["Male", "Female", "Decline to self-identify"]);
    expect(new Set(gender.options.map((o) => o.value)).size).toBe(3);
    const female = gender.options.find((o) => o.label === "Female");
    if (female === undefined) throw new Error("no Female option");

    const result = fill([{ fieldId: gender.fieldId, value: option(female.value) }]);

    expect(result).toMatchObject({ filled: [gender.fieldId], skipped: [] });
    const radios = Array.from(document.querySelectorAll(`input[name="${gender.name}"]`));
    expect(radios.map((r) => "checked" in r && r.checked)).toEqual([false, true, false]);
  });

  test("Greenhouse comboboxes are reported as comboboxes and never filled, whatever the plan says", async () => {
    const { document, fields, fill } = await scanned("https://job-boards.greenhouse.io/justworks/jobs/5104078", {
      fixture: GREENHOUSE,
    });
    const byLabel = (label: string) => {
      const found = fields.find((f) => f.label === label);
      if (found === undefined) throw new Error(`no field ${label}`);
      return found;
    };
    const gender = byLabel("Gender");
    const workAuth = byLabel("Are you currently authorized to work in the U.S. on a full-time basis?");
    expect([gender, workAuth].map((f) => [f.control, f.adapterCategory, f.autocomplete])).toEqual([
      ["combobox", null, null],
      ["combobox", null, null],
    ]);
    const before = Array.from(document.querySelectorAll('[role="combobox"]')).map((e) => [
      e.id,
      "value" in e ? e.value : null,
    ]);

    const result = fill([
      { fieldId: gender.fieldId, value: text("Female") },
      { fieldId: workAuth.fieldId, value: option("Yes") },
      { fieldId: byLabel("First Name").fieldId, value: text("Ana") },
    ]);
    expect(result.filled).toEqual([byLabel("First Name").fieldId]);
    expect(result.skipped).toEqual([
      { fieldId: gender.fieldId, reason: "no_matching_option" },
      { fieldId: workAuth.fieldId, reason: "no_matching_option" },
    ]);
    const after = Array.from(document.querySelectorAll('[role="combobox"]')).map((e) => [
      e.id,
      "value" in e ? e.value : null,
    ]);
    expect(after).toEqual(before);
  });

  test("every type-ahead marker makes a combobox: role, aria-autocomplete list|both, aria-haspopup=listbox", async () => {
    const markers = [
      'role="combobox"',
      'aria-autocomplete="list"',
      'aria-autocomplete="both"',
      'aria-haspopup="listbox"',
    ];
    const { document, fields, id, fill } = await scanned(undefined, {
      prepare: (d) =>
        d
          .querySelector("#apply")
          ?.insertAdjacentHTML(
            "beforeend",
            markers
              .map((m, i) => `<label>Country ${i} <input name="widget${i}" autocomplete="email" ${m} /></label>`)
              .join(""),
          ),
    });
    const widgets = markers.map((_, i) => fields.find((f) => f.name === `widget${i}`));
    expect(widgets.map((f) => [f?.control, f?.autocomplete])).toEqual(markers.map(() => ["combobox", null]));
    const result = fill(markers.map((_, i) => ({ fieldId: id(`widget${i}`), value: text("Philippines") })));
    expect(result.skipped.map((s) => s.reason)).toEqual(markers.map(() => "no_matching_option"));
    expect(markers.map((_, i) => input(document, `widget${i}`).value)).toEqual(markers.map(() => ""));
  });

  test("a text box that turns into a combobox after the scan is refused, not typed into", async () => {
    const { document, id, fill } = await scanned();
    input(document, "linkedin").setAttribute("role", "combobox");
    expect(fill([{ fieldId: id("linkedin"), value: text("https://linkedin.com/in/ana") }]).skipped).toEqual([
      { fieldId: id("linkedin"), reason: "no_matching_option" },
    ]);
    expect(input(document, "linkedin").value).toBe("");
  });

  test("aria-autocomplete inline or none is still a plain text box", async () => {
    const { fields } = await scanned(undefined, {
      prepare: (d) =>
        d
          .querySelector("#apply")
          ?.insertAdjacentHTML(
            "beforeend",
            '<label>City <input name="inline" aria-autocomplete="inline" /></label><label>Town <input name="none" aria-autocomplete="none" aria-haspopup="menu" /></label>',
          ),
    });
    expect(["inline", "none"].map((n) => fields.find((f) => f.name === n)?.control)).toEqual(["text", "text"]);
  });

  test("a token names the scanned radio: a reorder still checks it, a relabel is stale", async () => {
    const setup = { fixture: ASHBY };
    const url = "https://jobs.ashbyhq.com/replit/x/application";
    const genderOf = (fields: readonly FieldDescriptor[]) => {
      const gender = fields.find((f) => f.name?.endsWith("__systemfield_eeoc_gender"));
      const female = gender?.options.find((o) => o.label === "Female");
      if (gender === undefined || female === undefined) throw new Error("no gender field");
      return { gender, female, selector: `input[name="${gender.name}"]` };
    };

    // The page moves "Female" first after the scan.
    const moved = await scanned(url, setup);
    const a = genderOf(moved.fields);
    const [maleRow, femaleRow] = Array.from(moved.document.querySelectorAll(a.selector)).map(
      (r) => r.parentElement?.parentElement,
    );
    if (maleRow == null || femaleRow == null) throw new Error("fixture changed");
    maleRow.before(femaleRow);
    expect(moved.fill([{ fieldId: a.gender.fieldId, value: option(a.female.value) }]).filled).toEqual([
      a.gender.fieldId,
    ]);
    const checkedLabel = moved.document.querySelector(`${a.selector}:checked`)?.id ?? "";
    expect(moved.document.querySelector(`label[for="${checkedLabel}"]`)?.textContent).toBe("Female");

    // The page re-renders the same radios with other labels: the plan no longer fits.
    const relabelled = await scanned(url, setup);
    const b = genderOf(relabelled.fields);
    const labels = Array.from(relabelled.document.querySelectorAll(a.selector)).map((r) =>
      relabelled.document.querySelector(`label[for="${r.id}"]`),
    );
    const [first, second] = labels;
    if (first == null || second == null) throw new Error("fixture changed");
    [first.textContent, second.textContent] = ["Female", "Male"];
    expect(relabelled.fill([{ fieldId: b.gender.fieldId, value: option(b.female.value) }]).skipped).toEqual([
      { fieldId: b.gender.fieldId, reason: "stale" },
    ]);
    expect(relabelled.document.querySelectorAll(`${b.selector}:checked`)).toHaveLength(0);
  });

  test("select options sharing a value: fill selects the option the plan names, and a raw shared value is refused", async () => {
    const { document, fields, fill } = await scanned(undefined, {
      prepare: (d) => {
        const extra = d.createElement("select");
        extra.name = "dup";
        extra.setAttribute("aria-label", "Pronouns");
        for (const [value, label] of [
          ["", "Select ..."],
          ["other", "He/him"],
          ["other", "She/her"],
        ]) {
          const o = d.createElement("option");
          o.value = value ?? "";
          o.textContent = label ?? "";
          extra.append(o);
        }
        query(d, "#apply", d.defaultView?.HTMLFormElement).append(extra);
      },
    });
    const dup = fields.find((f) => f.name === "dup");
    if (dup === undefined) throw new Error("no dup field");
    const values = dup.options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    const she = dup.options.find((o) => o.label === "She/her");
    if (she === undefined) throw new Error("no She/her option");

    expect(fill([{ fieldId: dup.fieldId, value: option("other") }]).skipped).toEqual([
      { fieldId: dup.fieldId, reason: "no_matching_option" },
    ]);
    expect(fill([{ fieldId: dup.fieldId, value: option(she.value) }]).filled).toEqual([dup.fieldId]);
    const element = select(document, "dup");
    expect(element.selectedOptions[0]?.textContent).toBe("She/her");
  });

  test("on a blocked host the content script answers nothing and writes nothing", async () => {
    const document = await openFixture("https://ph.jobstreet.com/job/1/apply");
    const handle = createContentHandler({ document, measure: () => null });
    expect(handle({ kind: "scan", nonce: NONCE })).toBeNull();
    expect(handle({ kind: "fill", nonce: NONCE, entries: [] })).toBeNull();
    expect(input(document, "first_name").value).toBe("");
  });
});

// ---------- Worker side ----------

function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea {
  const data: Record<string, unknown> = { ...initial };
  return {
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

const BINDING = {
  sessionId: "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b",
  opportunityId: "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d",
  tabId: 7,
  claimedAt: 1,
};
const FIELD = FieldId.parse("abcDEF123456");
const PLAN = { nonce: NONCE, entries: [{ fieldId: FIELD, value: text("Ana") }] };

function fillDeps({
  url = "https://jobs.example/apply",
  bound = true,
  reply,
}: {
  url?: string;
  bound?: boolean;
  reply: (message: RuntimeMessage) => unknown;
}): ContentDeps & { sent: RuntimeMessage[] } {
  const sent: RuntimeMessage[] = [];
  return {
    sent,
    store: createStore({ local: memoryArea(), session: memoryArea(bound ? { binding: BINDING } : {}) }),
    getTab: async () => ({ active: true, url }),
    inject: async () => "ok",
    send: async (_tabId, message) => {
      sent.push(message);
      return reply(message);
    },
    newNonce: () => NONCE,
  };
}

describe("fillTab (worker)", () => {
  const ok = () => ({ kind: "fill_result", nonce: NONCE, filled: [FIELD], skipped: [] });

  test("sends the plan to the bound tab and returns the checked result", async () => {
    const deps = fillDeps({ reply: ok });
    expect(await fillTab({ deps, tabId: 7, plan: PLAN })).toEqual({
      kind: "filled",
      result: { kind: "fill_result", nonce: NONCE, filled: [FIELD], skipped: [] },
    });
    expect(deps.sent).toEqual([{ kind: "fill", ...PLAN }]);
  });

  test("refuses a tab without the session binding, or another tab", async () => {
    for (const [bound, tabId] of [
      [false, 7],
      [true, 8],
    ] as const) {
      const deps = fillDeps({ bound, reply: ok });
      expect(await fillTab({ deps, tabId, plan: PLAN })).toEqual({ kind: "refused", reason: "not_bound" });
      expect(deps.sent).toEqual([]);
    }
  });

  test("refuses a blocked host before sending anything", async () => {
    const deps = fillDeps({ url: "https://www.upwork.com/apply", reply: ok });
    expect(await fillTab({ deps, tabId: 7, plan: PLAN })).toEqual({ kind: "refused", reason: "blocked_host" });
    expect(deps.sent).toEqual([]);
  });

  test("a result naming fields outside the plan, or for another nonce, is not trusted", async () => {
    for (const reply of [
      () => ({ kind: "fill_result", nonce: NONCE, filled: ["zzzzzzzzzzzz"], skipped: [] }),
      () => ({ kind: "fill_result", nonce: OTHER_NONCE, filled: [FIELD], skipped: [] }),
      () => Promise.reject(new Error("Receiving end does not exist")),
    ]) {
      const deps = fillDeps({ reply });
      expect(await fillTab({ deps, tabId: 7, plan: PLAN })).toEqual({ kind: "refused", reason: "bad_reply" });
    }
  });
});
