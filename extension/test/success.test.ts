import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpportunityId } from "@shared/api";
import { ApplicationSessionId, PairingId, ScanNonce, SUCCESS_REASONS, type SuccessReason } from "@shared/extension";
import { Window } from "happy-dom";
import { handleImport, type ImportDeps } from "../src/background/import";
import { detectSuccess, formShown, successProbeReply } from "../src/content/success";
import { asImportReply, type ImportContentRequest, ImportPanelRequest, type ImportReply } from "../src/messages-import";
import {
  APPLIED_INITIAL,
  type AppliedEvent,
  type AppliedState,
  type AppliedWatch,
  appliedTransition,
} from "../src/panel/AppliedPrompt";
import { createStore, type KeyValueArea } from "../src/state/storage";

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

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

const APPLY = "https://boards.example/acme/jobs/42";

describe("detectSuccess", () => {
  test("the filled form, before submitting, is no signal (hidden thank-you text does not count)", async () => {
    const document = await openFixture("success-form.html", APPLY);
    expect(detectSuccess(document, APPLY)).toBeNull();
    expect(detectSuccess(document, APPLY, { formSeen: true })).toBeNull();
  });

  test("a validation-error page is never a signal, even on a thank-you address", async () => {
    const document = await openFixture("success-errors.html", `${APPLY}/thanks`);
    expect(detectSuccess(document, `${APPLY}/thanks`, { formSeen: true })).toBeNull();
    expect(detectSuccess(document, APPLY, { formSeen: true })).toBeNull();
  });

  test("aria-invalid alone, with no message, keeps the prompt away", () => {
    const document = openPage(
      `<form><input name="a" value="x"><input name="b" aria-invalid="true"></form><h1>Application submitted</h1>`,
      APPLY,
    );
    expect(detectSuccess(document, APPLY, { formSeen: true })).toBeNull();
  });

  test("an app-wide error-boundary wrapper does not hide a real confirmation", () => {
    const document = openPage(
      `<div class="error-boundary"><main><h1>Application submitted</h1><p>${"We will be in touch. ".repeat(30)}</p></main></div>`,
      APPLY,
    );
    expect(detectSuccess(document, APPLY)).toBe("confirmation_text");
  });

  test("a confirmation address gives confirmation_url", () => {
    for (const url of [
      `${APPLY}/confirmation`,
      "https://jobs.lever.co/acme/123/thanks",
      "https://jobs.ashbyhq.com/acme/123/application/success",
      "https://careers.example/apply#/thank-you",
    ]) {
      const document = openPage("<main><p>Done.</p></main>", url);
      expect(detectSuccess(document, url)).toBe("confirmation_url");
    }
  });

  test("an address that only mentions success in the query string is not a signal", () => {
    const url = `${APPLY}?utm_campaign=success`;
    const document = openPage("<main><p>Job details.</p></main>", url);
    expect(detectSuccess(document, url)).toBeNull();
  });

  test("visible confirmation text gives confirmation_text", async () => {
    const document = await openFixture("success-thanks.html", APPLY);
    expect(detectSuccess(document, APPLY)).toBe("confirmation_text");
  });

  test("the posting's own 'thank you for your interest' line is not confirmation text", () => {
    const document = openPage("<main><p>Thank you for your interest in Acme.</p></main>", APPLY);
    expect(detectSuccess(document, APPLY)).toBeNull();
  });

  test("the form disappearing gives form_gone only when a form was seen on this page", () => {
    const document = openPage("<main><h1>Backend Engineer</h1><p>All done here.</p></main>", APPLY);
    expect(detectSuccess(document, APPLY, { formSeen: true })).toBe("form_gone");
    expect(detectSuccess(document, APPLY, { formSeen: false })).toBeNull();
    expect(detectSuccess(document, APPLY)).toBeNull();
  });

  test("a hidden form counts as gone", () => {
    const document = openPage(
      `<main><form style="display:none"><input name="a"><input name="b"></form><p>Hold tight.</p></main>`,
      APPLY,
    );
    expect(detectSuccess(document, APPLY, { formSeen: true })).toBe("form_gone");
  });

  test("returns only a reason code, never page text", async () => {
    const document = await openFixture("success-thanks.html", APPLY);
    const reason = detectSuccess(document, APPLY);
    expect(reason === null || SUCCESS_REASONS.includes(reason)).toBe(true);
  });
});

describe("formShown", () => {
  const noLayout = () => null;
  test("a lone search box is not an application form", () => {
    const search = `<form role="search"><label for="q">Search</label><input id="q" name="q" type="text"></form>`;
    expect(formShown(openPage(search, APPLY), noLayout)).toBe(false);
    expect(formShown(openPage(`<input type="search" name="q"><input type="text" name="n">`, APPLY), noLayout)).toBe(
      false,
    );
  });

  test("two fields, or one file input, are", () => {
    expect(formShown(openPage(`<input name="a"><textarea name="b"></textarea>`, APPLY), noLayout)).toBe(true);
    expect(formShown(openPage(`<input type="file" name="resume">`, APPLY), noLayout)).toBe(true);
  });
});

describe("success_probe content reply", () => {
  test("carries the nonce and a reason code only", async () => {
    const nonce = ScanNonce.parse("scan-nonce-0000000001");
    const document = await openFixture("success-thanks.html", APPLY);
    expect(successProbeReply({ document, nonce, formSeen: false })).toEqual({
      kind: "success_probe_result",
      nonce,
      reason: "confirmation_text",
    });
  });
});

// ---------- Worker handler ----------

const ENDPOINT = "http://localhost:3000";
const PAIRING_ID = PairingId.parse("6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11");
const SESSION_ID = ApplicationSessionId.parse("0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b");
const OTHER_SESSION = ApplicationSessionId.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c");
const OPPORTUNITY_ID = OpportunityId.parse("4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d");
const NONCE = ScanNonce.parse("scan-nonce-0000000001");

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
  bound = true,
  probe = "confirmation_text" as string | null,
  route = (): Response => json(200, { opportunityId: OPPORTUNITY_ID, status: "applied", changed: true }),
} = {}) {
  const store = createStore({
    local: memoryArea({ endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: "A".repeat(43) } }),
    session: memoryArea(
      bound ? { binding: { sessionId: SESSION_ID, opportunityId: OPPORTUNITY_ID, tabId: 7, claimedAt: 1 } } : {},
    ),
  });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const sent: ImportContentRequest[] = [];
  const deps: ImportDeps = {
    pairing: {
      store,
      hasHostPermission: async () => true,
      fetch: async (url, init) => {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, body });
        return route();
      },
    },
    content: { getTab: async () => ({ active: true, url: APPLY }), inject: async () => "ok", newNonce: () => NONCE },
    sendContent: async (_tabId, message) => {
      sent.push(message);
      return message.kind === "success_probe"
        ? { kind: "success_probe_result", nonce: message.nonce, reason: probe }
        : undefined;
    },
  };
  const ask = (request: unknown) => handleImport({ deps, request: ImportPanelRequest.parse(request) });
  return { ask, calls, sent, store };
}

describe("success_check", () => {
  test("asks the bound tab and never calls the server, signal or not", async () => {
    for (const probe of ["confirmation_text", null] satisfies (SuccessReason | null)[]) {
      const { ask, calls, sent } = setup({ probe });
      const reply = await ask({ kind: "success_check", sessionId: SESSION_ID, tabId: 7 });
      expect(reply.result).toEqual({ kind: "success_checked", reason: probe });
      expect(sent).toEqual([{ kind: "success_probe", nonce: NONCE }]);
      expect(calls).toEqual([]);
    }
  });

  test("refuses any tab or session other than the bound one", async () => {
    for (const [options, request] of [
      [{}, { kind: "success_check", sessionId: SESSION_ID, tabId: 8 }],
      [{}, { kind: "success_check", sessionId: OTHER_SESSION, tabId: 7 }],
      [{ bound: false }, { kind: "success_check", sessionId: SESSION_ID, tabId: 7 }],
    ] as const) {
      const { ask, sent } = setup(options);
      expect((await ask(request)).result).toEqual({ kind: "refused", reason: "not_bound" });
      expect(sent).toEqual([]);
    }
  });

  test("a reply carrying page text is rejected", async () => {
    const { ask } = setup({ probe: "Thank you for applying, Ada" });
    expect((await ask({ kind: "success_check", sessionId: SESSION_ID, tabId: 7 })).result).toEqual({
      kind: "refused",
      reason: "bad_reply",
    });
  });
});

describe("confirm_applied", () => {
  test("posts the reason for the bound session and releases its binding", async () => {
    const { ask, calls, store } = setup();
    const reply = await ask({ kind: "confirm_applied", sessionId: SESSION_ID, reason: "form_gone" });
    expect(reply.result).toEqual({
      kind: "applied",
      result: { opportunityId: OPPORTUNITY_ID, status: "applied", changed: true },
    });
    expect(calls).toEqual([
      { method: "POST", path: `/api/extension/sessions/${SESSION_ID}/confirm-applied`, body: { reason: "form_gone" } },
    ]);
    expect(await store.readBinding()).toBeNull();
  });

  test("refuses a session the panel is not bound to", async () => {
    const { ask, calls } = setup();
    expect((await ask({ kind: "confirm_applied", sessionId: OTHER_SESSION, reason: null })).result).toEqual({
      kind: "refused",
      reason: "not_bound",
    });
    expect(calls).toEqual([]);
  });
});

// ---------- Prompt state ----------

const WATCH: AppliedWatch = { sessionId: SESSION_ID, tabId: 7 };
const paired = { kind: "paired", endpoint: ENDPOINT, pairingId: PAIRING_ID } as const;

function reply(result: ImportReply["result"], watch: AppliedWatch = WATCH): AppliedEvent {
  return { kind: "reply", watch, reply: asImportReply({ status: paired, error: null, result }) };
}

function run(events: readonly AppliedEvent[], from: AppliedState = APPLIED_INITIAL) {
  let state = from;
  const requests: ImportPanelRequest[] = [];
  for (const event of events) {
    const out = appliedTransition(state, event);
    state = out.state;
    requests.push(...out.requests);
  }
  return { state, requests };
}

const signal = reply({ kind: "success_checked", reason: "confirmation_url" });

describe("applied prompt state", () => {
  test("an old session's success signal cannot prompt for a new job", () => {
    const other = { ...WATCH, sessionId: OTHER_SESSION, tabId: 8 };
    const checking = run([{ kind: "watch", watch: other }, { kind: "tick" }]);
    const oldReply = { ...signal, watch: WATCH };
    expect(appliedTransition(checking.state, oldReply).state).toEqual(checking.state);
  });

  test("checks nothing until the parent starts watching", () => {
    expect(run([{ kind: "tick" }, { kind: "tick" }]).requests).toEqual([]);
  });

  test("a signal only asks; nothing but Yes sends confirm_applied", () => {
    const asked = run([{ kind: "watch", watch: WATCH }, { kind: "tick" }, signal, { kind: "tick" }, signal]);
    expect(asked.state).toEqual({ kind: "asking", watch: WATCH, reason: "confirmation_url" });
    expect(asked.requests).toEqual([{ kind: "success_check", sessionId: SESSION_ID, tabId: 7 }]);

    const yes = run([{ kind: "yes_clicked" }], asked.state);
    expect(yes.requests).toEqual([{ kind: "confirm_applied", sessionId: SESSION_ID, reason: "confirmation_url" }]);
  });

  test("no event sequence without yes_clicked yields confirm_applied", () => {
    const events: AppliedEvent[] = [
      { kind: "watch", watch: WATCH },
      { kind: "tick" },
      signal,
      { kind: "tick" },
      reply({ kind: "applied", result: { opportunityId: OPPORTUNITY_ID, status: "applied", changed: true } }),
      { kind: "no_clicked" },
      { kind: "tick" },
      signal,
      { kind: "watch", watch: { ...WATCH, tabId: 9 } },
      { kind: "tick" },
      signal,
    ];
    expect(run(events).requests.some((r) => r.kind === "confirm_applied")).toBe(false);
  });

  test("No stops asking about this session", () => {
    const { state, requests } = run([
      { kind: "watch", watch: WATCH },
      { kind: "tick" },
      signal,
      { kind: "no_clicked" },
      { kind: "watch", watch: WATCH },
      { kind: "tick" },
    ]);
    expect(state).toEqual({ kind: "declined", watch: WATCH });
    expect(requests.filter((r) => r.kind === "success_check")).toHaveLength(1);
  });

  test("no signal keeps watching; a lost binding stops", () => {
    const quiet = run([
      { kind: "watch", watch: WATCH },
      { kind: "tick" },
      reply({ kind: "success_checked", reason: null }),
    ]);
    expect(quiet.state).toEqual({ kind: "watching", watch: WATCH, checking: false });
    const lost = run([{ kind: "tick" }, reply({ kind: "refused", reason: "not_bound" })], quiet.state);
    expect(lost.state).toEqual(APPLIED_INITIAL);
  });

  test("a failed confirm can be retried only by another Yes", () => {
    const failed = run([
      { kind: "watch", watch: WATCH },
      { kind: "tick" },
      signal,
      { kind: "yes_clicked" },
      reply({ kind: "failed", code: "internal", message: "Boom." }),
      { kind: "tick" },
    ]);
    expect(failed.state).toEqual({ kind: "failed", watch: WATCH, reason: "confirmation_url", message: "Boom." });
    expect(failed.requests.filter((r) => r.kind === "confirm_applied")).toHaveLength(1);
  });
});
