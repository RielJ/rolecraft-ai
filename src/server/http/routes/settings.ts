import { Hono } from "hono";
import { SaveAiKeyInput, UpdateSettingsInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { fillRates } from "../../services/rates";
import { getSettings, removeAiKey, saveAiKey, updateSettings } from "../../services/settings";
import { validate } from "../validate";

export function settingsRoutes(deps: Deps) {
  return (
    new Hono()
      .get("/settings", async (c) => c.json(await getSettings(deps)))
      .patch("/settings", validate("json", UpdateSettingsInput), async (c) =>
        c.json(await updateSettings(deps, c.req.valid("json"))),
      )
      .put("/settings/ai-key", validate("json", SaveAiKeyInput), async (c) =>
        c.json(await saveAiKey(deps, c.req.valid("json"))),
      )
      .delete("/settings/ai-key", async (c) => c.json(await removeAiKey(deps)))
      // Fill rates (decision 67): fetch every rate the user did not type, now, whatever the Refresh gate says.
      .post("/settings/rates/fill", async (c) => {
        const fill = await fillRates(deps);
        return c.json({ settings: await getSettings(deps), fill });
      })
  );
}
