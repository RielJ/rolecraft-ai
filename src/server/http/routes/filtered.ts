import { Hono } from "hono";
import { FilteredQuery, OverrideInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { listFiltered, overrideEligibility } from "../../services/filtered";
import { validate } from "../validate";

/** The Board's "Filtered out" section (decision 53). */
export function filteredRoutes(deps: Deps) {
  return new Hono()
    .get("/filtered", validate("query", FilteredQuery), async (c) =>
      c.json(await listFiltered(deps, c.req.valid("query"))),
    )
    .post("/filtered/overrides", validate("json", OverrideInput), async (c) =>
      c.json(await overrideEligibility(deps, c.req.valid("json"))),
    );
}
