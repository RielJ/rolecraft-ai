import { Hono } from "hono";
import { z } from "zod";
import { ApplicationSessionId, ClaimSessionInput } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { activeSession, claimSession } from "../../../services/extension-sessions";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

const SessionParam = z.object({ id: ApplicationSessionId });

/**
 * `GET /api/extension/sessions/active` and `POST /api/extension/sessions/:id/claim`. Mounted
 * behind the bearer guard in ./index.ts; `c.get("pairing")` is the caller.
 */
export function extensionSessionRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>()
    .get("/sessions/active", async (c) => c.json(await activeSession(deps)))
    .post("/sessions/:id/claim", validate("param", SessionParam), validate("json", ClaimSessionInput), async (c) =>
      c.json(
        await claimSession(deps, {
          id: c.req.valid("param").id,
          pairing: c.get("pairing"),
          input: c.req.valid("json"),
        }),
      ),
    );
}
