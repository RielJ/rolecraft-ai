import { Hono } from "hono";
import { ImportJobInput, LookupQuery } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { importJob, lookupByUrl } from "../../../services/extension-import";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

/**
 * `GET /api/extension/opportunities/by-url?url=` (read-only) and `POST /api/extension/import`.
 * Mounted behind the bearer guard in ./index.ts. Non-http(s) URLs fail validation with 400.
 */
export function extensionImportRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>()
    .get("/opportunities/by-url", validate("query", LookupQuery), async (c) =>
      c.json(await lookupByUrl(deps, c.req.valid("query"))),
    )
    .post("/import", validate("json", ImportJobInput), async (c) => {
      const result = await importJob(deps, c.req.valid("json"));
      return c.json(result, result.kind === "created" ? 201 : 200);
    });
}
