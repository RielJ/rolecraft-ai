import { Hono } from "hono";
import { z } from "zod";
import { AddQuestionInput, OpportunityId, OutputId, UpdateOutputInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import {
  addQuestion,
  deleteQuestion,
  exportPdf,
  exportText,
  getWorkspace,
  markReady,
  updateOutput,
} from "../../services/workspace";
import { validate } from "../validate";

const OpportunityParam = z.object({ id: OpportunityId });
const OutputParam = z.object({ id: OutputId });

export function workspaceRoutes(deps: Deps) {
  return new Hono()
    .get("/opportunities/:id", validate("param", OpportunityParam), async (c) =>
      c.json(await getWorkspace(deps, { opportunityId: c.req.valid("param").id })),
    )
    .post(
      "/opportunities/:id/questions",
      validate("param", OpportunityParam),
      validate("json", AddQuestionInput),
      async (c) =>
        c.json(await addQuestion(deps, { opportunityId: c.req.valid("param").id, ...c.req.valid("json") }), 201),
    )
    .post("/opportunities/:id/ready", validate("param", OpportunityParam), async (c) =>
      c.json(await markReady(deps, { opportunityId: c.req.valid("param").id })),
    )
    .patch("/outputs/:id", validate("param", OutputParam), validate("json", UpdateOutputInput), async (c) =>
      c.json(await updateOutput(deps, { outputId: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .delete("/outputs/:id", validate("param", OutputParam), async (c) =>
      c.json(await deleteQuestion(deps, { outputId: c.req.valid("param").id })),
    )
    .get("/outputs/:id/text", validate("param", OutputParam), async (c) =>
      c.json(await exportText(deps, { outputId: c.req.valid("param").id })),
    )
    .get("/outputs/:id/export.pdf", validate("param", OutputParam), async (c) => {
      const { bytes, filename } = await exportPdf(deps, { outputId: c.req.valid("param").id });
      return c.body(bytes.slice().buffer, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      });
    });
}
