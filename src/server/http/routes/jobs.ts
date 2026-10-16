import { Hono } from "hono";
import { PasteJobInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { addPastedJob } from "../../services/jobs";
import { validate } from "../validate";

export function jobRoutes(deps: Deps) {
  return new Hono().post("/jobs/from-paste", validate("json", PasteJobInput), async (c) => {
    const result = await addPastedJob(deps, c.req.valid("json"));
    return c.json(result, result.kind === "created" ? 201 : 200);
  });
}
