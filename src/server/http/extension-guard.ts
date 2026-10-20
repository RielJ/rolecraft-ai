import type { Context, MiddlewareHandler } from "hono";
import { ExtensionOrigin, PairingToken } from "@/shared/extension";
import { AppError, type Deps } from "../services/context";
import { type AuthedPairing, authenticatePairing, isPairedOrigin } from "../services/extension-pairing";

// Auth and CORS for /api/extension/* (docs/EXTENSION.md). Everything
// here is mounted inside the router at `.route("/extension", ...)`, so none of it reaches other
// /api routes. localGuard skips its Origin rules for this prefix; these take over:
// - pair/claim: the request Origin must be a chrome-extension:// origin; it is bound on claim.
// - every other route: `Authorization: Bearer <token>` (401), and an Origin, if present, must
//   be the paired extension's (403).
// CORS: only an extension origin is ever echoed back, never `*`, never with credentials.

/** Hono env for guarded extension routes: `c.get("pairing")` is the caller's pairing. */
export type ExtensionEnv = { Variables: { pairing: AuthedPairing } };

/** Hono env for the claim route: the validated Origin to bind. */
export type ClaimEnv = { Variables: { extensionOrigin: ExtensionOrigin } };

const ALLOW_HEADERS = "Authorization, Content-Type";
const GUARDED_METHODS = "GET, POST, PUT, PATCH, DELETE";
const CLAIM_METHODS = "POST";
const PREFLIGHT_MAX_AGE = "600";

function forbiddenOrigin(message: string): AppError {
  return new AppError({ code: "forbidden_origin", message });
}

function extensionOriginOf(c: Context): ExtensionOrigin | null {
  const parsed = ExtensionOrigin.safeParse(c.req.header("origin"));
  return parsed.success ? parsed.data : null;
}

function preflight(c: Context, { origin, methods }: { origin: ExtensionOrigin; methods: string }): Response {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Methods", methods);
  c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
  c.header("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
  return c.body(null, 204);
}

/** First on the extension router: every answer, errors included, is `no-store` and varies by Origin. */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Origin", { append: true });
};

/** `OPTIONS pair/claim`: any well-formed chrome-extension:// origin may ask to claim. */
export const claimPreflight: MiddlewareHandler = async (c) => {
  const origin = extensionOriginOf(c);
  if (origin === null) throw forbiddenOrigin("Only the Hanapbuhay extension can claim a pairing code.");
  return preflight(c, { origin, methods: CLAIM_METHODS });
};

/** `POST pair/claim`: requires a chrome-extension:// Origin, exposes it to the handler, grants CORS to it. */
export const claimOrigin: MiddlewareHandler<ClaimEnv> = async (c, next) => {
  const origin = extensionOriginOf(c);
  if (origin === null) throw forbiddenOrigin("Only the Hanapbuhay extension can claim a pairing code.");
  c.set("extensionOrigin", origin);
  await next();
  c.header("Access-Control-Allow-Origin", origin);
};

/** Preflight for guarded routes. Preflights carry no token, so the origin must belong to an active pairing. */
export function pairedPreflight(deps: Pick<Deps, "db" | "userId">): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "OPTIONS") return next();
    const origin = extensionOriginOf(c);
    if (origin === null || !(await isPairedOrigin(deps, { origin }))) {
      throw forbiddenOrigin("This extension is not paired with Hanapbuhay.");
    }
    return preflight(c, { origin, methods: GUARDED_METHODS });
  };
}

/** Bearer token check. Sets `pairing` and grants CORS to the paired origin when the request sent it. */
export function bearerGuard(deps: Pick<Deps, "db" | "userId" | "clock">): MiddlewareHandler<ExtensionEnv> {
  return async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    const token = PairingToken.safeParse(match?.[1]);
    if (!token.success) {
      throw new AppError({ code: "unauthorized", message: "Pair the extension with Hanapbuhay first." });
    }
    const origin = c.req.header("origin");
    const pairing = await authenticatePairing(deps, { token: token.data, origin });
    c.set("pairing", pairing);
    await next();
    if (origin !== undefined) c.header("Access-Control-Allow-Origin", pairing.extensionOrigin);
  };
}
