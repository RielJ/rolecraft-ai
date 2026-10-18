import { afterEach, describe, expect, test } from "bun:test";
import { OutputId } from "@shared/api";
import { ApplicationSessionId, FieldId, MAX_ATTACHMENT_BYTES, RuntimeMessage, ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { createClient } from "../src/api/client";
import type { TabRefusal } from "../src/background/content";
import { type AttachDeps, attachFileName, dispositionFileName, handleAttach } from "../src/background/files";
import { acceptsPdf, attachFile, type CurrentScan } from "../src/content/files";
import { type Box, type Measure, scanDocument } from "../src/content/scan";
import { ConnectionStatus, PanelRequest, PanelResult } from "../src/messages";
import { type AttachMessage, AttachRequests, base64ToBytes, bytesToBase64, isPdf } from "../src/messages-attach";
import {
  type AttachAction,
  type AttachStatus,
  attachableOutputs,
  attachReducer,
  INITIAL_ATTACH_STATE,
  statusFromReply,
  suggestedOutput,
} from "../src/panel/Attachments";
import { createStore, type KeyValueArea } from "../src/state/storage";

const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const OTHER_NONCE = ScanNonce.parse("scan-nonce-0000000002");
const PDF = new TextEncoder().encode("%PDF-1.7\n% test file\n%%EOF\n");
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

const FORM = `
  <form id="form" action="/submit">
    <label for="name">Full name</label><input id="name" name="name" type="text" />
    <label for="resume">Resume</label><input id="resume" name="resume" type="file" accept=".pdf,.doc" />
    <label for="letter">Cover letter</label><input id="letter" name="letter" type="file" />
    <label for="photo">Photo</label><input id="photo" name="photo" type="file" accept="image/*" />
    <button type="submit">Submit</button>
  </form>`;

/**
 * A page in its own happy-dom window, scanned the way content/index.ts scans it. happy-dom's
 * classes are not the lib.dom types, so the one cast to `Document` lives here, at the test boundary.
 */
function openPage(html = FORM, measure: Measure = noLayout) {
  const window = new Window({
    url: "https://jobs.example/apply",
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(html);
  const document = window.document as unknown as Document;
  let n = 0;
  const scanned = scanDocument({ document, measure, makeId: () => FieldId.parse(`f${++n}`) });
  const current: CurrentScan = { nonce: NONCE, fields: new Map(scanned.map((f) => [f.descriptor.fieldId, f])) };
  const idOf = (name: string) => {
    const found = scanned.find((f) => f.descriptor.name === name);
    if (found === undefined) throw new Error(`no scanned field ${name}`);
    return found.descriptor.fieldId;
  };
  const input = (id: string) => {
    const el = document.getElementById(id);
    if (!(el instanceof window.HTMLInputElement)) throw new Error(`no input ${id}`);
    return el as unknown as HTMLInputElement;
  };
  const events: string[] = [];
  for (const type of ["input", "change", "submit", "click"]) {
    document.addEventListener(type, (e) => events.push(`${type}:${(e.target as Element).id}`), true);
  }
  return { document, current, idOf, input, events, window };
}

const noLayout = () => null;

function message(fieldId: FieldId, overrides: Partial<AttachMessage> = {}): AttachMessage {
  return {
    kind: "attach",
    nonce: NONCE,
    fieldId,
    fileName: "Ada Lovelace - Acme - Resume.pdf",
    mimeType: "application/pdf",
    dataBase64: bytesToBase64(PDF),
    ...overrides,
  };
}

describe("attachFile", () => {
  test("sets the PDF on the scanned empty input, announces it, and never submits", async () => {
    const page = openPage();
    const reply = attachFile({ current: page.current, message: message(page.idOf("resume")), measure: noLayout });

    expect(reply).toEqual({
      kind: "attach_result",
      nonce: NONCE,
      fieldId: page.idOf("resume"),
      result: { kind: "attached" },
    });
    const files = page.input("resume").files;
    expect(files?.length).toBe(1);
    const file = files?.[0];
    expect(file?.name).toBe("Ada Lovelace - Acme - Resume.pdf");
    expect(file?.type).toBe("application/pdf");
    expect(new Uint8Array((await file?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PDF);
    expect(page.events).toEqual(["input:resume", "change:resume"]);
    // Nothing else on the page changed.
    expect(page.input("letter").files?.length ?? 0).toBe(0);
  });

  test("a visually hidden upload input behind a styled button is attached, with the same rule the scan used", () => {
    // Greenhouse's markup: the native input and its label are `visually-hidden` (1×1); the
    // "Attach" button next to them is what the user sees.
    const html = `
      <form>
        <div class="upload"><button type="button">Attach</button>
          <label class="visually-hidden" for="resume">Attach</label>
          <input id="resume" name="resume" class="visually-hidden" type="file" accept=".pdf,.doc" />
        </div>
      </form>`;
    const measure = (element: Element): Box =>
      element.classList.contains("visually-hidden")
        ? { left: 10, top: 10, width: 1, height: 1 }
        : { left: 10, top: 10, width: 200, height: 32 };
    const page = openPage(html, measure);
    const reply = attachFile({ current: page.current, message: message(page.idOf("resume")), measure });
    expect(reply.result).toEqual({ kind: "attached" });
    expect(page.input("resume").files?.length).toBe(1);

    // Hide the button between scan and attach: now nothing on the page stands for the input.
    const again = openPage(html, measure);
    again.document.querySelector("button")?.setAttribute("hidden", "");
    const stale = attachFile({ current: again.current, message: message(again.idOf("resume")), measure });
    expect(stale.result).toEqual({ kind: "rejected", reason: "stale" });
  });

  test("an input without an accept attribute takes the PDF", () => {
    const page = openPage();
    const reply = attachFile({ current: page.current, message: message(page.idOf("letter")), measure: noLayout });
    expect(reply.result).toEqual({ kind: "attached" });
  });

  test("a message for an older scan is stale and writes nothing", () => {
    const page = openPage();
    const reply = attachFile({
      current: page.current,
      message: message(page.idOf("resume"), { nonce: OTHER_NONCE }),
      measure: noLayout,
    });
    expect(reply).toMatchObject({ nonce: OTHER_NONCE, result: { kind: "rejected", reason: "stale" } });
    expect(page.input("resume").files?.length ?? 0).toBe(0);
    expect(page.events).toEqual([]);
  });

  test("no scan yet, or a field id the scan never issued, is stale", () => {
    const page = openPage();
    expect(attachFile({ current: null, message: message(page.idOf("resume")), measure: noLayout }).result).toEqual({
      kind: "rejected",
      reason: "stale",
    });
    expect(
      attachFile({ current: page.current, message: message(FieldId.parse("nope")), measure: noLayout }).result,
    ).toEqual({ kind: "rejected", reason: "stale" });
  });

  test("a text field is not a file input", () => {
    const page = openPage();
    const reply = attachFile({ current: page.current, message: message(page.idOf("name")), measure: noLayout });
    expect(reply.result).toEqual({ kind: "rejected", reason: "not_file_input" });
    expect(page.input("name").value).toBe("");
  });

  test("an input that already holds a file is left alone", () => {
    const page = openPage();
    const resume = page.input("resume");
    const existing = new page.window.DataTransfer();
    existing.items.add(new page.window.File(["x"], "mine.pdf", { type: "application/pdf" }));
    resume.files = existing.files as unknown as FileList;

    const reply = attachFile({ current: page.current, message: message(page.idOf("resume")), measure: noLayout });
    expect(reply.result).toEqual({ kind: "rejected", reason: "not_empty" });
    expect(resume.files?.[0]?.name).toBe("mine.pdf");
    expect(page.events).toEqual([]);
  });

  test("an input whose accept list has no PDF is the wrong type", () => {
    const page = openPage();
    const reply = attachFile({ current: page.current, message: message(page.idOf("photo")), measure: noLayout });
    expect(reply.result).toEqual({ kind: "rejected", reason: "wrong_type" });
    expect(page.input("photo").files?.length ?? 0).toBe(0);
  });

  test("an input removed, hidden, disabled or changed since the scan is stale", () => {
    const changes: [string, (input: HTMLInputElement) => void][] = [
      ["removed", (input) => input.remove()],
      ["hidden", (input) => input.setAttribute("hidden", "")],
      ["display none", (input) => input.setAttribute("style", "display: none")],
      ["disabled", (input) => input.setAttribute("disabled", "")],
      ["relabelled", (input) => input.setAttribute("name", "other")],
    ];
    for (const [what, change] of changes) {
      const page = openPage();
      const fieldId = page.idOf("resume");
      const resume = page.input("resume");
      change(resume);
      const reply = attachFile({ current: page.current, message: message(fieldId), measure: noLayout });
      expect({ what, result: reply.result }).toEqual({ what, result: { kind: "rejected", reason: "stale" } });
      expect(resume.files?.length ?? 0).toBe(0);
    }
  });

  test("an input whose type changed since the scan is not a file input", () => {
    const page = openPage();
    const fieldId = page.idOf("resume");
    page.input("resume").setAttribute("type", "text");
    expect(attachFile({ current: page.current, message: message(fieldId), measure: noLayout }).result).toEqual({
      kind: "rejected",
      reason: "not_file_input",
    });
  });

  test("bytes that are not a PDF, or not base64, are the wrong type", () => {
    const page = openPage();
    const html = bytesToBase64(new TextEncoder().encode("<html>not a pdf</html>"));
    for (const dataBase64 of [html, "%%%not base64%%%"]) {
      const reply = attachFile({
        current: page.current,
        message: message(page.idOf("resume"), { dataBase64 }),
        measure: noLayout,
      });
      expect(reply.result).toEqual({ kind: "rejected", reason: "wrong_type" });
    }
    expect(page.input("resume").files?.length ?? 0).toBe(0);
  });

  test("a file over the cap is too large", () => {
    const page = openPage();
    const reply = attachFile({
      current: page.current,
      message: message(page.idOf("resume")),
      measure: noLayout,
      maxBytes: PDF.length - 1,
    });
    expect(reply.result).toEqual({ kind: "rejected", reason: "too_large" });
    expect(page.input("resume").files?.length ?? 0).toBe(0);
  });

  test("when the page refuses the file, it says so and announces nothing", () => {
    const page = openPage();
    const reply = attachFile({
      current: page.current,
      message: message(page.idOf("resume")),
      measure: noLayout,
      assign: () => {},
    });
    expect(reply.result).toEqual({ kind: "rejected", reason: "not_file_input" });
    expect(page.events).toEqual([]);
  });
});

describe("acceptsPdf", () => {
  test("reads the accept attribute the way a file picker does", () => {
    const cases: [string, boolean][] = [
      ["", true],
      ["  ", true],
      [".pdf", true],
      [".PDF", true],
      ["application/pdf", true],
      ["application/*", true],
      ["*/*", true],
      [".doc, .docx , .pdf", true],
      ["application/msword,.doc", false],
      ["image/*", false],
      [".pdfx", false],
    ];
    expect(cases.map(([accept]) => [accept, acceptsPdf(accept)])).toEqual(cases);
  });
});

describe("bytes", () => {
  test("base64 round-trips a file larger than one chunk", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("isPdf checks the %PDF- header", () => {
    expect(isPdf(PDF)).toBe(true);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(isPdf(new TextEncoder().encode("<!doctype html>"))).toBe(false);
  });
});

// ---------- Worker ----------

const ENDPOINT = "http://localhost:3000";
const TOKEN = "A".repeat(43);
const PAIRING_ID = "6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11";
const SESSION_ID = ApplicationSessionId.parse("0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b");
const OTHER_SESSION = ApplicationSessionId.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c");
const OPPORTUNITY_ID = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
const OUTPUT_ID = OutputId.parse("7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918");
const TAB_URL = "https://boards.example/jobs/1";
const PDF_PATH = `/api/extension/sessions/${SESSION_ID}/outputs/${OUTPUT_ID}/pdf`;

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

function pdfResponse(bytes: Uint8Array<ArrayBuffer> = PDF, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("José Ñúñez - Acme/Co - Résumé.pdf")}`,
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function worker({
  bound = { sessionId: SESSION_ID, tabId: 7 },
  paired = true,
  tab = { active: true, url: TAB_URL },
  pdf = () => pdfResponse(),
  reply,
}: {
  bound?: { sessionId: string; tabId: number } | null;
  paired?: boolean;
  tab?: { active: boolean; url: string | null } | null;
  pdf?: () => Response;
  reply?: (message: RuntimeMessage) => unknown;
} = {}) {
  const local = memoryArea(paired ? { endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: TOKEN } } : {});
  const session = memoryArea(
    bound === null ? {} : { binding: { ...bound, opportunityId: OPPORTUNITY_ID, claimedAt: 1 } },
  );
  const store = createStore({ local, session });
  const fetched: { path: string; auth: string | null }[] = [];
  const sent: RuntimeMessage[] = [];
  const downloads: { url: string; filename: string }[] = [];
  const deps: AttachDeps = {
    client: createClient({
      store,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        fetched.push({ path, auth: new Headers(init.headers).get("Authorization") });
        return path === PDF_PATH ? pdf() : new Response("{}", { status: 404 });
      },
    }),
    tabs: {
      getTab: async () => tab,
      send: async (_tabId, message) => {
        sent.push(message);
        if (reply !== undefined) return reply(message);
        return message.kind === "attach"
          ? { kind: "attach_result", nonce: message.nonce, fieldId: message.fieldId, result: { kind: "attached" } }
          : undefined;
      },
    },
    store,
    download: async (args) => {
      downloads.push(args);
      return "ok";
    },
  };
  const ask = (request: AttachRequests) => handleAttach({ deps, request });
  return { ask, fetched, sent, downloads, local, session };
}

const FIELD = FieldId.parse("f2");
const ATTACH: AttachRequests = {
  kind: "attach",
  sessionId: SESSION_ID,
  tabId: 7,
  nonce: NONCE,
  fieldId: FIELD,
  outputId: OUTPUT_ID,
};

describe("handleAttach", () => {
  test("fetches the PDF with the token and sends it to the bound tab under an ASCII name", async () => {
    const w = worker();
    expect(await w.ask(ATTACH)).toEqual({
      kind: "ok",
      data: { kind: "attach_done", fieldId: FIELD, fileName: "Jose Nunez - AcmeCo - Resume.pdf" },
    });
    expect(w.fetched).toEqual([{ path: PDF_PATH, auth: `Bearer ${TOKEN}` }]);
    expect(w.sent).toHaveLength(1);
    const sent = RuntimeMessage.parse(w.sent[0]);
    if (sent.kind !== "attach") throw new Error("expected an attach message");
    expect(sent).toMatchObject({ nonce: NONCE, fieldId: FIELD, mimeType: "application/pdf" });
    expect(base64ToBytes(sent.dataBase64)).toEqual(PDF);
  });

  test("keeps no file bytes in extension storage", async () => {
    const w = worker();
    await w.ask(ATTACH);
    const stored = JSON.stringify([w.local.data, w.session.data]);
    expect(stored).not.toContain(bytesToBase64(PDF));
    expect(Object.keys(w.local.data).sort()).toEqual(["endpoint", "pairing"]);
    expect(Object.keys(w.session.data)).toEqual(["binding"]);
  });

  test("a response that is not application/pdf is the wrong type, and nothing reaches the page", async () => {
    for (const contentType of ["text/html", "application/octet-stream", "application/pdfx"]) {
      const w = worker({ pdf: () => pdfResponse(PDF, { "Content-Type": contentType }) });
      expect(await w.ask(ATTACH)).toEqual({
        kind: "ok",
        data: { kind: "attach_rejected", fieldId: FIELD, reason: "wrong_type" },
      });
      expect(w.sent).toEqual([]);
    }
  });

  test("application/pdf with parameters is still a PDF", async () => {
    const w = worker({ pdf: () => pdfResponse(PDF, { "Content-Type": "Application/PDF; charset=binary" }) });
    expect((await w.ask(ATTACH)).kind).toBe("ok");
    expect(w.sent).toHaveLength(1);
  });

  test("bytes without the %PDF- header are the wrong type", async () => {
    const w = worker({ pdf: () => pdfResponse(new TextEncoder().encode("<html>login</html>")) });
    expect(await w.ask(ATTACH)).toMatchObject({ data: { kind: "attach_rejected", reason: "wrong_type" } });
    expect(w.sent).toEqual([]);
  });

  test("a file over 10 MB is too large, by header or by body", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PDF);
    const byBody = worker({ pdf: () => new Response(big, { headers: { "Content-Type": "application/pdf" } }) });
    expect(await byBody.ask(ATTACH)).toMatchObject({ data: { kind: "attach_rejected", reason: "too_large" } });
    expect(byBody.sent).toEqual([]);

    const byHeader = worker({ pdf: () => pdfResponse(PDF, { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) }) });
    expect(await byHeader.ask(ATTACH)).toMatchObject({ data: { kind: "attach_rejected", reason: "too_large" } });
  });

  test("the export gate's 409 needs_input comes back as a failure, and nothing reaches the page", async () => {
    const w = worker({
      pdf: () =>
        new Response(JSON.stringify({ error: { code: "needs_input", message: "Resume is empty. Write it first." } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(await w.ask(ATTACH)).toMatchObject({ kind: "failed", status: 409, code: "needs_input" });
    expect(w.sent).toEqual([]);
  });

  test("another session, another tab, or no binding is refused before any fetch", async () => {
    for (const bound of [null, { sessionId: OTHER_SESSION, tabId: 7 }, { sessionId: SESSION_ID, tabId: 8 }]) {
      const w = worker({ bound });
      expect(await w.ask(ATTACH)).toEqual({ kind: "refused", reason: "not_bound" });
      expect(w.fetched).toEqual([]);
      expect(w.sent).toEqual([]);
    }
  });

  test("a blocked host, an inactive tab or a non-web tab is refused before any fetch", async () => {
    const cases: [{ active: boolean; url: string | null } | null, TabRefusal][] = [
      [{ active: true, url: "https://www.linkedin.com/jobs/apply/1" }, "blocked_host"],
      [{ active: false, url: TAB_URL }, "not_active"],
      [{ active: true, url: "chrome://settings" }, "unsupported_url"],
      [{ active: true, url: null }, "unsupported_url"],
      [null, "unsupported_url"],
    ];
    for (const [tab, reason] of cases) {
      const w = worker({ tab });
      expect(await w.ask(ATTACH)).toEqual({ kind: "refused", reason });
      expect(w.fetched).toEqual([]);
    }
  });

  test("without a pairing nothing is fetched or sent", async () => {
    const w = worker({ paired: false });
    expect(await w.ask(ATTACH)).toEqual({ kind: "unpaired" });
    expect(w.sent).toEqual([]);
  });

  test("the page's rejection comes back as is", async () => {
    const w = worker({
      reply: (m) =>
        m.kind === "attach"
          ? {
              kind: "attach_result",
              nonce: m.nonce,
              fieldId: m.fieldId,
              result: { kind: "rejected", reason: "not_empty" },
            }
          : undefined,
    });
    expect(await w.ask(ATTACH)).toEqual({
      kind: "ok",
      data: { kind: "attach_rejected", fieldId: FIELD, reason: "not_empty" },
    });
  });

  test("a reply for another scan or field is a bad reply; no content script means stale", async () => {
    const wrongNonce = worker({
      reply: (m) =>
        m.kind === "attach"
          ? { kind: "attach_result", nonce: OTHER_NONCE, fieldId: m.fieldId, result: { kind: "attached" } }
          : undefined,
    });
    expect(await wrongNonce.ask(ATTACH)).toEqual({ kind: "refused", reason: "bad_reply" });

    const wrongField = worker({
      reply: (m) =>
        m.kind === "attach"
          ? { kind: "attach_result", nonce: m.nonce, fieldId: "f9", result: { kind: "attached" } }
          : undefined,
    });
    expect(await wrongField.ask(ATTACH)).toEqual({ kind: "refused", reason: "bad_reply" });

    const gone = worker({
      reply: () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
    });
    expect(await gone.ask(ATTACH)).toEqual({
      kind: "ok",
      data: { kind: "attach_rejected", fieldId: FIELD, reason: "stale" },
    });
  });

  test("end to end: the worker's message lands on the scanned input of a happy-dom page", async () => {
    const page = openPage();
    const fieldId = page.idOf("resume");
    const w = worker({
      reply: (m) => (m.kind === "attach" ? attachFile({ current: page.current, message: m, measure: noLayout }) : null),
    });
    expect(await w.ask({ ...ATTACH, fieldId })).toMatchObject({ kind: "ok", data: { kind: "attach_done", fieldId } });
    expect(page.input("resume").files?.[0]?.name).toBe("Jose Nunez - AcmeCo - Resume.pdf");
    expect(page.events).toEqual(["input:resume", "change:resume"]);
  });

  test("download saves the verified PDF under the same name, without touching the page", async () => {
    const w = worker();
    expect(await w.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID })).toEqual({
      kind: "ok",
      data: { kind: "attach_downloaded", outputId: OUTPUT_ID },
    });
    expect(w.downloads).toEqual([
      { url: `data:application/pdf;base64,${bytesToBase64(PDF)}`, filename: "Jose Nunez - AcmeCo - Resume.pdf" },
    ]);
    expect(w.sent).toEqual([]);
  });

  test("download refuses another session and a non-PDF answer", async () => {
    const other = worker({ bound: { sessionId: OTHER_SESSION, tabId: 7 } });
    expect(await other.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID })).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    const html = worker({ pdf: () => pdfResponse(PDF, { "Content-Type": "text/html" }) });
    expect(await html.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID })).toEqual({
      kind: "ok",
      data: { kind: "attach_rejected", fieldId: null, reason: "wrong_type" },
    });
    expect(html.downloads).toEqual([]);
  });
});

describe("attachFileName", () => {
  test("turns the server's name into the ASCII name the page gets", () => {
    const cases: [string | null, string][] = [
      ["Ada Lovelace - Acme - Resume.pdf", "Ada Lovelace - Acme - Resume.pdf"],
      ["José Ñúñez - Acme/Co - Résumé.pdf", "Jose Nunez - AcmeCo - Resume.pdf"],
      ["王小明 - 公司 - Resume.pdf", "Resume.pdf"],
      ["Mary-Jane O'Neil - Acme - Cover letter.PDF", "Mary-Jane ONeil - Acme - Cover letter.pdf"],
      ["../../etc/passwd", "etcpasswd.pdf"],
      ["", "Application.pdf"],
      [null, "Application.pdf"],
      ["文件.pdf", "Application.pdf"],
      [`${"x".repeat(300)}.pdf`, `${"x".repeat(116)}.pdf`],
    ];
    expect(cases.map(([raw]) => [raw, attachFileName(raw)])).toEqual(cases);
  });

  test("reads filename* first, then filename", () => {
    expect(dispositionFileName(`attachment; filename*=UTF-8''A%20B.pdf`)).toBe("A B.pdf");
    expect(dispositionFileName(`attachment; filename="Plain name.pdf"`)).toBe("Plain name.pdf");
    expect(dispositionFileName(`attachment; filename=bare.pdf; size=3`)).toBe("bare.pdf");
    expect(dispositionFileName(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeNull();
    expect(dispositionFileName(null)).toBeNull();
  });
});

describe("request schemas", () => {
  test("are strict and fit into the panel request union", () => {
    expect(AttachRequests.safeParse({ ...ATTACH, selector: "#resume" }).success).toBe(false);
    expect(AttachRequests.safeParse({ ...ATTACH, tabId: -1 }).success).toBe(false);
    expect(PanelRequest.parse(ATTACH)).toEqual(ATTACH);
    expect(PanelRequest.parse({ kind: "status" })).toEqual({ kind: "status" });
    expect(PanelResult.parse({ kind: "attach_done", fieldId: FIELD, fileName: "A.pdf" }).kind).toBe("attach_done");
  });
});

// ---------- Panel ----------

const PAIRED = ConnectionStatus.parse({ kind: "paired", endpoint: ENDPOINT, pairingId: PAIRING_ID });

describe("statusFromReply", () => {
  test("maps every outcome of a click to what the row shows", () => {
    const done = { status: PAIRED, error: null, result: { kind: "attach_done", fieldId: "f1", fileName: "A.pdf" } };
    const cases: [Parameters<typeof statusFromReply>[0]["reply"], AttachAction, AttachStatus][] = [
      [done, "attach", { kind: "attached", fileName: "A.pdf" }],
      [
        { status: PAIRED, error: null, result: { kind: "attach_rejected", fieldId: "f1", reason: "not_empty" } },
        "attach",
        {
          kind: "problem",
          message: "That field already has a file. Remove it on the page first.",
          offerDownload: true,
        },
      ],
      [
        { status: PAIRED, error: null, result: { kind: "attach_rejected", fieldId: null, reason: "wrong_type" } },
        "download",
        {
          kind: "problem",
          message: "This field doesn't take PDFs, or the file isn't a valid PDF.",
          offerDownload: false,
        },
      ],
      [
        { status: PAIRED, error: null, result: { kind: "refused", reason: "blocked_host" } },
        "attach",
        {
          kind: "problem",
          message: "This site's terms forbid automated tools. Download the file and upload it yourself.",
          offerDownload: true,
        },
      ],
      [
        { status: PAIRED, error: "x", result: { kind: "failed", code: "needs_input", message: "Resume is empty." } },
        "attach",
        { kind: "problem", message: "Resume is empty.", offerDownload: false },
      ],
      [
        { status: PAIRED, error: null, result: { kind: "attach_downloaded", outputId: OUTPUT_ID } },
        "download",
        { kind: "downloaded" },
      ],
      [
        { status: { kind: "unpaired", endpoint: ENDPOINT, notice: "revoked" }, error: null },
        "attach",
        { kind: "problem", message: "Hanapbuhay isn't connected, so nothing was attached.", offerDownload: false },
      ],
    ];
    for (const [reply, action, expected] of cases) {
      expect(statusFromReply({ reply, action })).toEqual(expected);
    }
  });
});

describe("attachReducer", () => {
  test("a new scan starts over and a late answer for the old scan is dropped", () => {
    const f1 = FieldId.parse("f1");
    let state = attachReducer(INITIAL_ATTACH_STATE, {
      kind: "started",
      nonce: NONCE,
      fieldId: f1,
      outputId: OUTPUT_ID,
      action: "attach",
    });
    expect(state.rows[f1]?.status).toEqual({ kind: "busy", action: "attach" });
    state = attachReducer(state, { kind: "chose", nonce: OTHER_NONCE, fieldId: f1, outputId: null });
    expect(state).toEqual({ nonce: OTHER_NONCE, rows: { [f1]: { choice: null, status: { kind: "idle" } } } });
    const late = attachReducer(state, {
      kind: "settled",
      nonce: NONCE,
      fieldId: f1,
      status: { kind: "attached", fileName: "A.pdf" },
    });
    expect(late).toBe(state);
  });
});

describe("outputs and suggestions", () => {
  const output = (id: string, kind: "resume" | "letter" | "answer" | "message") => ({
    id: OutputId.parse(id),
    kind,
    included: true,
    question: null,
    mustAnswer: null,
    generatedAt: null,
    editedAt: null,
    reviewedAt: null,
    outdated: false,
  });
  const letter = output("8e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918", "letter");
  const resume = output("9e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918", "resume");
  const answer = output("ae6d5c4b-3a29-4180-9f7e-6d5c4b3a2918", "answer");
  const field = (label: string) => ({
    fieldId: FieldId.parse("f1"),
    control: "file" as const,
    label,
    autocomplete: null,
    name: null,
    required: false,
    options: [],
    adapterCategory: null,
  });

  test("only resumes and letters can be attached, resume first", () => {
    expect(attachableOutputs([answer, letter, resume]).map((o) => o.kind)).toEqual(["resume", "letter"]);
  });

  test("the label suggests a file only when one output fits", () => {
    const pdfs = attachableOutputs([letter, resume]);
    expect(suggestedOutput(field("Resume/CV"), pdfs)).toBe(resume.id);
    expect(suggestedOutput(field("Cover Letter"), pdfs)).toBe(letter.id);
    expect(suggestedOutput(field("Attach"), pdfs)).toBeNull();
    expect(suggestedOutput(field("Resume"), attachableOutputs([letter]))).toBeNull();
  });
});
