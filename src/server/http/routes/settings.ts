import { Hono } from "hono";
import { SaveAiKeyInput, UpdateSettingsInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { getSettings, removeAiKey, saveAiKey, updateSettings } from "../../services/settings";
import { validate } from "../validate";

export function settingsRoutes(deps: Deps) {
  return new Hono()
    .get("/settings", async (c) => c.json(await getSettings(deps)))
    .patch("/settings", validate("json", UpdateSettingsInput), async (c) =>
      c.json(await updateSettings(deps, c.req.valid("json"))),
    )
    .put("/settings/ai-key", validate("json", SaveAiKeyInput), async (c) =>
      c.json(await saveAiKey(deps, c.req.valid("json"))),
    )
    .delete("/settings/ai-key", async (c) => c.json(await removeAiKey(deps)));
}
