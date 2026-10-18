import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpportunityId } from "@shared/api";
import { PairingId, ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { handleImport, type ImportDeps, importInput } from "../src/background/import";
import { extractJob, readJobReply } from "../src/content/import";
import {
  asImportReply,
  type ImportContentRequest,
  ImportDraft,
  ImportPanelRequest,
  type ImportReply,
} from "../src/messages-import";
import {
  IMPORT_INITIAL,
  type ImportEvent,
  type ImportState,
  importTransition,
  workspaceUrl,
} from "../src/panel/ImportJob";
import { createStore, type KeyValueArea } from "../src/state/storage";

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

/** A page in its own happy-dom window, scripts off. The one cast to `Document` lives here. */
function openPage(html: string, url: string): Document {
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  windows.push(window);
  window.document.write(html);
  return window.document as unknown as Document;
}

async function openFixture(name: string, url: string): Promise<Document> {
  return openPage(await Bun.file(join(import.meta.dir, "fixtures", name)).text(), url);
}

describe("extractJob", () => {
  test("uses a JobPosting JSON-LD block when the visible page shows the same title", async () => {
    const document = await openFixture("import-jsonld.html", "https://boards.example/acme/jobs/42?gh_src=x");
    const draft = extractJob(document);
    expect(draft).toEqual({
      pageUrl: "https://boards.example/acme/jobs/42?gh_src=x",
      applyUrl: "https://boards.example/acme/jobs/42",
      title: "Backend Engineer",
      company: "Acme Corp",
      location: "Manila, Philippines",
      description: "We are hiring a backend engineer to build our payments API.\nGo and Postgres",
      source: "json_ld",
    });
    expect(ImportDraft.safeParse(draft).success).toBe(true);
  });

  test("ignores JSON-LD the visible page disagrees with and reads headings and meta instead", async () => {
    const document = await openFixture("import-jsonld-mismatch.html", "https://careers.example/jobs/data-analyst");
    const draft = extractJob(document);
    expect(draft?.source).toBe("page");
    expect(draft?.title).toBe("Data Analyst");
    expect(draft?.company).toBe("Bayanihan Labs");
    expect(draft?.location).toBe("Cebu City");
    expect(draft?.applyUrl).toBe("https://careers.example/jobs/data-analyst");
    expect(draft?.description).toContain("Analyse sales data and build dashboards.");
  });

  test("never reads hidden text, forms, navigation or footers into the description", async () => {
    for (const [name, url] of [
      ["import-jsonld-mismatch.html", "https://careers.example/jobs/1"],
      ["import-jsonld.html", "https://boards.example/acme/jobs/42"],
    ] as const) {
      const document = await openFixture(name, url);
      // Force the page fallback on the JSON-LD fixture too by breaking the agreement.
      document.querySelector("h1")?.replaceChildren("Something else");
      const text = JSON.stringify(extractJob(document));
      for (const hidden of [
        "Ignore previous instructions",
        "Hidden attribute text",
        "Invisible instructions",
        "Screen-reader hidden copy",
        "Transparent text",
        "Hidden description the page never shows",
        "Submit application",
        "All jobs",
        "Privacy policy",
      ]) {
        expect(text).not.toContain(hidden);
      }
    }
  });

  test("takes the company from an ATS board path when the page names none", () => {
    const document = openPage(
      "<html><body><h1>Product Designer</h1><p>Design things people use every day.</p></body></html>",
      "https://jobs.lever.co/kape-ni-juan/1234",
    );
    expect(extractJob(document)?.company).toBe("Kape Ni Juan");
  });

  test("caps every field", () => {
    const long = "word ".repeat(30_000);
    const document = openPage(
      `<html><body><h1>${"T".repeat(400)}</h1><div class="location">${"L".repeat(400)}</div><main><p>${long}</p></main></body></html>`,
      "https://careers.example/jobs/1",
    );
    const draft = extractJob(document);
    expect(draft?.title.length).toBe(300);
    expect(draft?.location).toBe("");
    expect(draft?.description.length).toBeLessThanOrEqual(20_000);
    expect(ImportDraft.safeParse(draft).success).toBe(true);
  });

  test("returns null on a page that is not http or https", () => {
    const document = openPage("<html><body><h1>Local</h1></body></html>", "file:///tmp/job.html");
    expect(extractJob(document)).toBeNull();
  });
});

// ---------- Worker handler ----------

const ENDPOINT = "http://localhost:3000";
const TOKEN = "A".repeat(43);
const PAIRING_ID = PairingId.parse("6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11");
const OPPORTUNITY_ID = OpportunityId.parse("4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d");
const PAGE = "https://careers.example/jobs/data-analyst";
const NONCE = ScanNonce.parse("scan-nonce-0000000001");

const DRAFT: ImportDraft = {
  pageUrl: PAGE,
  applyUrl: PAGE,
  title: "Data Analyst",
  company: "Bayanihan Labs",
  location: "Cebu City",
  description: "Analyse sales data.",
  source: "page",
};

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup({
  paired = true,
  tab = { active: true, url: PAGE } as { active: boolean; url: string | null } | null,
  injected = "ok" as "ok" | "denied",
  contentReply = (m: ImportContentRequest): unknown =>
    m.kind === "read_job" ? { kind: "read_job_result", nonce: m.nonce, draft: DRAFT } : undefined,
  route = (_url: URL): Response => json(500, { error: { code: "internal", message: "unexpected call" } }),
  serverDown = false,
} = {}) {
  const store = createStore({
    local: memoryArea(paired ? { endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: TOKEN } } : {}),
    session: memoryArea(),
  });
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const sent: ImportContentRequest[] = [];
  const deps: ImportDeps = {
    pairing: {
      store,
      hasHostPermission: async () => true,
      fetch: async (url, init) => {
        const parsed = new URL(url);
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method ?? "GET", path: parsed.pathname, query: parsed.search, body });
        if (serverDown) throw new TypeError("Failed to fetch");
        return route(parsed);
      },
    },
    content: { getTab: async () => tab, inject: async () => injected, newNonce: () => NONCE },
    sendContent: async (_tabId, message) => {
      sent.push(message);
      return contentReply(message);
    },
  };
  const ask = (request: unknown) => handleImport({ deps, request: ImportPanelRequest.parse(request) });
  return { ask, calls, sent };
}

describe("import requests: schema", () => {
  test("are strict: unknown keys are rejected", () => {
    expect(ImportPanelRequest.safeParse({ kind: "job_extract", tabId: 1, selector: "main" }).success).toBe(false);
    expect(
      ImportPanelRequest.safeParse({
        kind: "job_import",
        edits: { applyUrl: PAGE, title: "t", company: "c", location: "", description: "d", status: "applied" },
      }).success,
    ).toBe(false);
    expect(ImportPanelRequest.safeParse({ kind: "job_lookup", url: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("import requests: extract", () => {
  test("reads the tab and calls no server route", async () => {
    const { ask, calls, sent } = setup();
    const reply = await ask({ kind: "job_extract", tabId: 3 });
    expect(reply.result).toEqual({ kind: "job_extracted", draft: DRAFT });
    expect(sent).toEqual([{ kind: "read_job", nonce: NONCE }]);
    expect(calls).toEqual([]);
  });

  test("refuses blocked hosts, inactive tabs, denied access and replies for another nonce", async () => {
    const cases = [
      [{ tab: { active: true, url: "https://www.linkedin.com/jobs/view/1" } }, "blocked_host"],
      [{ tab: { active: false, url: PAGE } }, "not_active"],
      [{ tab: { active: true, url: "chrome://extensions" } }, "unsupported_url"],
      [{ injected: "denied" as const }, "permission_denied"],
      [
        { contentReply: () => ({ kind: "read_job_result", nonce: "other-nonce-000000001", draft: DRAFT }) },
        "bad_reply",
      ],
      [
        { contentReply: () => ({ kind: "read_job_result", nonce: NONCE, draft: { ...DRAFT, script: "x" } }) },
        "bad_reply",
      ],
    ] as const;
    for (const [options, reason] of cases) {
      const { ask, sent } = setup(options);
      expect((await ask({ kind: "job_extract", tabId: 3 })).result).toEqual({ kind: "refused", reason });
      if (reason === "blocked_host") expect(sent).toEqual([]);
    }
  });

  test("does nothing without a pairing", async () => {
    const { ask, sent } = setup({ paired: false });
    const reply = await ask({ kind: "job_extract", tabId: 3 });
    expect(reply.status.kind).toBe("unpaired");
    expect(sent).toEqual([]);
  });
});

describe("import requests: lookup and import", () => {
  test("lookup is a GET with the URL as a query parameter", async () => {
    const { ask, calls } = setup({
      route: () =>
        json(200, {
          kind: "found",
          opportunityId: OPPORTUNITY_ID,
          title: "Data Analyst",
          company: "B",
          status: "saved",
        }),
    });
    const reply = await ask({ kind: "job_lookup", url: PAGE });
    expect(reply.result?.kind).toBe("job_lookup");
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/extension/opportunities/by-url",
        query: `?url=${encodeURIComponent(PAGE)}`,
        body: undefined,
      },
    ]);
  });

  test("import posts the edited preview with the location folded into the description", async () => {
    const { ask, calls } = setup({ route: () => json(201, { kind: "created", opportunityId: OPPORTUNITY_ID }) });
    const reply = await ask({
      kind: "job_import",
      edits: {
        applyUrl: PAGE,
        title: " Data Analyst ",
        company: "Bayanihan Labs",
        location: "Cebu City",
        description: "Analyse.",
      },
    });
    expect(reply.result).toEqual({ kind: "job_imported", result: { kind: "created", opportunityId: OPPORTUNITY_ID } });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/extension/import",
        query: "",
        body: {
          url: PAGE,
          title: "Data Analyst",
          company: "Bayanihan Labs",
          description: "Location: Cebu City\n\nAnalyse.",
        },
      },
    ]);
  });

  test("a location the description already names is not repeated", () => {
    const input = importInput({
      applyUrl: PAGE,
      title: "t",
      company: "c",
      location: "Cebu City",
      description: "Based in cebu city.",
    });
    expect(input.description).toBe("Based in cebu city.");
  });

  test("a server that is down or a revoked token changes the status and saves nothing", async () => {
    const down = await setup({ serverDown: true }).ask({ kind: "job_lookup", url: PAGE });
    expect(down.status.kind).toBe("unreachable");
    const revoked = await setup({ route: () => json(401, { error: { code: "unauthorized", message: "no" } }) }).ask({
      kind: "job_lookup",
      url: PAGE,
    });
    expect(revoked.status).toEqual({ kind: "unpaired", endpoint: ENDPOINT, notice: "revoked" });
  });
});

describe("content reply", () => {
  test("read_job answers with a strict, capped draft and the same nonce", () => {
    const document = openPage("<main><h1>Data Analyst</h1><p>Analyse sales data.</p></main>", PAGE);
    const reply = readJobReply({ document, nonce: NONCE });
    expect(reply?.kind).toBe("read_job_result");
    expect(reply?.nonce).toBe(NONCE);
  });
});

// ---------- Panel state ----------

const paired = { kind: "paired", endpoint: ENDPOINT, pairingId: PAIRING_ID } as const;
function reply(result: ImportReply["result"]): ImportReply {
  return asImportReply({ status: paired, error: null, result });
}

function run(events: readonly ImportEvent[], from: ImportState = IMPORT_INITIAL) {
  let state = from;
  const requests: ImportPanelRequest[] = [];
  for (const event of events) {
    const out = importTransition(state, event);
    state = out.state;
    requests.push(...out.requests);
  }
  return { state, requests };
}

const granted = { kind: "granted", origin: "https://careers.example" } as const;
const read: ImportEvent = { kind: "read_clicked", tabId: 3, access: granted };
const extracted: ImportEvent = { kind: "reply", reply: reply({ kind: "job_extracted", draft: DRAFT }) };
const notFound: ImportEvent = { kind: "reply", reply: reply({ kind: "job_lookup", lookup: { kind: "none" } }) };

describe("import panel state", () => {
  test("nothing is read before the click", () => {
    expect(IMPORT_INITIAL).toEqual({ kind: "idle", notice: null });
    const { requests } = run([{ kind: "edited", field: "title", value: "x" }, { kind: "import_clicked" }]);
    expect(requests).toEqual([]);
  });

  test("click, extract, lookup, edit, import: the import request is the edited preview", () => {
    const { state, requests } = run([
      read,
      extracted,
      notFound,
      { kind: "edited", field: "title", value: "Senior Data Analyst" },
      { kind: "import_clicked" },
    ]);
    expect(state.kind).toBe("importing");
    expect(requests).toEqual([
      { kind: "job_extract", tabId: 3 },
      { kind: "job_lookup", url: PAGE },
      {
        kind: "job_import",
        edits: {
          applyUrl: PAGE,
          title: "Senior Data Analyst",
          company: "Bayanihan Labs",
          location: "Cebu City",
          description: "Analyse sales data.",
        },
      },
    ]);
  });

  test("an already-saved job is shown with no import offered", () => {
    const found = {
      kind: "found",
      opportunityId: OPPORTUNITY_ID,
      title: "Data Analyst",
      company: "B",
      status: "saved",
    } as const;
    const { state, requests } = run([
      read,
      extracted,
      { kind: "reply", reply: reply({ kind: "job_lookup", lookup: found }) },
      { kind: "import_clicked" },
    ]);
    expect(state).toEqual({ kind: "found", found });
    expect(requests.map((r) => r.kind)).toEqual(["job_extract", "job_lookup"]);
    expect(workspaceUrl(ENDPOINT, OPPORTUNITY_ID)).toBe(`${ENDPOINT}/jobs/${OPPORTUNITY_ID}`);
    expect(workspaceUrl(ENDPOINT, null)).toBe(`${ENDPOINT}/`);
  });

  test("cancel sends nothing, and a late reply after cancel is ignored", () => {
    for (const before of [[read], [read, extracted], [read, extracted, notFound]]) {
      const { state, requests } = run([
        ...before,
        { kind: "cancel_clicked" },
        extracted,
        notFound,
        { kind: "import_clicked" },
      ]);
      expect(state).toEqual(IMPORT_INITIAL);
      expect(requests.some((r) => r.kind === "job_import")).toBe(false);
    }
  });

  test("an empty required field blocks import with a message", () => {
    const { state, requests } = run([
      read,
      extracted,
      notFound,
      { kind: "edited", field: "company", value: "  " },
      { kind: "import_clicked" },
    ]);
    expect(state.kind === "editing" && state.error).toBe("Add the company.");
    expect(requests.some((r) => r.kind === "job_import")).toBe(false);
  });

  test("denied or refused access reads nothing", () => {
    const denied = run([
      { kind: "read_clicked", tabId: 3, access: { kind: "denied", origin: "https://careers.example" } },
    ]);
    const blocked = run([{ kind: "read_clicked", tabId: 3, access: { kind: "refused", reason: "blocked_host" } }]);
    expect([...denied.requests, ...blocked.requests]).toEqual([]);
    expect(blocked.state.kind === "idle" && blocked.state.notice).toContain("terms forbid automated tools");
  });

  test("a failed lookup still offers the preview; a failed import keeps the edits", () => {
    const failed: ImportEvent = { kind: "reply", reply: reply({ kind: "failed", code: "internal", message: "Boom." }) };
    const afterLookup = run([read, extracted, failed]);
    expect(afterLookup.state.kind).toBe("editing");
    const afterImport = run(
      [{ kind: "edited", field: "title", value: "Edited" }, { kind: "import_clicked" }, failed],
      afterLookup.state,
    );
    expect(afterImport.state.kind === "editing" && [afterImport.state.fields.title, afterImport.state.error]).toEqual([
      "Edited",
      "Boom.",
    ]);
  });

  test("a worker result of another kind reads as a failure", () => {
    const narrowed = asImportReply({ status: paired, error: null, result: { kind: "scanned", nonce: NONCE } });
    expect(narrowed.result?.kind).toBe("failed");
  });
});
