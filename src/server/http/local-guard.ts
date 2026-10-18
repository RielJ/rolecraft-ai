import type { Context, MiddlewareHandler } from "hono";
import type { ApiErrorBody } from "@/shared/api";
import { AppError } from "../services/context";

// Local server hardening (docs/plans/chrome-extension.md, Task 0). The app has no login, so any
// web page the user visits could otherwise talk to it:
// - Host check: a DNS-rebinding page reaches 127.0.0.1 under its own name, and the browser then
//   sends that name as Host. Only loopback names (any port) and HB_ALLOWED_HOSTS pass.
// - Origin check (CSRF): a foreign page can still POST to http://localhost. Mutating /api calls
//   must come from the page's own origin, or carry no Origin at all (curl, tests).
// /api/extension/* keeps the Host check; its origin rules belong to the extension guard.

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const EXTENSION_PREFIX = "/api/extension";

/** `name[:port]` or `[v6][:port]`, lowercased. The hostname part, or null when the value is malformed. */
function hostnameOf(host: string): string | null {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host.toLowerCase());
  return match?.[1] ?? null;
}

function isExtensionPath(path: string): boolean {
  return path === EXTENSION_PREFIX || path.startsWith(`${EXTENSION_PREFIX}/`);
}

function forbidden(c: Context, message: string): Response {
  const err = new AppError({ code: "forbidden_origin", message });
  const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
  return c.json(body, err.status);
}

/**
 * Mount first on the `/api` app. `allowedHosts` are extra hostnames (no port; any port passes),
 * from HB_ALLOWED_HOSTS, for reaching the app under a name other than localhost.
 */
export function localGuard({ allowedHosts }: { allowedHosts: readonly string[] }): MiddlewareHandler {
  const allowed: ReadonlySet<string> = new Set([...LOOPBACK_HOSTNAMES, ...allowedHosts.map((h) => h.toLowerCase())]);

  return async (c, next) => {
    // Bun.serve builds the URL from Host, so the header and URL agree in production. A Request built
    // in a test (app.request) has no Host header; its URL host (localhost) stands in.
    const host = c.req.header("host") ?? URL.parse(c.req.url)?.host ?? "";
    const hostname = hostnameOf(host);
    if (hostname === null || !allowed.has(hostname)) {
      return forbidden(c, "This server only answers on localhost. Set HB_ALLOWED_HOSTS to reach it by another name.");
    }

    if (!SAFE_METHODS.has(c.req.method) && !isExtensionPath(c.req.path)) {
      if (c.req.header("sec-fetch-site") === "cross-site") {
        return forbidden(c, "Cross-site requests may not change data.");
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const own = origin.toLowerCase();
        const expected = host.toLowerCase();
        if (own !== `http://${expected}` && own !== `https://${expected}`) {
          return forbidden(c, "Requests that change data must come from this app's own page.");
        }
      }
    }

    await next();
  };
}
