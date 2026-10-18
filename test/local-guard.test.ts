import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createFakeAi } from "@/server/adapters/ai/fake";
import { createPublicReader } from "@/server/adapters/github";
import { createHttpClient } from "@/server/adapters/http";
import { createFileKeyStore } from "@/server/adapters/key-store";
import { createChromiumPdf } from "@/server/adapters/pdf";
import { createSourceAdapters } from "@/server/adapters/sources";
import { createDb } from "@/server/db/client";
import { parseEnv } from "@/server/env";
import { createApp } from "@/server/http/app";
import { localGuard } from "@/server/http/local-guard";
import type { Deps } from "@/server/services/context";
import { ApiErrorBody, UserId } from "@/shared/api";

// The guard in isolation on a tiny app shaped like createApp (basePath /api), so no database.
function tinyApp(allowedHosts: readonly string[] = []) {
  return new Hono()
    .basePath("/api")
    .use(localGuard({ allowedHosts }))
    .all("*", (c) => c.json({ ok: true }));
}

type Call = { method?: string; path?: string; headers?: Record<string, string> };

function call(app: ReturnType<typeof tinyApp>, { method = "GET", path = "/api/profile", headers = {} }: Call) {
  return app.request(path, { method, headers });
}

async function expectForbidden(res: Response) {
  expect(res.status).toBe(403);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.code).toBe("forbidden_origin");
}

describe("Host check (DNS rebinding)", () => {
  const app = tinyApp(["hb.internal"]);

  test.each([
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:5173",
    "[::1]",
    "[::1]:3000",
    "LOCALHOST:3000",
    "hb.internal",
    "hb.internal:8080",
  ])("allows Host %s", async (host) => {
    const res = await call(app, { headers: { host } });
    expect(res.status).toBe(200);
  });

  test("allows a request without a Host header (app.request in tests)", async () => {
    const res = await call(app, {});
    expect(res.status).toBe(200);
  });

  test.each([
    "192.168.1.20:3000",
    "10.0.0.5",
    "0.0.0.0:3000",
    "attacker.example:3000",
    "localhost.attacker.example",
    "127.0.0.1.nip.io:3000",
    "localhost:abc",
    "[::1]x",
    "[::2]:3000",
    "",
  ])("rejects Host %p", async (host) => {
    await expectForbidden(await call(app, { headers: { host } }));
  });

  test("rejects a rebinding host on GET too", async () => {
    await expectForbidden(await call(app, { method: "GET", headers: { host: "rebind.attacker.example:3000" } }));
  });

  test("keeps the Host check on /api/extension/*", async () => {
    await expectForbidden(
      await call(app, { method: "POST", path: "/api/extension/pair/claim", headers: { host: "192.168.1.20:3000" } }),
    );
  });

  test("an empty allow list allows only loopback", async () => {
    await expectForbidden(await call(tinyApp(), { headers: { host: "hb.internal" } }));
  });
});

describe("HB_HOST and HB_ALLOWED_HOSTS", () => {
  test("default to loopback only", () => {
    const env = parseEnv({});
    expect(env.HB_HOST).toBe("127.0.0.1");
    expect(env.HB_ALLOWED_HOSTS).toEqual([]);
  });

  test("HB_ALLOWED_HOSTS is a comma list, trimmed and lowercased", () => {
    const env = parseEnv({ HB_HOST: "0.0.0.0", HB_ALLOWED_HOSTS: " HB.Internal , my-box.local,,[fd00::1]" });
    expect(env.HB_HOST).toBe("0.0.0.0");
    expect(env.HB_ALLOWED_HOSTS).toEqual(["hb.internal", "my-box.local", "[fd00::1]"]);
  });

  test.each(["hb.internal:3000", "http://hb.internal", "hb.internal/x", "*"])(
    "HB_ALLOWED_HOSTS refuses %s",
    (value) => {
      expect(() => parseEnv({ HB_ALLOWED_HOSTS: value })).toThrow(/HB_ALLOWED_HOSTS/);
    },
  );
});

describe("Origin check (CSRF) on mutating /api requests", () => {
  const app = tinyApp(["hb.internal"]);
  const host = "localhost:3000";

  test.each(["POST", "PUT", "PATCH", "DELETE"])("%s with a foreign Origin is rejected", async (method) => {
    await expectForbidden(await call(app, { method, headers: { host, origin: "https://evil.example" } }));
  });

  test.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "null",
    "http://localhost:3000.evil.example",
    "chrome-extension://abcdefghijklmnop",
  ])("POST with Origin %s on Host localhost:3000 is rejected", async (origin) => {
    await expectForbidden(await call(app, { method: "POST", headers: { host, origin } }));
  });

  test("POST with Sec-Fetch-Site: cross-site is rejected even without Origin", async () => {
    await expectForbidden(await call(app, { method: "POST", headers: { host, "sec-fetch-site": "cross-site" } }));
  });

  test.each(["http://localhost:3000", "https://localhost:3000", "HTTP://LOCALHOST:3000"])(
    "same-origin POST with Origin %s is allowed",
    async (origin) => {
      const res = await call(app, { method: "POST", headers: { host, origin, "sec-fetch-site": "same-origin" } });
      expect(res.status).toBe(200);
    },
  );

  test("same-origin POST through an allowed host is allowed", async () => {
    const res = await call(app, {
      method: "POST",
      headers: { host: "hb.internal:8080", origin: "http://hb.internal:8080" },
    });
    expect(res.status).toBe(200);
  });

  test("POST with no Origin (curl, tests) is allowed", async () => {
    const res = await call(app, { method: "POST", headers: { host } });
    expect(res.status).toBe(200);
  });

  test("POST from app.request with no headers at all is allowed", async () => {
    const res = await call(app, { method: "POST" });
    expect(res.status).toBe(200);
  });

  test.each(["GET", "HEAD", "OPTIONS"])("%s with a foreign Origin and cross-site is allowed", async (method) => {
    const res = await call(app, {
      method,
      headers: { host, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
  });

  test.each(["/api/extension/pair/claim", "/api/extension/sessions/active"])(
    "skips Origin rules on %s (owned by the extension guard)",
    async (path) => {
      const res = await call(app, {
        method: "POST",
        path,
        headers: { host, origin: "chrome-extension://abcdefghijklmnop", "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(200);
    },
  );

  test.each([
    "/api/extension-web/pairings",
    "/api/extensionx",
    "/api/extension/../profile",
    "/api/extension/%2e%2e/profile",
  ])("does not skip Origin rules on %s", async (path) => {
    await expectForbidden(await call(app, { method: "POST", path, headers: { host, origin: "https://evil.example" } }));
  });
});

describe("createApp mounts the guard first", () => {
  // Deps that never reach a database: the Postgres client connects lazily, and every request
  // here is answered by the guard or by notFound before any service runs.
  const { db, close } = createDb({ url: "postgres://nobody:nobody@127.0.0.1:1/unreachable", max: 1 });
  const http = createHttpClient({
    fetch: async () => {
      throw new TypeError("Network access is disabled in tests.");
    },
    sleep: async () => {},
  });
  const fake = createFakeAi();
  const pdf = createChromiumPdf({});
  const deps: Deps = {
    db,
    userId: UserId.parse("00000000-0000-4000-8000-000000000000"),
    pdf,
    ai: { anthropic: fake, openai: fake },
    aiSource: { kind: "key" },
    keyStore: createFileKeyStore({ dir: tmpdir() }),
    http,
    sources: createSourceAdapters(http),
    github: createPublicReader({ http, user: null }),
    clock: { now: () => new Date("2026-10-18T00:00:00Z") },
  };
  const app = createApp(deps, { allowedHosts: ["hb.internal"] });
  afterAll(async () => {
    await pdf.close();
    await close();
  });

  test("a LAN Host gets 403 forbidden_origin", async () => {
    await expectForbidden(await app.request("/api/profile", { headers: { host: "192.168.1.20:3000" } }));
  });

  test("a foreign-Origin POST gets 403 forbidden_origin", async () => {
    await expectForbidden(
      await app.request("/api/profile/text", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
  });

  test("an allowed host passes the guard (unknown route answers 404, not 403)", async () => {
    const res = await app.request("/api/no-such-route", { headers: { host: "hb.internal:3000" } });
    expect(res.status).toBe(404);
  });

  test("createApp without options allows only loopback", async () => {
    const plain = createApp(deps);
    await expectForbidden(await plain.request("/api/no-such-route", { headers: { host: "hb.internal:3000" } }));
    expect((await plain.request("/api/no-such-route")).status).toBe(404);
  });
});
