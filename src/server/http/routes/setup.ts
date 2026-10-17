import { Hono } from "hono";
import type { Deps } from "../../services/context";
import { checkHealth } from "../../services/health";
import { getSetup } from "../../services/setup";

export function setupRoutes(deps: Deps) {
  return new Hono()
    .get("/health", async (c) => {
      const health = await checkHealth(deps);
      return c.json(health, health.ok ? 200 : 503);
    })
    .get("/setup", async (c) => c.json(await getSetup(deps)));
}
