import { Hono } from "hono";
import { AddLinkInput, PasteJobInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { addJobFromLink, addPastedJob } from "../../services/jobs";
import { listOpenJobs } from "../../services/matches";
import { validate } from "../validate";

export function jobRoutes(deps: Deps) {
  return new Hono()
    .get("/jobs", async (c) => c.json(await listOpenJobs(deps)))
    .post("/jobs/from-paste", validate("json", PasteJobInput), async (c) => {
      const result = await addPastedJob(deps, c.req.valid("json"));
      return c.json(result, result.kind === "created" ? 201 : 200);
    })
    .post("/jobs/from-link", validate("json", AddLinkInput), async (c) => {
      const result = await addJobFromLink(deps, c.req.valid("json"));
      return c.json(result, result.kind === "created" ? 201 : 200);
    });
}
