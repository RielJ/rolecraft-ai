import { Hono } from "hono";
import { z } from "zod";
import { CreatePairingInput, PairingId } from "@/shared/extension";
import { AppError, type Deps } from "../../services/context";
import { createPairing, listPairings, revokePairing } from "../../services/extension-pairing";
import { validate } from "../validate";
import { extensionWebSessionRoutes } from "./extension-web-sessions";

// Routes the SPA calls about the extension, mounted with `.route("/extension-web", ...)`. No auth,
// like the rest of the app. CSRF: localGuard (mounted first in createApp) already rejects a
// mutating request whose Origin is not the app's own, or that is `Sec-Fetch-Site: cross-site`.
// On top of that, mutations here must be `Content-Type: application/json`, which a plain HTML
// form cannot send. Reads return no code or token material.

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

const PairingParam = z.object({ id: PairingId });

export function extensionWebRoutes(deps: Deps) {
  return new Hono()
    .use(async (c, next) => {
      if (!SAFE_METHODS.has(c.req.method) && !JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) {
        throw new AppError({
          code: "forbidden_origin",
          message: "Send this request from the Hanapbuhay page, as JSON.",
        });
      }
      await next();
      c.header("Cache-Control", "no-store");
    })
    .post("/pairings", validate("json", CreatePairingInput), async (c) => c.json(await createPairing(deps), 201))
    .get("/pairings", async (c) => c.json(await listPairings(deps)))
    .delete("/pairings/:id", validate("param", PairingParam), async (c) =>
      c.json(await revokePairing(deps, { id: c.req.valid("param").id })),
    )
    .route("/", extensionWebSessionRoutes(deps));
}
