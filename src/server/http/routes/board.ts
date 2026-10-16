import { Hono } from "hono";
import { z } from "zod";
import { ChangeStatusInput, OpportunityId, UpdateOpportunityInput } from "@/shared/api";
import { changeStatus, listBoard, updateOpportunity } from "../../services/board";
import type { Deps } from "../../services/context";
import { validate } from "../validate";

const OpportunityParam = z.object({ id: OpportunityId });

export function boardRoutes(deps: Deps) {
  return new Hono()
    .get("/board", async (c) => c.json(await listBoard(deps)))
    .post(
      "/opportunities/:id/status",
      validate("param", OpportunityParam),
      validate("json", ChangeStatusInput),
      async (c) => c.json(await changeStatus(deps, { opportunityId: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .patch(
      "/opportunities/:id",
      validate("param", OpportunityParam),
      validate("json", UpdateOpportunityInput),
      async (c) =>
        c.json(await updateOpportunity(deps, { opportunityId: c.req.valid("param").id, ...c.req.valid("json") })),
    );
}
