import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ApiErrorBody } from "@/shared/api";
import {
  ClaimPairingResult,
  CreatePairingResult,
  EXTENSION_AUTH_MATRIX,
  PAIRING_CODE_TTL_MS,
  PairingDto,
  PairingList,
  PingResult,
} from "@/shared/extension";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Chrome extension (docs/EXTENSION.md): the extension router skeleton, its bearer guard,
 * route-local CORS and pairing. Iterates EXTENSION_AUTH_MATRIX so a route added to the contract
 * without the matching guard fails here.
 */

// app.request builds http://localhost/..., so the app's own origin is http://localhost.
const APP_ORIGIN = "http://localhost";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT_ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const SOME_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-16T08:00:00Z");

let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps({ clock: { now: () => NOW } });
  app = createApp(deps);
});

type Call = { method?: string; path: string; headers?: Record<string, string>; body?: unknown };

function call(target: ReturnType<typeof createApp>, { method = "GET", path, headers = {}, body }: Call) {
  const sent = new Headers(headers);
  if (body !== undefined && !sent.has("content-type")) sent.set("content-type", "application/json");
  return target.request(path, {
    method,
    headers: sent,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Hono path syntax to a concrete path: every `:param` becomes a well-formed id. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, SOME_ID);
}

/** A JSON body that is valid for the route when it takes one, so a 400 never hides a guard. */
function bodyFor(method: string): unknown {
  return method === "GET" || method === "DELETE" ? undefined : {};
}

async function errorCode(res: Response): Promise<string> {
  return ApiErrorBody.parse(await res.json()).error.code;
}

const bearerRoutes = EXTENSION_AUTH_MATRIX.filter((r) => r.auth === "bearer");
const spaRoutes = EXTENSION_AUTH_MATRIX.filter((r) => r.caller === "spa");

async function createPairing(target = app): Promise<CreatePairingResult> {
  const res = await call(target, {
    method: "POST",
    path: "/api/extension-web/pairings",
    headers: { origin: APP_ORIGIN },
    body: {},
  });
  expect(res.status).toBe(201);
  return CreatePairingResult.parse(await res.json());
}

function claim(target: ReturnType<typeof createApp>, code: string, origin: string | null = EXT_ORIGIN) {
  return call(target, {
    method: "POST",
    path: "/api/extension/pair/claim",
    headers: origin === null ? {} : { origin },
    body: { code },
  });
}

async function pair(): Promise<ClaimPairingResult> {
  const { code } = await createPairing();
  const res = await claim(app, code);
  expect(res.status).toBe(200);
  return ClaimPairingResult.parse(await res.json());
}

function bearer(token: string, origin: string | null = EXT_ORIGIN): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(origin === null ? {} : { origin }) };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("auth matrix: bearer routes", () => {
  test("the matrix lists bearer routes", () => {
    expect(bearerRoutes.length).toBeGreaterThan(10);
  });

  for (const route of bearerRoutes) {
    test(`${route.method} ${route.path} without a token is 401`, async () => {
      const res = await call(app, { method: route.method, path: concrete(route.path), body: bodyFor(route.method) });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await errorCode(res)).toBe("unauthorized");
    });

    test(`${route.method} ${route.path} with a malformed or unknown token is 401`, async () => {
      for (const authorization of ["Bearer nope", `Bearer ${"A".repeat(43)}`, `Basic ${"A".repeat(43)}`]) {
        const res = await call(app, {
          method: route.method,
          path: concrete(route.path),
          headers: { authorization, origin: EXT_ORIGIN },
          body: bodyFor(route.method),
        });
        expect(res.status).toBe(401);
      }
    });

    test(`${route.method} ${route.path} with a valid token from another origin is 403`, async () => {
      const { token } = await pair();
      for (const origin of [OTHER_EXT_ORIGIN, APP_ORIGIN, "https://evil.example"]) {
        const res = await call(app, {
          method: route.method,
          path: concrete(route.path),
          headers: bearer(token, origin),
          body: bodyFor(route.method),
        });
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
        expect(await errorCode(res)).toBe("forbidden_origin");
      }
    });

    test(`${route.method} ${route.path} with a valid token passes the guard`, async () => {
      const { token } = await pair();
      for (const origin of [EXT_ORIGIN, null]) {
        const res = await call(app, {
          method: route.method,
          path: concrete(route.path),
          headers: bearer(token, origin),
          body: bodyFor(route.method),
        });
        expect([401, 403]).not.toContain(res.status);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    });
  }
});

describe("auth matrix: SPA routes", () => {
  for (const route of spaRoutes) {
    test(`${route.method} ${route.path} needs no token`, async () => {
      const res = await call(app, {
        method: route.method,
        path: concrete(route.path),
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: bodyFor(route.method),
      });
      expect([401, 403]).not.toContain(res.status);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    if (route.origin === "app_origin_json") {
      test(`${route.method} ${route.path} from a foreign or extension Origin is 403`, async () => {
        for (const origin of ["https://evil.example", EXT_ORIGIN]) {
          const res = await call(app, {
            method: route.method,
            path: concrete(route.path),
            headers: { origin, "content-type": "application/json" },
            body: bodyFor(route.method),
          });
          expect(res.status).toBe(403);
          expect(await errorCode(res)).toBe("forbidden_origin");
        }
      });

      test(`${route.method} ${route.path} without a JSON Content-Type is 403`, async () => {
        const res = await app.request(concrete(route.path), {
          method: route.method,
          headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
          ...(route.method === "DELETE" ? {} : { body: "{}" }),
        });
        expect(res.status).toBe(403);
        expect(await errorCode(res)).toBe("forbidden_origin");
      });
    }
  }
});

describe("the guard does not leak", () => {
  test.each(["/api/profile", "/api/board", "/api/settings"])("GET %s without a token is not 401", async (path) => {
    const res = await call(app, { path });
    expect(res.status).not.toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test.each(["/api/nope", "/api/extensionx/ping", "/api/extension-web/nope"])(
    "unknown %s is 404, not 401",
    async (path) => {
      const res = await call(app, { path });
      expect(res.status).toBe(404);
    },
  );

  test("unknown paths under /api/extension fail closed with 401", async () => {
    const res = await call(app, { path: "/api/extension/nope" });
    expect(res.status).toBe(401);
  });

  test("existing routes send no CORS headers to an extension origin", async () => {
    const res = await call(app, { method: "OPTIONS", path: "/api/profile", headers: { origin: EXT_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("pairing", () => {
  test("create returns a formatted code once and stores only its hash", async () => {
    const { code, pairing } = await createPairing();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairing).toMatchObject({
      status: "waiting",
      codeExpiresAt: new Date(NOW.getTime() + PAIRING_CODE_TTL_MS).toISOString(),
    });

    const rows = await testSql()<{ code_hash: string; token_hash: string | null }[]>`
      SELECT code_hash, token_hash FROM extension_pairings`;
    expect([...rows]).toEqual([{ code_hash: sha256Hex(code.replace("-", "")), token_hash: null }]);
  });

  test("claim binds the extension origin and returns a token stored only as a hash", async () => {
    const { code, pairing } = await createPairing();
    const res = await claim(app, code.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    const { token, pairingId } = ClaimPairingResult.parse(await res.json());
    expect(pairingId).toBe(pairing.id);

    const rows = await testSql()<{ token_hash: string; extension_origin: string }[]>`
      SELECT token_hash, extension_origin FROM extension_pairings`;
    expect([...rows]).toEqual([{ token_hash: sha256Hex(token), extension_origin: EXT_ORIGIN }]);

    const list = PairingList.parse(await (await call(app, { path: "/api/extension-web/pairings" })).json());
    expect(list.pairings).toEqual([
      {
        status: "active",
        id: pairing.id,
        createdAt: NOW.toISOString(),
        extensionOrigin: EXT_ORIGIN,
        claimedAt: NOW.toISOString(),
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  test("ping answers with the pairing and records last use", async () => {
    const { token, pairingId } = await pair();
    const later = new Date(NOW.getTime() + 60_000);
    const app2 = createApp({ ...deps, clock: { now: () => later } });
    const res = await call(app2, { path: "/api/extension/ping", headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(PingResult.parse(await res.json())).toEqual({ ok: true, pairingId });
    const [row] = await testSql()<{ last_used_at: Date }[]>`SELECT last_used_at FROM extension_pairings`;
    expect(row?.last_used_at.toISOString()).toBe(later.toISOString());
  });

  test.each([
    ["no Origin", null],
    ["a web Origin", "https://evil.example"],
    ["the app Origin", APP_ORIGIN],
    ["a malformed extension Origin", "chrome-extension://short"],
  ])("claim with %s is 403", async (_label, origin) => {
    const { code } = await createPairing();
    const res = await claim(app, code, origin);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_origin");
    // The code is still usable from the extension.
    expect((await claim(app, code)).status).toBe(200);
  });

  test("a wrong code is 401", async () => {
    await createPairing();
    const res = await claim(app, "ABCD-EFGH");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("a malformed code is 400", async () => {
    const res = await claim(app, "0000");
    expect(res.status).toBe(400);
  });

  test("a code is single use", async () => {
    const { code } = await createPairing();
    expect((await claim(app, code)).status).toBe(200);
    const again = await claim(app, code, OTHER_EXT_ORIGIN);
    expect(again.status).toBe(401);
    expect(await errorCode(again)).toBe("unauthorized");
  });

  test("a code expires after 10 minutes", async () => {
    const { code } = await createPairing();
    const late = createApp({ ...deps, clock: { now: () => new Date(NOW.getTime() + PAIRING_CODE_TTL_MS) } });
    expect((await claim(late, code)).status).toBe(401);
    const list = PairingList.parse(await (await call(late, { path: "/api/extension-web/pairings" })).json());
    expect(list.pairings.map((p) => p.status)).toEqual(["expired"]);

    const { code: fresh } = await createPairing();
    const inTime = createApp({ ...deps, clock: { now: () => new Date(NOW.getTime() + PAIRING_CODE_TTL_MS - 1000) } });
    expect((await claim(inTime, fresh)).status).toBe(200);
  });

  test("revoking an active pairing makes its token 401", async () => {
    const { token, pairingId } = await pair();
    expect((await call(app, { path: "/api/extension/ping", headers: bearer(token) })).status).toBe(200);

    const res = await call(app, {
      method: "DELETE",
      path: `/api/extension-web/pairings/${pairingId}`,
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(PairingDto.parse(await res.json())).toMatchObject({ status: "revoked", extensionOrigin: EXT_ORIGIN });

    const after = await call(app, { path: "/api/extension/ping", headers: bearer(token) });
    expect(after.status).toBe(401);
    expect(await errorCode(after)).toBe("unauthorized");
  });

  test("revoking a waiting pairing makes its code unusable", async () => {
    const { code, pairing } = await createPairing();
    const res = await call(app, {
      method: "DELETE",
      path: `/api/extension-web/pairings/${pairing.id}`,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect((await claim(app, code)).status).toBe(401);
  });

  test("revoking an unknown pairing is 404", async () => {
    const res = await call(app, {
      method: "DELETE",
      path: `/api/extension-web/pairings/${SOME_ID}`,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("codes and tokens never reach the log", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m));
    try {
      const { code } = await createPairing();
      await claim(app, code, "https://evil.example");
      const res = await claim(app, code);
      const { token } = ClaimPairingResult.parse(await res.json());
      await claim(app, code);
      await call(app, { path: "/api/extension/ping", headers: bearer(token, OTHER_EXT_ORIGIN) });
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(code.replace("-", ""));
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("CORS", () => {
  function preflight(target: ReturnType<typeof createApp>, path: string, origin: string, method = "POST") {
    return call(target, {
      method: "OPTIONS",
      path,
      headers: {
        origin,
        "access-control-request-method": method,
        "access-control-request-headers": "authorization, content-type",
      },
    });
  }

  function expectPreflightAllowed(res: Response, origin: string) {
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Origin");
  }

  test("claim preflight allows any chrome-extension origin, POST only", async () => {
    const res = await preflight(app, "/api/extension/pair/claim", OTHER_EXT_ORIGIN);
    expectPreflightAllowed(res, OTHER_EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST");
  });

  test.each(["https://evil.example", APP_ORIGIN, "null"])("claim preflight refuses %s", async (origin) => {
    const res = await preflight(app, "/api/extension/pair/claim", origin);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("bearer route preflight allows only a paired origin", async () => {
    expect((await preflight(app, "/api/extension/ping", EXT_ORIGIN, "GET")).status).toBe(403);
    await pair();
    const res = await preflight(app, "/api/extension/sessions/active", EXT_ORIGIN, "GET");
    expectPreflightAllowed(res, EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, PATCH, DELETE");

    const other = await preflight(app, "/api/extension/ping", OTHER_EXT_ORIGIN, "GET");
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a revoked pairing's origin no longer passes preflight", async () => {
    const { pairingId } = await pair();
    await call(app, {
      method: "DELETE",
      path: `/api/extension-web/pairings/${pairingId}`,
      headers: { "content-type": "application/json" },
    });
    expect((await preflight(app, "/api/extension/ping", EXT_ORIGIN, "GET")).status).toBe(403);
  });

  test("a 401 carries no CORS grant", async () => {
    const res = await call(app, { path: "/api/extension/ping", headers: { origin: EXT_ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
