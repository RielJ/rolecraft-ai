import { Hono } from "hono";
import { z } from "zod";
import { ApplicationSessionId, ConfirmAppliedInput } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { confirmApplied } from "../../../services/extension-applied";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

const SessionParam = z.object({ id: ApplicationSessionId });

/**
 * `POST /api/extension/sessions/:id/confirm-applied`, sent only after the user answers Yes.
 * Mounted behind the bearer guard in ./index.ts; `c.get("pairing")` is the caller. The success
 * reason in the body is validated but not stored.
 */
export function extensionAppliedRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>().post(
    "/sessions/:id/confirm-applied",
    validate("param", SessionParam),
    validate("json", ConfirmAppliedInput),
    async (c) => c.json(await confirmApplied(deps, { id: c.req.valid("param").id, pairingId: c.get("pairing").id })),
  );
}
