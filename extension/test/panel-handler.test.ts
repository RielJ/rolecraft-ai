import { describe, expect, test } from "bun:test";
import { ApplicationSessionId, FieldId, type FillPlan, type RuntimeMessage, ScanNonce } from "@shared/extension";
import type { ContentDeps } from "../src/background/content";
import { handlePanelRequest, type PanelDeps } from "../src/background/panel";
import type { PermissionsApi } from "../src/background/permissions";
import { PanelRequest } from "../src/messages";
import type { ImportContentRequest } from "../src/messages-import";
import { createDiagnosticsLog, type DiagnosticsLog } from "../src/state/diagnostics";
import { createStore, type KeyValueArea } from "../src/state/storage";

const ENDPOINT = "http://localhost:3000";
const TOKEN = "A".repeat(43);
const PAIRING_ID = "6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11";
const SESSION_ID = "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b";
const OTHER_SESSION = "1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c";
const OPPORTUNITY_ID = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
const OTHER_OPPORTUNITY = "5b4c3d2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e";
const APPLY_URL = "https://boards.example/jobs/1";
const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const NOW = "2026-10-18T03:00:00.000Z";

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sessionDto(status: "pending" | "claimed" = "claimed") {
  return {
    id: SESSION_ID,
    opportunityId: OPPORTUNITY_ID,
    status,
    applyUrl: APPLY_URL,
    applyUrlKey: "boards.example/jobs/1",
    title: "Engineer",
    company: "Acme",
    createdAt: NOW,
    expiresAt: NOW,
    claimedAt: status === "claimed" ? NOW : null,
  };
}

type Route = (url: URL, init: RequestInit) => Response;

function setup({
  paired = true,
  bound = true,
  tabUrl = APPLY_URL,
  route = () => json(500, { error: { code: "internal", message: "unexpected call" } }),
  serverDown = false,
  pingOk = true,
  pageReply,
  diagnostics,
}: {
  /** Replaces the ring buffer over the session area, e.g. with one that fails. */
  diagnostics?: DiagnosticsLog;
  paired?: boolean;
  bound?: boolean;
  tabUrl?: string | null;
  route?: Route;
  serverDown?: boolean;
  pingOk?: boolean;
  /** What the page answers a `read_job` or `success_probe`. */
  pageReply?: (message: ImportContentRequest) => unknown;
} = {}) {
  const local = memoryArea(paired ? { endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: TOKEN } } : {});
  const session = memoryArea(
    bound ? { binding: { sessionId: SESSION_ID, opportunityId: OPPORTUNITY_ID, tabId: 7, claimedAt: 1 } } : {},
  );
  const store = createStore({ local, session });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const sent: RuntimeMessage[] = [];
  const injected: number[] = [];
  const content: ContentDeps = {
    store,
    getTab: async () => ({ active: true, url: tabUrl }),
    inject: async (tabId) => {
      injected.push(tabId);
      return "ok";
    },
    send: async (_tabId, message) => {
      sent.push(message);
      if (message.kind === "scan") {
        return { kind: "scan_result", nonce: message.nonce, url: APPLY_URL, adapter: "generic", fields: [] };
      }
      if (message.kind === "fill") {
        return {
          kind: "fill_result",
          nonce: message.nonce,
          filled: message.entries.map((e) => e.fieldId),
          skipped: [],
        };
      }
      if (message.kind === "attach") {
        return { kind: "attach_result", nonce: message.nonce, fieldId: message.fieldId, result: { kind: "attached" } };
      }
      return undefined;
    },
    newNonce: () => NONCE,
  };
  const asked: ImportContentRequest[] = [];
  const downloads: { url: string; filename: string }[] = [];
  const granted = new Set<string>();
  const permissions: PermissionsApi = {
    request: async ({ origins }) => {
      for (const o of origins) granted.add(o);
      return true;
    },
    remove: async ({ origins }) => {
      for (const o of origins) granted.delete(o);
      return true;
    },
    contains: async ({ origins }) => origins.every((o) => granted.has(o)),
    getAll: async () => ({ origins: [...granted] }),
  };
  const deps: PanelDeps = {
    pairing: {
      store,
      hasHostPermission: async () => true,
      fetch: async (url, init) => {
        const parsed = new URL(url);
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method ?? "GET", path: parsed.pathname, body });
        if (serverDown) throw new TypeError("Failed to fetch");
        if (parsed.pathname === "/api/extension/ping" && pingOk) return json(200, { ok: true, pairingId: PAIRING_ID });
        return route(parsed, init);
      },
    },
    content,
    permissions,
    now: () => 1234,
    sendImport: async (_tabId, message) => {
      asked.push(message);
      return pageReply?.(message);
    },
    download: async (args) => {
      downloads.push(args);
      return "ok";
    },
    diagnostics: diagnostics ?? createDiagnosticsLog({ area: session }),
  };
  const ask = (request: unknown) => handlePanelRequest({ deps, request: PanelRequest.parse(request) });
  return { ask, store, session, calls, sent, injected, granted, asked, downloads, log: deps.diagnostics };
}

const PLAN: FillPlan = {
  nonce: NONCE,
  entries: [{ fieldId: FieldId.parse("f1"), value: { kind: "text", text: "Ada" } }],
};

describe("panel requests: schema", () => {
  test("rejects unknown keys, so a selector or script cannot ride along", () => {
    expect(PanelRequest.safeParse({ kind: "scan", tabId: 1, selector: "#email" }).success).toBe(false);
    expect(PanelRequest.safeParse({ kind: "fill", tabId: 1, plan: { ...PLAN, overwrite: true } }).success).toBe(false);
    expect(
      PanelRequest.safeParse({
        kind: "fill",
        tabId: 1,
        plan: { nonce: NONCE, entries: [{ fieldId: "f1", value: { kind: "text", text: "x" }, selector: "#a" }] },
      }).success,
    ).toBe(false);
  });

  test("a preference save must fit its category", () => {
    const base = {
      kind: "preference_save",
      input: { category: "gender", displayText: "x", scope: { kind: "global" } },
    };
    expect(
      PanelRequest.safeParse({ ...base, input: { ...base.input, typedValue: { valueType: "text", value: "x" } } })
        .success,
    ).toBe(false);
    expect(
      PanelRequest.safeParse({
        ...base,
        input: { ...base.input, typedValue: { valueType: "choice", value: "decline" } },
      }).success,
    ).toBe(true);
  });
});

describe("panel requests: claim", () => {
  test("binds the session to the tab the claim came from", async () => {
    const t = setup({ bound: false, route: () => json(200, { session: sessionDto() }) });
    const reply = await t.ask({
      kind: "session_claim",
      sessionId: SESSION_ID,
      tabId: 7,
      tabUrl: APPLY_URL,
      confirmMismatch: false,
    });
    expect(reply.result).toMatchObject({ kind: "claimed" });
    expect(t.calls).toEqual([
      {
        method: "POST",
        path: `/api/extension/sessions/${SESSION_ID}/claim`,
        body: { tabUrl: APPLY_URL, confirmMismatch: false },
      },
    ]);
    expect(await t.store.readBinding()).toEqual({
      sessionId: ApplicationSessionId.parse(SESSION_ID),
      opportunityId: expect.any(String),
      tabId: 7,
      claimedAt: 1234,
    });
  });

  test("a URL mismatch comes back for confirmation and binds nothing", async () => {
    const t = setup({
      bound: false,
      route: () =>
        json(409, {
          error: {
            code: "url_mismatch",
            message: "mismatch",
            details: { sessionUrlKey: "boards.example/jobs/1", tabUrlKey: "other.example/x" },
          },
        }),
    });
    const reply = await t.ask({
      kind: "session_claim",
      sessionId: SESSION_ID,
      tabId: 7,
      tabUrl: APPLY_URL,
      confirmMismatch: false,
    });
    expect(reply.result).toEqual({
      kind: "claim_mismatch",
      details: { sessionUrlKey: "boards.example/jobs/1", tabUrlKey: "other.example/x" },
    });
    expect(await t.store.readBinding()).toBeNull();
  });

  test("refuses when the tab moved since the panel read it", async () => {
    const t = setup({ bound: false, tabUrl: "https://elsewhere.example/" });
    const reply = await t.ask({
      kind: "session_claim",
      sessionId: SESSION_ID,
      tabId: 7,
      tabUrl: APPLY_URL,
      confirmMismatch: true,
    });
    expect(reply.result).toEqual({ kind: "refused", reason: "tab_changed" });
    expect(t.calls).toEqual([]);
  });
});

describe("panel requests: scan and fill", () => {
  test("scan refuses a tab the session is not bound to, without injecting", async () => {
    const t = setup();
    expect((await t.ask({ kind: "scan", tabId: 8 })).result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(t.injected).toEqual([]);
    const unbound = setup({ bound: false });
    expect((await unbound.ask({ kind: "scan", tabId: 7 })).result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(unbound.injected).toEqual([]);
  });

  test("scan of the bound tab returns the fields and nonce", async () => {
    const t = setup();
    expect((await t.ask({ kind: "scan", tabId: 7 })).result).toEqual({
      kind: "scanned",
      nonce: NONCE,
      adapter: "generic",
      fields: [],
    });
  });

  test("scan without a pairing does nothing", async () => {
    const t = setup({ paired: false });
    const reply = await t.ask({ kind: "scan", tabId: 7 });
    expect(reply.status.kind).toBe("unpaired");
    expect(t.injected).toEqual([]);
  });

  test("fill with the server down sends nothing to the page", async () => {
    const t = setup({ serverDown: true });
    const reply = await t.ask({ kind: "fill", tabId: 7, plan: PLAN });
    expect(reply.status.kind).toBe("unreachable");
    expect(t.sent).toEqual([]);
  });

  test("fill with a revoked token sends nothing to the page", async () => {
    const t = setup({ route: () => json(401, { error: { code: "unauthorized", message: "no" } }), pingOk: false });
    const reply = await t.ask({ kind: "fill", tabId: 7, plan: PLAN });
    expect(reply.status).toMatchObject({ kind: "unpaired", notice: "revoked" });
    expect(t.sent).toEqual([]);
  });

  test("fill of the bound tab pings, then sends the plan as is", async () => {
    const t = setup();
    const reply = await t.ask({ kind: "fill", tabId: 7, plan: PLAN });
    expect(reply.result).toEqual({
      kind: "filled",
      result: { nonce: NONCE, filled: [FieldId.parse("f1")], skipped: [] },
    });
    expect(t.calls.map((c) => c.path)).toEqual(["/api/extension/ping"]);
    expect(t.sent).toEqual([{ kind: "fill", ...PLAN }]);
  });

  test("fill refuses another tab", async () => {
    const t = setup();
    expect((await t.ask({ kind: "fill", tabId: 9, plan: PLAN })).result).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    expect(t.sent).toEqual([]);
  });
});

describe("panel requests: session-scoped server calls", () => {
  test("prefill for a session other than the bound one never reaches the server", async () => {
    const t = setup();
    const reply = await t.ask({ kind: "prefill", sessionId: OTHER_SESSION, nonce: NONCE, fields: [] });
    expect(reply.result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(t.calls).toEqual([]);
  });

  test("a prefill answer for another nonce is not passed on", async () => {
    const t = setup({
      route: () => json(200, { nonce: "scan-nonce-0000000002", matches: [], unresolved: [] }),
    });
    const reply = await t.ask({ kind: "prefill", sessionId: SESSION_ID, nonce: NONCE, fields: [] });
    expect(reply.result).toMatchObject({ kind: "failed", code: "bad_response" });
  });

  test("an expired session drops the binding", async () => {
    const t = setup({ route: () => json(409, { error: { code: "session_expired", message: "ended" } }) });
    const reply = await t.ask({ kind: "outputs_list", sessionId: SESSION_ID });
    expect(reply.result).toEqual({ kind: "failed", code: "session_expired", message: "ended" });
    expect(reply.status.kind).toBe("paired");
    expect(await t.store.readBinding()).toBeNull();
  });

  test("output_reviewed sends the shown text; a changed one (409) keeps the binding", async () => {
    const outputId = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
    const message = "This text changed since you opened it. Read the new version, then mark it reviewed.";
    const t = setup({ route: () => json(409, { error: { code: "output_changed", message } }) });
    const reply = await t.ask({ kind: "output_reviewed", sessionId: SESSION_ID, outputId, body: "Because." });
    expect(t.calls.at(-1)).toEqual({
      method: "POST",
      path: `/api/extension/sessions/${SESSION_ID}/outputs/${outputId}/reviewed`,
      body: { body: "Because." },
    });
    expect(reply.result).toEqual({ kind: "failed", code: "output_changed", message });
    expect(await t.store.readBinding()).toMatchObject({ sessionId: SESSION_ID, tabId: 7 });
    expect((await t.log.list()).at(-1)).toMatchObject({ request: "output_reviewed", outcome: "output_changed" });
  });

  test("a missing output on output_reviewed keeps the binding; an expired session drops it", async () => {
    const request = {
      kind: "output_reviewed",
      sessionId: SESSION_ID,
      outputId: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
      body: "Because.",
    };
    const missing = setup({ route: () => json(404, { error: { code: "not_found", message: "Not found." } }) });
    expect((await missing.ask(request)).result).toMatchObject({ kind: "failed", code: "not_found" });
    expect(await missing.store.readBinding()).toMatchObject({ sessionId: SESSION_ID, tabId: 7 });

    const expired = setup({ route: () => json(409, { error: { code: "session_expired", message: "ended" } }) });
    expect((await expired.ask(request)).result).toMatchObject({ kind: "failed", code: "session_expired" });
    expect(await expired.store.readBinding()).toBeNull();
  });

  test("a not_found from a session route (outputs list, prefill) drops the binding", async () => {
    const gone = () => json(404, { error: { code: "not_found", message: "Not found." } });
    const list = setup({ route: gone });
    await list.ask({ kind: "outputs_list", sessionId: SESSION_ID });
    expect(await list.store.readBinding()).toBeNull();
    const prefill = setup({ route: gone });
    await prefill.ask({ kind: "prefill", sessionId: SESSION_ID, nonce: NONCE, fields: [] });
    expect(await prefill.store.readBinding()).toBeNull();
  });

  test("a per-job preference is only saved for the bound job", async () => {
    const t = setup();
    const reply = await t.ask({
      kind: "preference_save",
      input: {
        category: "notice_period",
        typedValue: { valueType: "text", value: "Two weeks" },
        displayText: "Two weeks",
        scope: { kind: "opportunity", opportunityId: OTHER_OPPORTUNITY },
      },
    });
    expect(reply.result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(t.calls).toEqual([]);
  });

  test("draft starts for one output and passes confirmOverCap through", async () => {
    const task = {
      id: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
      kind: "draft",
      status: "running",
      step: "Drafting",
      error: null,
      createdAt: NOW,
      finishedAt: null,
    };
    const t = setup({ route: () => json(202, task) });
    const outputId = "8b7c6d5e-4f3a-4b2c-8d9e-0f1a2b3c4d5e";
    const reply = await t.ask({ kind: "draft_start", sessionId: SESSION_ID, outputId, confirmOverCap: true });
    expect(reply.result).toEqual({ kind: "task", task: expect.objectContaining({ status: "running" }) });
    expect(t.calls).toEqual([
      { method: "POST", path: `/api/extension/sessions/${SESSION_ID}/draft`, body: { outputId, confirmOverCap: true } },
    ]);
  });
});

const OUTPUT_ID = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
const PDF_PATH = `/api/extension/sessions/${SESSION_ID}/outputs/${OUTPUT_ID}/pdf`;
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const ATTACH = { kind: "attach", sessionId: SESSION_ID, tabId: 7, nonce: NONCE, fieldId: "f1", outputId: OUTPUT_ID };

function pdfRoute(url: URL): Response {
  if (url.pathname !== PDF_PATH) return json(404, { error: { code: "not_found", message: "Not found." } });
  return new Response(PDF, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Resume.pdf"` },
  });
}

describe("panel requests: attach", () => {
  test("attach fetches the PDF and hands it to the bound tab", async () => {
    const t = setup({ route: pdfRoute });
    const reply = await t.ask(ATTACH);
    expect(reply.result).toEqual({ kind: "attach_done", fieldId: FieldId.parse("f1"), fileName: "Resume.pdf" });
    expect(reply.status.kind).toBe("paired");
    expect(t.calls.map((c) => c.path)).toEqual([PDF_PATH]);
    expect(t.sent.map((m) => m.kind)).toEqual(["attach"]);
  });

  test("attach to a tab other than the bound one fetches nothing", async () => {
    const t = setup({ route: pdfRoute });
    expect((await t.ask({ ...ATTACH, tabId: 8 })).result).toEqual({ kind: "refused", reason: "not_bound" });
    expect((await t.ask({ ...ATTACH, sessionId: OTHER_SESSION })).result).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    expect(t.calls).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  test("attach on a blocked host sends nothing to the page", async () => {
    const t = setup({ route: pdfRoute, tabUrl: "https://www.linkedin.com/jobs/view/1" });
    expect((await t.ask(ATTACH)).result).toEqual({ kind: "refused", reason: "blocked_host" });
    expect(t.sent).toEqual([]);
  });

  test("a missing output fails but keeps the tab linked", async () => {
    const t = setup({ route: () => json(404, { error: { code: "not_found", message: "Not found." } }) });
    const reply = await t.ask(ATTACH);
    expect(reply.result).toEqual({ kind: "failed", code: "not_found", message: "Not found." });
    expect(await t.store.readBinding()).toMatchObject({ sessionId: SESSION_ID, tabId: 7 });
    expect(t.sent).toEqual([]);

    const download = await t.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID });
    expect(download.result).toEqual({ kind: "failed", code: "not_found", message: "Not found." });
    expect(await t.store.readBinding()).toMatchObject({ sessionId: SESSION_ID, tabId: 7 });
    expect(t.downloads).toEqual([]);
  });

  test("an expired session on attach or download drops the binding", async () => {
    const expired = () => json(409, { error: { code: "session_expired", message: "ended" } });
    const t = setup({ route: expired });
    expect((await t.ask(ATTACH)).result).toEqual({ kind: "failed", code: "session_expired", message: "ended" });
    expect(await t.store.readBinding()).toBeNull();

    const d = setup({ route: expired });
    await d.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID });
    expect(await d.store.readBinding()).toBeNull();
  });

  test("a revoked token puts the pairing screen back and sends nothing", async () => {
    const t = setup({ route: () => json(401, { error: { code: "unauthorized", message: "no" } }) });
    const reply = await t.ask(ATTACH);
    expect(reply.status).toMatchObject({ kind: "unpaired", notice: "revoked" });
    expect(t.sent).toEqual([]);
  });

  test("attach_download saves the checked PDF through Downloads, not the page", async () => {
    const t = setup({ route: pdfRoute });
    const reply = await t.ask({ kind: "attach_download", sessionId: SESSION_ID, outputId: OUTPUT_ID });
    expect<unknown>(reply.result).toEqual({ kind: "attach_downloaded", outputId: OUTPUT_ID });
    expect(t.downloads).toEqual([
      { url: expect.stringMatching(/^data:application\/pdf;base64,/), filename: "Resume.pdf" },
    ]);
    expect(t.sent).toEqual([]);
  });

  test("attach_download for another session fetches nothing", async () => {
    const t = setup({ route: pdfRoute });
    const reply = await t.ask({ kind: "attach_download", sessionId: OTHER_SESSION, outputId: OUTPUT_ID });
    expect(reply.result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(t.calls).toEqual([]);
    expect(t.downloads).toEqual([]);
  });
});

const DRAFT = {
  pageUrl: APPLY_URL,
  applyUrl: APPLY_URL,
  title: "Engineer",
  company: "Acme",
  location: "",
  description: "Build things.",
  source: "page",
};

describe("panel requests: import and applied", () => {
  test("job_extract reads the tab with a fresh nonce and calls no server route", async () => {
    const t = setup({ pageReply: (m) => ({ kind: "read_job_result", nonce: m.nonce, draft: DRAFT }) });
    const reply = await t.ask({ kind: "job_extract", tabId: 7 });
    expect<unknown>(reply.result).toEqual({ kind: "job_extracted", draft: DRAFT });
    expect(t.asked).toEqual([{ kind: "read_job", nonce: NONCE }]);
    expect(t.injected).toEqual([7]);
    expect(t.calls).toEqual([]);
  });

  test("job_extract on a blocked host asks the page nothing", async () => {
    const t = setup({ tabUrl: "https://www.linkedin.com/jobs/view/1" });
    expect((await t.ask({ kind: "job_extract", tabId: 7 })).result).toEqual({
      kind: "refused",
      reason: "blocked_host",
    });
    expect(t.injected).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  test("job_lookup is a read-only GET", async () => {
    const t = setup({ route: () => json(200, { kind: "none" }) });
    const reply = await t.ask({ kind: "job_lookup", url: APPLY_URL });
    expect(reply.result).toEqual({ kind: "job_lookup", lookup: { kind: "none" } });
    expect(t.calls).toEqual([{ method: "GET", path: "/api/extension/opportunities/by-url", body: undefined }]);
  });

  test("job_import posts the edited preview", async () => {
    const t = setup({ route: () => json(201, { kind: "created", opportunityId: OPPORTUNITY_ID }) });
    const edits = { applyUrl: APPLY_URL, title: "Engineer", company: "Acme", location: "", description: "Build." };
    const reply = await t.ask({ kind: "job_import", edits });
    expect<unknown>(reply.result).toEqual({
      kind: "job_imported",
      result: { kind: "created", opportunityId: OPPORTUNITY_ID },
    });
    expect(t.calls).toEqual([
      {
        method: "POST",
        path: "/api/extension/import",
        body: { url: APPLY_URL, title: "Engineer", company: "Acme", description: "Build." },
      },
    ]);
  });

  test("success_check asks the bound tab for a reason code and never calls the server", async () => {
    const t = setup({
      pageReply: (m) => ({ kind: "success_probe_result", nonce: m.nonce, reason: "confirmation_text" }),
    });
    const reply = await t.ask({ kind: "success_check", sessionId: SESSION_ID, tabId: 7 });
    expect(reply.result).toEqual({ kind: "success_checked", reason: "confirmation_text" });
    expect(t.asked).toEqual([{ kind: "success_probe", nonce: NONCE }]);
    expect(t.calls).toEqual([]);
  });

  test("success_check of another tab or session asks nothing", async () => {
    const t = setup();
    expect((await t.ask({ kind: "success_check", sessionId: SESSION_ID, tabId: 8 })).result).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    expect((await t.ask({ kind: "success_check", sessionId: OTHER_SESSION, tabId: 7 })).result).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    expect(t.asked).toEqual([]);
  });

  test("confirm_applied posts for the bound session only", async () => {
    const result = { opportunityId: OPPORTUNITY_ID, status: "applied", changed: true };
    const t = setup({ route: () => json(200, result) });
    const reply = await t.ask({ kind: "confirm_applied", sessionId: SESSION_ID, reason: "form_gone" });
    expect<unknown>(reply.result).toEqual({ kind: "applied", result });
    expect(t.calls).toEqual([
      { method: "POST", path: `/api/extension/sessions/${SESSION_ID}/confirm-applied`, body: { reason: "form_gone" } },
    ]);

    const other = setup({ route: () => json(200, result) });
    const refused = await other.ask({ kind: "confirm_applied", sessionId: OTHER_SESSION, reason: null });
    expect(refused.result).toEqual({ kind: "refused", reason: "not_bound" });
    expect(other.calls).toEqual([]);
  });
});

describe("panel requests: granted origins", () => {
  test("sync_origins mirrors Chrome's single-origin grants, without loopback or wildcards", async () => {
    const t = setup();
    for (const o of ["https://jobs.example/*", "http://localhost/*", "https://*/*"]) t.granted.add(o);
    expect((await t.ask({ kind: "sync_origins" })).result).toEqual({
      kind: "origins",
      origins: ["https://jobs.example"],
    });
    expect((await t.store.readLocal()).grantedOrigins).toEqual(["https://jobs.example"]);
  });

  test("revoke_origin removes the grant and answers with what is left", async () => {
    const t = setup();
    for (const o of ["https://jobs.example/*", "https://boards.example/*"]) t.granted.add(o);
    const reply = await t.ask({ kind: "revoke_origin", origin: "https://jobs.example" });
    expect(reply.result).toEqual({ kind: "origins", origins: ["https://boards.example"] });
    expect([...t.granted]).toEqual(["https://boards.example/*"]);
  });
});

describe("panel requests: diagnostics", () => {
  test("each handled request is recorded once, after it ran, with its outcome", async () => {
    const t = setup({ bound: false });
    await t.ask({ kind: "status" });
    await t.ask({ kind: "scan", tabId: 7 });
    expect(await t.log.list()).toEqual([
      { ts: 1234, kind: "request", request: "status", origin: null, adapter: null, counts: null, outcome: "ok" },
      {
        ts: 1234,
        kind: "request",
        request: "scan",
        origin: "https://boards.example",
        adapter: null,
        counts: null,
        outcome: "not_bound",
      },
    ]);
  });

  test("a scan records the adapter and field count; a server failure records its code", async () => {
    const t = setup({ route: () => json(410, { error: { code: "session_expired", message: "Expired" } }) });
    await t.ask({ kind: "scan", tabId: 7 });
    await t.ask({ kind: "outputs_list", sessionId: SESSION_ID });
    const [scan, outputs] = await t.log.list();
    expect(scan).toMatchObject({ request: "scan", adapter: "generic", counts: { fields: 0 }, outcome: "ok" });
    expect(outputs).toMatchObject({ request: "outputs_list", outcome: "session_expired", counts: null });
  });

  test("the server being down is recorded as network, a revoked token as unauthorized", async () => {
    const down = setup({ serverDown: true });
    await down.ask({ kind: "fill", tabId: 7, plan: PLAN });
    expect((await down.log.list())[0]?.outcome).toBe("network");
    const revoked = setup({
      pingOk: false,
      route: () => json(401, { error: { code: "unauthorized", message: "No" } }),
    });
    await revoked.ask({ kind: "fill", tabId: 7, plan: PLAN });
    expect((await revoked.log.list())[0]?.outcome).toBe("unauthorized");
  });

  test("nothing a fill writes reaches the log", async () => {
    const t = setup();
    await t.ask({ kind: "fill", tabId: 7, plan: PLAN });
    const stored = JSON.stringify(t.session.data.diagnostics);
    expect(stored).toContain('"filled":1');
    expect(stored).not.toContain("Ada");
    expect(stored).not.toContain("/jobs/1");
  });

  test("diagnostics_list answers with the log and is not recorded itself; clear empties it", async () => {
    const t = setup();
    await t.ask({ kind: "status" });
    const listed = await t.ask({ kind: "diagnostics_list" });
    expect(listed.result).toMatchObject({ kind: "diagnostics", entries: [{ request: "status" }] });
    expect(listed.status.kind).toBe("paired");
    expect(t.calls.filter((c) => c.path.endsWith("/ping"))).toHaveLength(1);
    expect((await t.ask({ kind: "diagnostics_clear" })).result).toEqual({ kind: "diagnostics", entries: [] });
    expect(await t.log.list()).toEqual([]);
  });

  test("a log that fails to write does not change the reply", async () => {
    const broken: DiagnosticsLog = {
      list: async () => [],
      record: async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      },
      clear: async () => undefined,
    };
    const t = setup({ diagnostics: broken });
    expect((await t.ask({ kind: "status" })).status.kind).toBe("paired");
  });
});
