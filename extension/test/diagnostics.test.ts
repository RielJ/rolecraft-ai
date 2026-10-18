import { afterEach, describe, expect, test } from "bun:test";
import {
  ApplicationSessionId,
  type DiagnosticEntry,
  FieldId,
  MAX_DIAGNOSTIC_ENTRIES,
  PairingId,
  ScanNonce,
} from "@shared/extension";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PanelReply, PanelRequest } from "../src/messages";
import { copyText, countsText, DiagnosticsView, type DiagnosticsViewProps } from "../src/panel/Diagnostics";
import { createDiagnosticsLog, originOf, outcomeOf, refusalEntry, requestEntry } from "../src/state/diagnostics";
import type { KeyValueArea } from "../src/state/storage";

const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const F1 = FieldId.parse("f1");
const F2 = FieldId.parse("f2");
const SESSION_ID = ApplicationSessionId.parse("0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b");
const PAIRED: PanelReply["status"] = {
  kind: "paired",
  endpoint: "http://localhost:3000",
  pairingId: PairingId.parse("6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11"),
};

function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}

function entry(ts: number): DiagnosticEntry {
  return { ts, kind: "request", request: "status", origin: null, adapter: null, counts: null, outcome: "ok" };
}

function reply(result?: PanelReply["result"], status: PanelReply["status"] = PAIRED): PanelReply {
  return result === undefined ? { status, error: null } : { status, error: null, result };
}

const noTab = async () => null;

describe("ring buffer", () => {
  test("keeps the last 50 entries, oldest first", async () => {
    const log = createDiagnosticsLog({ area: memoryArea() });
    for (let ts = 1; ts <= MAX_DIAGNOSTIC_ENTRIES + 5; ts++) await log.record(entry(ts));
    const entries = await log.list();
    expect(entries).toHaveLength(MAX_DIAGNOSTIC_ENTRIES);
    expect(entries[0]?.ts).toBe(6);
    expect(entries.at(-1)?.ts).toBe(MAX_DIAGNOSTIC_ENTRIES + 5);
  });

  test("entries recorded at the same time all land", async () => {
    const log = createDiagnosticsLog({ area: memoryArea() });
    await Promise.all([1, 2, 3, 4, 5].map((ts) => log.record(entry(ts))));
    expect((await log.list()).map((e) => e.ts)).toEqual([1, 2, 3, 4, 5]);
  });

  test("refuses an entry with a key outside the schema and writes nothing", async () => {
    const area = memoryArea();
    const log = createDiagnosticsLog({ area });
    const withValue = { ...entry(1), value: "ada@example.com" };
    await expect(log.record(withValue)).rejects.toThrow();
    const withPath = { ...entry(1), origin: "https://jobs.example/apply/1?token=abc" };
    await expect(log.record(withPath)).rejects.toThrow();
    expect(area.data).toEqual({});
    // The queue still runs after a refused entry.
    await log.record(entry(2));
    expect(await log.list()).toEqual([entry(2)]);
  });

  test("drops stored entries that do not parse", async () => {
    const area = memoryArea({ diagnostics: [entry(1), { ...entry(2), label: "Email" }, "junk", entry(3)] });
    expect((await createDiagnosticsLog({ area }).list()).map((e) => e.ts)).toEqual([1, 3]);
    expect(await createDiagnosticsLog({ area: memoryArea({ diagnostics: "junk" }) }).list()).toEqual([]);
  });

  test("clear empties the log", async () => {
    const area = memoryArea();
    const log = createDiagnosticsLog({ area });
    await log.record(entry(1));
    await log.clear();
    expect(await log.list()).toEqual([]);
    expect(area.data).toEqual({});
  });
});

describe("originOf", () => {
  test("keeps scheme, host and port only", () => {
    expect(originOf("https://boards.greenhouse.io/acme/jobs/1?gh_src=x#apply")).toBe("https://boards.greenhouse.io");
    expect(originOf("https://ada:secret@jobs.example:8443/a")).toBe("https://jobs.example:8443");
    expect(originOf("http://localhost:3000/api/extension/ping")).toBe("http://localhost:3000");
  });

  test("records nothing for other schemes, LAN http, or junk", () => {
    for (const url of [
      "http://jobs.example/apply",
      "http://192.168.1.5:3000",
      "file:///etc/passwd",
      "not a url",
      null,
    ]) {
      expect(originOf(url)).toBeNull();
    }
    expect(originOf("chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html")).toBeNull();
  });
});

describe("outcomeOf", () => {
  const status: PanelRequest = { kind: "status" };

  test("names the refusal, failure code or connection problem", () => {
    expect(outcomeOf({ request: status, reply: reply({ kind: "refused", reason: "not_bound" }) })).toBe("not_bound");
    expect(
      outcomeOf({ request: status, reply: reply({ kind: "failed", code: "session_expired", message: "Expired" }) }),
    ).toBe("session_expired");
    expect(outcomeOf({ request: status, reply: reply({ kind: "failed", code: "made_up", message: "x" }) })).toBe(
      "internal",
    );
    expect(outcomeOf({ request: status, reply: reply({ kind: "failed", code: "ok", message: "x" }) })).toBe("internal");
    expect(
      outcomeOf({ request: status, reply: reply({ kind: "attach_rejected", fieldId: null, reason: "too_large" }) }),
    ).toBe("too_large");
    expect(outcomeOf({ request: status, reply: reply(undefined, { kind: "unreachable", endpoint: "x" }) })).toBe(
      "network",
    );
    const revoked = { kind: "unpaired", endpoint: "x", notice: "revoked" } as const;
    expect(outcomeOf({ request: status, reply: reply(undefined, revoked) })).toBe("unauthorized");
  });

  test("tells a failed pairing and a deliberate disconnect apart from being unpaired", () => {
    const unpaired = { kind: "unpaired", endpoint: "x", notice: null } as const;
    const pairRequest: PanelRequest = { kind: "pair", endpoint: "http://localhost:3000", code: "ABCD-EFGH" };
    expect(outcomeOf({ request: pairRequest, reply: { status: unpaired, error: "Wrong code" } })).toBe("pair_failed");
    expect(outcomeOf({ request: { kind: "disconnect" }, reply: reply(undefined, unpaired) })).toBe("ok");
    expect(outcomeOf({ request: status, reply: reply(undefined, unpaired) })).toBe("unpaired");
  });
});

describe("requestEntry", () => {
  test("a scan records the adapter, the field count and the tab's origin, not its address", async () => {
    const recorded = await requestEntry({
      request: { kind: "scan", tabId: 7 },
      reply: reply({ kind: "scanned", nonce: NONCE, adapter: "lever", fields: [] }),
      ts: 5,
      getTab: async () => ({ url: "https://jobs.lever.co/acme/123/apply?lever-source=x" }),
    });
    expect(recorded).toEqual({
      ts: 5,
      kind: "request",
      request: "scan",
      origin: "https://jobs.lever.co",
      adapter: "lever",
      counts: { fields: 0, matched: 0, filled: 0, skipped: 0, unresolved: 0 },
      outcome: "ok",
    });
  });

  test("a fill records counts only: no field ids or values", async () => {
    const recorded = await requestEntry({
      request: {
        kind: "fill",
        tabId: 7,
        plan: {
          nonce: NONCE,
          entries: [
            { fieldId: F1, value: { kind: "text", text: "Ada Lovelace" } },
            { fieldId: F2, value: { kind: "text", text: "ada@example.com" } },
          ],
        },
      },
      reply: reply({
        kind: "filled",
        result: { nonce: NONCE, filled: [F1], skipped: [{ fieldId: F2, reason: "not_empty" }] },
      }),
      ts: 5,
      getTab: async () => ({ url: "https://jobs.example/apply" }),
    });
    expect(recorded.counts).toEqual({ fields: 2, matched: 0, filled: 1, skipped: 1, unresolved: 0 });
    const text = JSON.stringify(recorded);
    for (const secret of ["Ada", "ada@example.com", "f1", "f2", "/apply"]) expect(text).not.toContain(secret);
  });

  test("a claim keeps the origin of the tab URL, and a lookup the origin of the job URL", async () => {
    const claim = await requestEntry({
      request: {
        kind: "session_claim",
        sessionId: SESSION_ID,
        tabId: 7,
        tabUrl: "https://boards.example/jobs/1",
        confirmMismatch: false,
      },
      reply: reply({ kind: "refused", reason: "tab_changed" }),
      ts: 1,
      getTab: noTab,
    });
    expect(claim).toMatchObject({ origin: "https://boards.example", outcome: "tab_changed", counts: null });

    const lookup = await requestEntry({
      request: { kind: "job_lookup", url: "https://jobs.example/postings/42?utm=x" },
      reply: reply({ kind: "failed", code: "not_found", message: "No job" }),
      ts: 1,
      getTab: noTab,
    });
    expect(lookup).toMatchObject({ origin: "https://jobs.example", outcome: "not_found" });
  });

  test("a tab that is gone records no origin", async () => {
    const recorded = await requestEntry({
      request: { kind: "job_extract", tabId: 7 },
      reply: reply({ kind: "refused", reason: "unsupported_url" }),
      ts: 1,
      getTab: async () => {
        throw new Error("No tab with id: 7");
      },
    });
    expect(recorded.origin).toBeNull();
  });
});

describe("refusalEntry", () => {
  test("keeps a known message kind and the sender origin", () => {
    expect(
      refusalEntry({
        message: { kind: "scan", nonce: NONCE, extra: "x" },
        senderUrl: "https://jobs.example/apply/1",
        reason: "bad_message",
        ts: 3,
      }),
    ).toEqual({
      ts: 3,
      kind: "refusal",
      request: "scan",
      origin: "https://jobs.example",
      adapter: null,
      counts: null,
      outcome: "bad_message",
    });
  });

  test("never copies a kind the worker does not know", () => {
    for (const message of [{ kind: "ada_lovelace" }, { kind: "Ada" }, { kind: 1 }, "scan", null, undefined]) {
      expect(refusalEntry({ message, senderUrl: undefined, reason: "foreign_sender", ts: 1 }).request).toBe("unknown");
    }
  });
});

describe("Diagnostics tab", () => {
  const windows: Window[] = [];
  afterEach(async () => {
    await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
  });

  const scan: DiagnosticEntry = {
    ts: 1,
    kind: "request",
    request: "scan",
    origin: "https://jobs.lever.co",
    adapter: "lever",
    counts: { fields: 12, matched: 0, filled: 0, skipped: 0, unresolved: 0 },
    outcome: "ok",
  };
  const refused: DiagnosticEntry = {
    ts: 2,
    kind: "refusal",
    request: "unknown",
    origin: null,
    adapter: null,
    counts: null,
    outcome: "bad_message",
  };

  function render(props: Partial<DiagnosticsViewProps>) {
    const noop = () => undefined;
    const markup = renderToStaticMarkup(
      createElement(DiagnosticsView, {
        ping: { status: PAIRED, at: 0 },
        entries: [],
        origins: [],
        copied: "idle",
        busy: false,
        onPing: noop,
        onCopy: noop,
        onClear: noop,
        onRevoke: noop,
        ...props,
      }),
    );
    const window = new Window();
    windows.push(window);
    return new window.DOMParser().parseFromString(markup, "text/html");
  }

  test("shows the connection, newest entry first, and a Revoke per allowed site", () => {
    const doc = render({ entries: [scan, refused], origins: ["https://jobs.lever.co", "https://boards.example"] });
    expect(doc.body.textContent).toContain("http://localhost:3000");
    expect(doc.body.textContent).toContain("Paired");
    const rows = [...doc.querySelectorAll("ol li")].map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("refused unknown");
    expect(rows[0]).toContain("bad_message");
    expect(rows[1]).toContain("https://jobs.lever.co");
    expect(rows[1]).toContain("12 fields");
    const revokes = [...doc.querySelectorAll("button[aria-label^='Revoke ']")].map((b) => b.getAttribute("aria-label"));
    expect(revokes).toEqual(["Revoke https://jobs.lever.co", "Revoke https://boards.example"]);
  });

  test("an empty log offers nothing to copy or clear", () => {
    const doc = render({ entries: [] });
    const buttons = [...doc.querySelectorAll("button")].filter((b) => ["Copy", "Clear"].includes(b.textContent ?? ""));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
    expect(doc.body.textContent).toContain("Nothing recorded yet.");
  });

  test("Copy puts the stored entries on the clipboard as they are", () => {
    expect(JSON.parse(copyText([scan, refused]))).toEqual([scan, refused]);
  });

  test("counts read as words, zeros left out", () => {
    expect(countsText({ fields: 1, matched: 0, filled: 0, skipped: 0, unresolved: 0 })).toBe("1 field");
    expect(countsText({ fields: 12, matched: 8, filled: 6, skipped: 0, unresolved: 4 })).toBe(
      "12 fields, 8 matched, 6 filled, 4 unresolved",
    );
    expect(countsText(null)).toBeNull();
  });
});
