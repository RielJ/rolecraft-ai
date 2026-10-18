import { Hono } from "hono";
import { z } from "zod";
import { PreferenceId, PreferenceInput } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import { deletePreference, listPreferences, savePreference } from "../../../services/extension-preferences";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

const PreferenceParam = z.object({ id: PreferenceId });

/**
 * `GET /api/extension/preferences` (PreferenceList), `PUT /api/extension/preferences`
 * (PreferenceDto, upsert by category and scope) and `DELETE /api/extension/preferences/:id`
 * (what is left, as a PreferenceList). Mounted behind the bearer guard in ./index.ts.
 */
export function extensionPreferenceRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>()
    .get("/preferences", async (c) => c.json(await listPreferences(deps)))
    .put("/preferences", validate("json", PreferenceInput), async (c) =>
      c.json(await savePreference(deps, c.req.valid("json"))),
    )
    .delete("/preferences/:id", validate("param", PreferenceParam), async (c) =>
      c.json(await deletePreference(deps, { id: c.req.valid("param").id })),
    );
}
