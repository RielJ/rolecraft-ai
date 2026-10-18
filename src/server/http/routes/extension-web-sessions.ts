import { Hono } from "hono";
import { CreateSessionInput } from "@/shared/extension";
import type { Deps } from "../../services/context";
import { createSession } from "../../services/extension-sessions";
import { validate } from "../validate";

/**
 * `POST /api/extension-web/sessions`: the workspace Apply button. Mounted inside
 * ./extension-web.ts, whose middleware already rejects non-JSON mutations (403) and sets
 * `Cache-Control: no-store`; localGuard rejects a foreign Origin before that.
 */
export function extensionWebSessionRoutes(deps: Deps) {
  return new Hono().post("/sessions", validate("json", CreateSessionInput), async (c) =>
    c.json(await createSession(deps, { opportunityId: c.req.valid("json").opportunityId }), 201),
  );
}
