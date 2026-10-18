import { describe, expect, test } from "bun:test";
import { PanelResult, routeMessage } from "../src/messages";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const PANEL_URL = `chrome-extension://${ID}/panel.html`;
const NONCE = "n".repeat(16);

describe("routeMessage", () => {
  test("hears the panel", () => {
    expect(routeMessage({ message: { kind: "status" }, sender: { id: ID, url: PANEL_URL }, runtimeId: ID })).toEqual({
      kind: "panel",
      request: { kind: "status" },
    });
  });

  test("hears the panel when it is open in a tab", () => {
    const sender = { id: ID, url: PANEL_URL, frameId: 0, tab: { id: 9 } };
    expect(routeMessage({ message: { kind: "status" }, sender, runtimeId: ID }).kind).toBe("panel");
  });

  test("rejects another extension, even with a valid message", () => {
    const sender = { id: "ponmlkjihgfedcbaponmlkjihgfedcba", url: PANEL_URL };
    expect(routeMessage({ message: { kind: "status" }, sender, runtimeId: ID })).toEqual({
      kind: "rejected",
      reason: "foreign_sender",
    });
  });

  test("rejects a tabless sender that is not one of our pages", () => {
    const sender = { id: ID, url: "https://evil.example/" };
    expect(routeMessage({ message: { kind: "status" }, sender, runtimeId: ID }).kind).toBe("rejected");
  });

  test("rejects a panel message with extra keys or an unknown kind", () => {
    const sender = { id: ID, url: PANEL_URL };
    expect(routeMessage({ message: { kind: "status", selector: "#x" }, sender, runtimeId: ID })).toEqual({
      kind: "rejected",
      reason: "bad_message",
    });
    expect(routeMessage({ message: { kind: "eval" }, sender, runtimeId: ID }).kind).toBe("rejected");
  });

  test("a tab must use RuntimeMessage, not panel requests", () => {
    const sender = { id: ID, url: "https://jobs.example/apply", frameId: 0, tab: { id: 4 } };
    expect(routeMessage({ message: { kind: "disconnect" }, sender, runtimeId: ID })).toEqual({
      kind: "rejected",
      reason: "bad_message",
    });
    expect(routeMessage({ message: { kind: "scan", nonce: NONCE }, sender, runtimeId: ID })).toMatchObject({
      kind: "content",
      tabId: 4,
      url: "https://jobs.example/apply",
    });
  });

  test("hears panel fill and claim requests only from the panel", () => {
    const fill = {
      kind: "fill",
      tabId: 4,
      plan: { nonce: NONCE, entries: [{ fieldId: "f1", value: { kind: "text", text: "Ada" } }] },
    };
    expect(routeMessage({ message: fill, sender: { id: ID, url: PANEL_URL }, runtimeId: ID }).kind).toBe("panel");
    const tab = { id: ID, url: "https://jobs.example/apply", frameId: 0, tab: { id: 4 } };
    expect(routeMessage({ message: fill, sender: tab, runtimeId: ID })).toEqual({
      kind: "rejected",
      reason: "bad_message",
    });
    const claim = {
      kind: "session_claim",
      sessionId: "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b",
      tabId: 4,
      tabUrl: "https://jobs.example/apply",
      confirmMismatch: false,
    };
    expect(routeMessage({ message: claim, sender: tab, runtimeId: ID }).kind).toBe("rejected");
    expect(routeMessage({ message: claim, sender: { id: ID, url: PANEL_URL }, runtimeId: ID }).kind).toBe("panel");
  });

  test("rejects panel requests with a bad tab, url or origin", () => {
    const sender = { id: ID, url: PANEL_URL };
    const bad = [
      { kind: "scan", tabId: -1 },
      { kind: "scan", tabId: 1.5 },
      {
        kind: "session_claim",
        sessionId: "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b",
        tabId: 1,
        tabUrl: "javascript:alert(1)",
        confirmMismatch: false,
      },
      { kind: "revoke_origin", origin: "https://jobs.example/path" },
      { kind: "revoke_origin", origin: "http://jobs.example" },
      { kind: "fill", tabId: 1, plan: { nonce: NONCE, entries: [], overwrite: true } },
    ];
    for (const message of bad) {
      expect(routeMessage({ message, sender, runtimeId: ID })).toEqual({ kind: "rejected", reason: "bad_message" });
    }
  });

  test("hears attach, import and applied requests only from the panel, strictly", () => {
    const session = "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b";
    const outputId = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
    const page = "https://jobs.example/apply";
    const requests = [
      { kind: "attach", sessionId: session, tabId: 4, nonce: NONCE, fieldId: "f1", outputId },
      { kind: "attach_download", sessionId: session, outputId },
      { kind: "job_extract", tabId: 4 },
      { kind: "job_lookup", url: page },
      {
        kind: "job_import",
        edits: { applyUrl: page, title: "Analyst", company: "Acme", location: "", description: "Do things." },
      },
      { kind: "success_check", sessionId: session, tabId: 4 },
      { kind: "confirm_applied", sessionId: session, reason: "confirmation_url" },
    ];
    const panel = { id: ID, url: PANEL_URL };
    const tab = { id: ID, url: page, frameId: 0, tab: { id: 4 } };
    for (const message of requests) {
      expect<unknown>(routeMessage({ message, sender: panel, runtimeId: ID })).toEqual({
        kind: "panel",
        request: message,
      });
      expect(routeMessage({ message, sender: tab, runtimeId: ID })).toEqual({
        kind: "rejected",
        reason: "bad_message",
      });
      expect(routeMessage({ message: { ...message, selector: "#x" }, sender: panel, runtimeId: ID })).toEqual({
        kind: "rejected",
        reason: "bad_message",
      });
    }
  });

  test("worker-to-page import requests are heard from neither side", () => {
    const panel = { id: ID, url: PANEL_URL };
    const tab = { id: ID, url: "https://jobs.example/apply", frameId: 0, tab: { id: 4 } };
    for (const message of [
      { kind: "read_job", nonce: NONCE },
      { kind: "success_probe", nonce: NONCE },
      { kind: "success_signal", reason: "form_gone" },
      { kind: "extract_page", nonce: NONCE },
    ]) {
      for (const sender of [panel, tab]) {
        expect(routeMessage({ message, sender, runtimeId: ID })).toEqual({ kind: "rejected", reason: "bad_message" });
      }
    }
  });

  test("panel results include the attach and import kinds", () => {
    const opportunityId = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
    const results = [
      { kind: "attach_done", fieldId: "f1", fileName: "Resume.pdf" },
      { kind: "attach_rejected", fieldId: null, reason: "too_large" },
      { kind: "job_lookup", lookup: { kind: "none" } },
      { kind: "job_imported", result: { kind: "created", opportunityId } },
      { kind: "success_checked", reason: null },
      { kind: "applied", result: { opportunityId, status: "applied", changed: true } },
    ];
    for (const result of results) expect<unknown>(PanelResult.parse(result)).toEqual(result);
  });

  test("hears diagnostics requests only from the panel, with no extra keys", () => {
    const panel = { id: ID, url: PANEL_URL };
    const tab = { id: ID, url: "https://jobs.example/apply", frameId: 0, tab: { id: 4 } };
    for (const message of [{ kind: "diagnostics_list" }, { kind: "diagnostics_clear" }]) {
      expect<unknown>(routeMessage({ message, sender: panel, runtimeId: ID })).toEqual({
        kind: "panel",
        request: message,
      });
      expect(routeMessage({ message, sender: tab, runtimeId: ID }).kind).toBe("rejected");
      expect(routeMessage({ message: { ...message, limit: 5 }, sender: panel, runtimeId: ID }).kind).toBe("rejected");
    }
  });

  test("the diagnostics result holds strict entries only", () => {
    const entry = {
      ts: 1,
      kind: "request",
      request: "scan",
      origin: "https://jobs.example",
      adapter: "generic",
      counts: null,
      outcome: "ok",
    };
    expect<unknown>(PanelResult.parse({ kind: "diagnostics", entries: [entry] })).toEqual({
      kind: "diagnostics",
      entries: [entry],
    });
    const leaky = { ...entry, label: "Email" };
    expect(PanelResult.safeParse({ kind: "diagnostics", entries: [leaky] }).success).toBe(false);
    const tooMany = Array.from({ length: 51 }, () => entry);
    expect(PanelResult.safeParse({ kind: "diagnostics", entries: tooMany }).success).toBe(false);
  });

  test("rejects subframes", () => {
    const sender = { id: ID, url: "https://jobs.example/frame", frameId: 3, tab: { id: 4 } };
    expect(routeMessage({ message: { kind: "scan", nonce: NONCE }, sender, runtimeId: ID })).toEqual({
      kind: "rejected",
      reason: "not_top_frame",
    });
  });
});
