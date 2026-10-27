import { describe, expect, test } from "bun:test";
import { OpportunityId } from "@shared/api";
import {
  ApplicationSessionId,
  EXTENSION_AUTH_MATRIX,
  ExtensionEndpoint,
  PairingId,
  PingResult,
} from "@shared/extension";
import { z } from "zod";
import { createClient, type FetchLike, ROUTES } from "../src/api/client";
import { getStatus, pair } from "../src/background/pairing";
import { hostPermissionPattern } from "../src/state/endpoint";
import { createStore, type KeyValueArea } from "../src/state/storage";

const ENDPOINT = "http://localhost:3000";
const TOKEN = "A".repeat(43);
const PAIRING_ID = "6f1c2a8e-4b1d-4c55-9a59-1f0f3b8f2d11";
const SESSION_ID = "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b";
const OPPORTUNITY_ID = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";

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

type Sent = { url: string; init: RequestInit };

function fakeFetch(respond: (sent: Sent) => Response | Promise<Response>): FetchLike & { sent: Sent[] } {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call = { url, init };
    sent.push(call);
    return respond(call);
  };
  return Object.assign(fn, { sent });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pairedStores() {
  const local = memoryArea({ endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: TOKEN } });
  const session = memoryArea({
    binding: { sessionId: SESSION_ID, opportunityId: OPPORTUNITY_ID, tabId: 7, claimedAt: 1 },
  });
  return { local, session, store: createStore({ local, session }) };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("session binding cleanup", () => {
  test("a binding saved during compare-and-clear is not removed", async () => {
    const { local, session } = pairedStores();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const store = createStore({
      local,
      session: {
        ...session,
        get: async (keys) => {
          const snapshot = await session.get(keys);
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return snapshot;
        },
      },
    });
    const oldId = ApplicationSessionId.parse(SESSION_ID);
    const clearing = store.clearBinding(oldId);
    await entered.promise;
    const nextId = ApplicationSessionId.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c");
    const saving = store.saveBinding({
      sessionId: nextId,
      opportunityId: OpportunityId.parse(OPPORTUNITY_ID),
      tabId: 8,
      claimedAt: 2,
    });
    release.resolve();
    await Promise.all([clearing, saving]);
    expect(await store.readBinding()).toMatchObject({ sessionId: nextId, tabId: 8 });
  });

  test("clearing an old session leaves the new binding intact", async () => {
    const { store } = pairedStores();
    await store.clearBinding(ApplicationSessionId.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c"));
    expect(await store.readBinding()).toMatchObject({ sessionId: SESSION_ID, tabId: 7 });
  });
});

describe("client: bearer calls", () => {
  test("an old request's late network failure leaves the new binding intact", async () => {
    const { store } = pairedStores();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const client = createClient({
      store,
      fetch: fakeFetch(() => {
        entered.resolve();
        return response.promise;
      }),
    });
    const old = client.call({ route: ROUTES.ping, schema: PingResult });
    await entered.promise;
    const binding = await store.readBinding();
    if (binding === null) throw new Error("No binding");
    const nextId = ApplicationSessionId.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c");
    await store.saveBinding({ ...binding, sessionId: nextId, tabId: 8 });
    response.reject(new TypeError("Failed to fetch"));
    expect(await old).toEqual({ kind: "unreachable" });
    expect(await store.readBinding()).toMatchObject({ sessionId: nextId, tabId: 8 });
  });
  test("sends the bearer token, refuses redirects, and parses with the schema", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => json(200, { ok: true, pairingId: PAIRING_ID }));
    const client = createClient({ fetch, store });

    const out = await client.call({ route: ROUTES.ping, schema: PingResult });

    expect(out).toEqual({ kind: "ok", data: PingResult.parse({ ok: true, pairingId: PAIRING_ID }) });
    const [sent] = fetch.sent;
    expect(sent?.url).toBe(`${ENDPOINT}/api/extension/ping`);
    expect(sent?.init.method).toBe("GET");
    expect(sent?.init.redirect).toBe("error");
    expect(sent?.init.credentials).toBe("omit");
    expect(header(sent?.init ?? {}, "Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("fills path params, encoded, and sends a JSON body", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => json(200, {}));
    const client = createClient({ fetch, store });

    await client.call({
      route: ROUTES.claimSession,
      params: { id: "a/b?c" },
      body: { tabUrl: "https://example.com/apply" },
      schema: z.object({}),
    });

    const [sent] = fetch.sent;
    expect(sent?.url).toBe(`${ENDPOINT}/api/extension/sessions/a%2Fb%3Fc/claim`);
    expect(sent?.init.method).toBe("POST");
    expect(header(sent?.init ?? {}, "Content-Type")).toBe("application/json");
    expect(sent?.init.body).toBe(JSON.stringify({ tabUrl: "https://example.com/apply" }));
  });

  test("401 means unpaired: the token and the session binding are cleared, the endpoint kept", async () => {
    const { local, session, store } = pairedStores();
    const fetch = fakeFetch(() => json(401, { error: { code: "unauthorized", message: "Pair again." } }));
    const client = createClient({ fetch, store });

    const out = await client.call({ route: ROUTES.ping, schema: PingResult });

    expect(out).toEqual({ kind: "unpaired" });
    expect(local.data.pairing).toBeUndefined();
    expect(local.data.endpoint).toBe(ENDPOINT);
    expect(session.data.binding).toBeUndefined();
  });

  test("a network failure fails closed: unreachable, binding cleared, token kept", async () => {
    const { local, session, store } = pairedStores();
    const fetch = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const client = createClient({ fetch, store });

    const out = await client.call({ route: ROUTES.activeSession, schema: z.object({}) });

    expect(out).toEqual({ kind: "unreachable" });
    expect(session.data.binding).toBeUndefined();
    expect(local.data.pairing).toEqual({ pairingId: PAIRING_ID, token: TOKEN });
  });

  test("without a stored pairing nothing is sent", async () => {
    const store = createStore({ local: memoryArea({ endpoint: ENDPOINT }), session: memoryArea() });
    const fetch = fakeFetch(() => json(200, {}));

    const out = await createClient({ fetch, store }).call({ route: ROUTES.ping, schema: PingResult });

    expect(out).toEqual({ kind: "unpaired" });
    expect(fetch.sent).toHaveLength(0);
  });

  test("a stored token that is not a token reads as unpaired", async () => {
    const store = createStore({
      local: memoryArea({ endpoint: ENDPOINT, pairing: { pairingId: PAIRING_ID, token: "short" } }),
      session: memoryArea(),
    });
    const fetch = fakeFetch(() => json(200, {}));

    const out = await createClient({ fetch, store }).call({ route: ROUTES.ping, schema: PingResult });

    expect(out).toEqual({ kind: "unpaired" });
    expect(fetch.sent).toHaveLength(0);
  });

  test("a 2xx body that does not match the schema is a failure, not data", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => json(200, { ok: "yes" }));

    const out = await createClient({ fetch, store }).call({ route: ROUTES.ping, schema: PingResult });

    expect(out).toMatchObject({ kind: "failed", code: "bad_response", status: 200 });
  });

  test("an app error keeps its code and message", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => json(409, { error: { code: "session_expired", message: "Apply again." } }));

    const out = await createClient({ fetch, store }).call({ route: ROUTES.activeSession, schema: z.object({}) });

    expect(out).toEqual({
      kind: "failed",
      status: 409,
      code: "session_expired",
      message: "Apply again.",
      details: undefined,
    });
  });
});

describe("client: routes", () => {
  const bearer = EXTENSION_AUTH_MATRIX.filter((r) => r.caller === "extension" && r.auth === "bearer");

  test("every client route is a bearer route in the auth matrix", () => {
    for (const route of Object.values(ROUTES)) {
      expect(bearer.some((r) => r.method === route.method && r.path === route.path)).toBe(true);
    }
  });

  test("the client covers every bearer route in the auth matrix", () => {
    const known = Object.values(ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(known.sort()).toEqual(bearer.map((r) => `${r.method} ${r.path}`).sort());
  });
});

describe("endpoint", () => {
  test.each([
    "http://192.168.1.10:3000",
    "http://10.0.0.2:3000",
    "http://rolecraft.local:3000",
    "http://localhost:3000/api",
    "http://user:pw@localhost:3000",
    "ftp://localhost:3000",
  ])("rejects %s", (raw) => {
    expect(ExtensionEndpoint.safeParse(raw).success).toBe(false);
  });

  test.each([
    ["http://localhost:3000", "http://localhost/*"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1/*"],
    ["https://rolecraft.example.com", "https://rolecraft.example.com/*"],
  ])("%s asks for host permission %s", (raw, pattern) => {
    expect(hostPermissionPattern(ExtensionEndpoint.parse(raw))).toBe(pattern);
  });
});

describe("pairing", () => {
  const claimed = { pairingId: PAIRING_ID, token: TOKEN };

  function pairingDeps({ granted = true, respond }: { granted?: boolean; respond: (sent: Sent) => Response }) {
    const local = memoryArea();
    const session = memoryArea();
    const store = createStore({ local, session });
    const fetch = fakeFetch(respond);
    const asked: string[] = [];
    const hasHostPermission = async (pattern: string) => {
      asked.push(pattern);
      return granted;
    };
    return { local, store, fetch, asked, deps: { store, fetch, hasHostPermission } };
  }

  test("a LAN HTTP endpoint is refused before any request", async () => {
    const t = pairingDeps({ respond: () => json(200, claimed) });

    const reply = await pair({ deps: t.deps, endpoint: "http://192.168.1.10:3000", code: "ABCD-EFGH" });

    expect(reply.error).not.toBeNull();
    expect(reply.status.kind).toBe("unpaired");
    expect(t.fetch.sent).toHaveLength(0);
    expect(t.asked).toHaveLength(0);
  });

  test("without host permission for the endpoint nothing is sent", async () => {
    const t = pairingDeps({ granted: false, respond: () => json(200, claimed) });

    const reply = await pair({ deps: t.deps, endpoint: ENDPOINT, code: "ABCD-EFGH" });

    expect(t.asked).toEqual(["http://localhost/*"]);
    expect(reply.error).not.toBeNull();
    expect(t.fetch.sent).toHaveLength(0);
  });

  test("claims with the normalized code and no bearer, stores the token, then pings", async () => {
    const t = pairingDeps({
      respond: ({ url }) => (url.endsWith("/pair/claim") ? json(200, claimed) : json(200, { ok: true, ...claimed })),
    });

    const reply = await pair({ deps: t.deps, endpoint: `${ENDPOINT}/`, code: " abcd-efgh " });

    expect(reply).toEqual({
      error: null,
      status: { kind: "paired", endpoint: ENDPOINT, pairingId: PairingId.parse(PAIRING_ID) },
    });
    const [claim, ping] = t.fetch.sent;
    expect(claim?.url).toBe(`${ENDPOINT}/api/extension/pair/claim`);
    expect(claim?.init.body).toBe(JSON.stringify({ code: "ABCDEFGH" }));
    expect(claim?.init.redirect).toBe("error");
    expect(header(claim?.init ?? {}, "Authorization")).toBeNull();
    expect(header(ping?.init ?? {}, "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(t.local.data).toMatchObject({ endpoint: ENDPOINT, pairing: claimed });
  });

  test("a rejected code stores nothing and says why", async () => {
    const t = pairingDeps({
      respond: () => json(401, { error: { code: "unauthorized", message: "Code expired." } }),
    });

    const reply = await pair({ deps: t.deps, endpoint: ENDPOINT, code: "ABCD-EFGH" });

    expect(reply.status.kind).toBe("unpaired");
    expect(reply.error).toBe("Code expired.");
    expect(t.local.data.pairing).toBeUndefined();
  });

  test("status with a revoked token drops to unpaired", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => json(401, { error: { code: "unauthorized", message: "Revoked." } }));

    const reply = await getStatus({ deps: { store, fetch, hasHostPermission: async () => true } });

    expect(reply.status).toEqual({ kind: "unpaired", endpoint: ENDPOINT, notice: "revoked" });
  });

  test("status with the server down is unreachable, not paired", async () => {
    const { store } = pairedStores();
    const fetch = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const reply = await getStatus({ deps: { store, fetch, hasHostPermission: async () => true } });

    expect(reply.status).toEqual({ kind: "unreachable", endpoint: ENDPOINT });
  });

  test("status before any pairing offers the default endpoint", async () => {
    const store = createStore({ local: memoryArea(), session: memoryArea() });
    const fetch = fakeFetch(() => json(200, {}));

    const reply = await getStatus({ deps: { store, fetch, hasHostPermission: async () => true } });

    expect(reply.status).toEqual({ kind: "unpaired", endpoint: ENDPOINT, notice: null });
    expect(fetch.sent).toHaveLength(0);
  });
});
