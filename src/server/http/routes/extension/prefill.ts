import { Hono } from "hono";
import { z } from "zod";
import { ApplicationSessionId, PrefillRequest } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { prefillSession } from "../../../services/extension-prefill";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

const SessionParam = z.object({ id: ApplicationSessionId });

/**
 * `POST /api/extension/sessions/:id/prefill`: up to MAX_PREFILL_FIELDS field descriptors in, a
 * PrefillResponse out. Mounted behind the bearer guard in ./index.ts; the session must be claimed
 * by the calling pairing.
 */
export function extensionPrefillRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>().post(
    "/sessions/:id/prefill",
    validate("param", SessionParam),
    validate("json", PrefillRequest),
    async (c) =>
      c.json(
        await prefillSession(deps, {
          sessionId: c.req.valid("param").id,
          pairingId: c.get("pairing").id,
          request: c.req.valid("json"),
        }),
      ),
  );
}
