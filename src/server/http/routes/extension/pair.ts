import { Hono } from "hono";
import { ClaimPairingInput, type PingResult } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { claimPairing } from "../../../services/extension-pairing";
import { type ClaimEnv, claimOrigin, claimPreflight, type ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

/** `POST /api/extension/pair/claim` and its preflight. Mounted at `/pair`, outside the bearer guard. */
export function pairClaimRoutes(deps: Deps) {
  return new Hono<ClaimEnv>()
    .options("/claim", claimPreflight)
    .post("/claim", claimOrigin, validate("json", ClaimPairingInput), async (c) =>
      c.json(await claimPairing(deps, { code: c.req.valid("json").code, extensionOrigin: c.get("extensionOrigin") })),
    );
}

/** `GET /api/extension/ping`: the extension checks its pairing still works. Behind the bearer guard. */
export function pingRoutes() {
  return new Hono<ExtensionEnv>().get("/ping", (c) =>
    c.json({ ok: true, pairingId: c.get("pairing").id } satisfies PingResult),
  );
}
