import { afterEach, describe, expect, test } from "bun:test";
import { FieldId, ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { claimInstall, createContentHandler } from "../src/content/index";
import { bytesToBase64 } from "../src/messages-attach";
import type { ImportContentReply } from "../src/messages-import";

// The content script's message switch (content/index.ts): which worker requests it answers, that
// a blocked host answers none, and when it counts the page as having shown an application form
// (`formSeen`, which lets a success probe answer `form_gone`).

const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const OTHER_NONCE = ScanNonce.parse("scan-nonce-0000000002");
const PROBE_NONCE = ScanNonce.parse("probe-nonce-000000001");
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

const FORM = `
  <main>
    <h1>Data Analyst</h1>
    <p>Acme is hiring a data analyst to build reports and dashboards for the sales team.</p>
    <form id="form">
      <label for="name">Full name</label><input id="name" name="name" type="text" />
      <label for="email">Email</label><input id="email" name="email" type="email" />
      <label for="resume">Resume</label><input id="resume" name="resume" type="file" accept=".pdf" />
    </form>
  </main>`;

function openPage({ url = "https://jobs.example/apply", html = FORM }: { url?: string; html?: string } = {}) {
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(html);
  // happy-dom's classes are not the lib.dom types; the one cast lives at this test boundary.
  const document = window.document as unknown as Document;
  const handle = createContentHandler({ document, measure: () => null });
  const removeForm = () => document.getElementById("form")?.remove();
  const probe = () => handle({ kind: "success_probe", nonce: PROBE_NONCE });
  const scan = () => {
    const reply = handle({ kind: "scan", nonce: NONCE });
    if (reply?.kind !== "scan_result") throw new Error("scan failed");
    const id = (name: string): FieldId => {
      const found = reply.fields.find((f) => f.name === name);
      if (found === undefined) throw new Error(`no field ${name}`);
      return found.fieldId;
    };
    return { id };
  };
  return { handle, removeForm, probe, scan };
}

function attachMessage(fieldId: FieldId, nonce: ScanNonce = NONCE) {
  return {
    kind: "attach",
    nonce,
    fieldId,
    fileName: "Resume.pdf",
    mimeType: "application/pdf",
    dataBase64: bytesToBase64(PDF),
  };
}

const notGone: ImportContentReply = { kind: "success_probe_result", nonce: PROBE_NONCE, reason: null };
const gone: ImportContentReply = { kind: "success_probe_result", nonce: PROBE_NONCE, reason: "form_gone" };

describe("content handler: routing", () => {
  test("attach goes to the scanned file input", () => {
    const page = openPage();
    const { id } = page.scan();
    expect(page.handle(attachMessage(id("resume")))).toEqual({
      kind: "attach_result",
      nonce: NONCE,
      fieldId: id("resume"),
      result: { kind: "attached" },
    });
  });

  test("read_job answers with the visible job, under the worker's nonce", () => {
    const page = openPage();
    const reply = page.handle({ kind: "read_job", nonce: PROBE_NONCE });
    expect(reply).toMatchObject({ kind: "read_job_result", nonce: PROBE_NONCE, draft: { title: "Data Analyst" } });
  });

  test("success_probe answers with a reason code only", () => {
    const page = openPage({ url: "https://jobs.example/apply/thank-you" });
    expect(page.probe()).toEqual({ kind: "success_probe_result", nonce: PROBE_NONCE, reason: "confirmation_url" });
  });

  test("a request with extra keys gets no answer", () => {
    const page = openPage();
    expect(page.handle({ kind: "read_job", nonce: PROBE_NONCE, selector: "#x" })).toBeNull();
    expect(page.handle({ kind: "success_probe", nonce: PROBE_NONCE, reason: "form_gone" })).toBeNull();
  });

  test("results and unknown kinds sent to the page get no answer", () => {
    const page = openPage();
    expect(page.handle({ kind: "success_probe_result", nonce: PROBE_NONCE, reason: "form_gone" })).toBeNull();
    expect(page.handle({ kind: "success_signal", reason: "form_gone" })).toBeNull();
    expect(page.handle({ kind: "extract_page", nonce: NONCE })).toBeNull();
  });
});

describe("content handler: blocked hosts", () => {
  test("scan, fill, attach, read_job and success_probe all go unanswered", () => {
    const page = openPage({ url: "https://www.linkedin.com/jobs/view/1" });
    const field = FieldId.parse("f1");
    for (const message of [
      { kind: "scan", nonce: NONCE },
      { kind: "fill", nonce: NONCE, entries: [] },
      attachMessage(field),
      { kind: "read_job", nonce: PROBE_NONCE },
      { kind: "success_probe", nonce: PROBE_NONCE },
    ]) {
      expect(page.handle(message)).toBeNull();
    }
  });
});

describe("content handler: formSeen", () => {
  test("a form that was never scanned, filled or attached to is not a success when it goes", () => {
    const page = openPage();
    expect(page.probe()).toEqual(notGone);
    page.removeForm();
    expect(page.probe()).toEqual(notGone);
  });

  test("a stale fill or attach (no matching scan) does not count", () => {
    const page = openPage();
    const field = FieldId.parse("f1");
    expect(page.handle({ kind: "fill", nonce: OTHER_NONCE, entries: [] })).toMatchObject({ kind: "fill_result" });
    expect(page.handle(attachMessage(field, OTHER_NONCE))).toMatchObject({
      result: { kind: "rejected", reason: "stale" },
    });
    page.removeForm();
    expect(page.probe()).toEqual(notGone);
  });

  test("a scan that found no fields does not count", () => {
    const page = openPage({ html: "<main><h1>Data Analyst</h1><p>Read about the role.</p></main>" });
    page.scan();
    expect(page.probe()).toEqual(notGone);
  });

  test("a page with one stray search box never counts, even scanned and filled", () => {
    const html = `
      <header><form id="form" role="search">
        <label for="q">Search jobs</label><input id="q" name="q" type="text" />
      </form></header>
      <main><h1>Data Analyst</h1><p>Read about the role.</p></main>`;
    const page = openPage({ html });
    const { id } = page.scan();
    const filled = page.handle({
      kind: "fill",
      nonce: NONCE,
      entries: [{ fieldId: id("q"), value: { kind: "text", text: "x" } }],
    });
    expect(filled).toMatchObject({ kind: "fill_result", filled: [id("q")] });
    expect(page.probe()).toEqual(notGone);
    page.removeForm();
    expect(page.probe()).toEqual(notGone);
  });

  test("after a scan found fields, the form going away reads as form_gone", () => {
    const page = openPage();
    page.scan();
    expect(page.probe()).toEqual(notGone);
    page.removeForm();
    expect(page.probe()).toEqual(gone);
  });

  test("a later scan of the confirmation page does not forget the form", () => {
    const page = openPage();
    page.scan();
    page.removeForm();
    page.scan();
    expect(page.probe()).toEqual(gone);
  });
});

describe("install guard", () => {
  test("the first injection claims the slot and a second one does not", () => {
    const scope = {};
    expect(claimInstall(scope)).toBe(true);
    expect(claimInstall(scope)).toBe(false);
  });

  test("a page that got the script before the Rolecraft rename keeps its single listener", () => {
    expect(claimInstall({ hanapbuhayContentInstalled: true })).toBe(false);
  });

  test("sets both markers, so the old build also sees the slot as taken", () => {
    const scope = {};
    claimInstall(scope);
    expect(scope).toEqual({ rolecraftContentInstalled: true, hanapbuhayContentInstalled: true });
  });
});
