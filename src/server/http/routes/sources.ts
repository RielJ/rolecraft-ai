import { Hono } from "hono";
import { z } from "zod";
import { AddSourceInput, SourceId, UpdateSourceInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import { addCompanyBoard, deleteSource, listSources, updateSource } from "../../services/sources";
import { validate } from "../validate";

const SourceParam = z.object({ id: SourceId });

export function sourceRoutes(deps: Deps) {
  return new Hono()
    .get("/sources", async (c) => c.json(await listSources(deps)))
    .post("/sources", validate("json", AddSourceInput), async (c) =>
      c.json(await addCompanyBoard(deps, c.req.valid("json")), 201),
    )
    .patch("/sources/:id", validate("param", SourceParam), validate("json", UpdateSourceInput), async (c) =>
      c.json(await updateSource(deps, { sourceId: c.req.valid("param").id, input: c.req.valid("json") })),
    )
    .delete("/sources/:id", validate("param", SourceParam), async (c) => {
      await deleteSource(deps, { sourceId: c.req.valid("param").id });
      return c.json(await listSources(deps));
    });
}
