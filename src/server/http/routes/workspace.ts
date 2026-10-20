import { Hono } from "hono";
import { z } from "zod";
import {
  AddQuestionInput,
  ConfirmOverCapInput,
  DecideChangesInput,
  DraftInput,
  FillBlanksInput,
  MarkReviewedInput,
  OpportunityId,
  OutputId,
  UpdateOutputInput,
} from "@/shared/api";
import { AppError, type Deps } from "../../services/context";
import {
  addQuestion,
  decideChanges,
  deleteQuestion,
  draft,
  exportPdf,
  exportText,
  fillOutputBlanks,
  getWorkspace,
  markOutputCurrent,
  markReady,
  markReviewed,
  previewPdf,
  startSuggestQuestions,
  updateOutput,
} from "../../services/workspace";
import { inlineDisposition } from "../disposition";
import { validate } from "../validate";

const OpportunityParam = z.object({ id: OpportunityId });
const OutputParam = z.object({ id: OutputId });

export function workspaceRoutes(deps: Deps) {
  return (
    new Hono()
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
      .post("/opportunities/:id/draft", validate("param", OpportunityParam), validate("json", DraftInput), async (c) =>
        c.json(await draft(deps, { opportunityId: c.req.valid("param").id, ...c.req.valid("json") }), 202),
      )
      .post(
        "/opportunities/:id/suggest-questions",
        validate("param", OpportunityParam),
        validate("json", ConfirmOverCapInput),
        async (c) =>
          c.json(
            await startSuggestQuestions(deps, {
              opportunityId: c.req.valid("param").id,
              confirmOverCap: c.req.valid("json").confirmOverCap ?? false,
            }),
            202,
          ),
      )
      .post("/opportunities/:id/ready", validate("param", OpportunityParam), async (c) =>
        c.json(await markReady(deps, { opportunityId: c.req.valid("param").id })),
      )
      .patch("/outputs/:id", validate("param", OutputParam), validate("json", UpdateOutputInput), async (c) =>
        c.json(await updateOutput(deps, { outputId: c.req.valid("param").id, ...c.req.valid("json") })),
      )
      .post("/outputs/:id/fill", validate("param", OutputParam), validate("json", FillBlanksInput), async (c) =>
        c.json(await fillOutputBlanks(deps, { outputId: c.req.valid("param").id, ...c.req.valid("json") })),
      )
      .post("/outputs/:id/changes", validate("param", OutputParam), validate("json", DecideChangesInput), async (c) =>
        c.json(await decideChanges(deps, { outputId: c.req.valid("param").id, ...c.req.valid("json") })),
      )
      .post("/outputs/:id/mark-current", validate("param", OutputParam), async (c) =>
        c.json(await markOutputCurrent(deps, { outputId: c.req.valid("param").id })),
      )
      .post("/outputs/:id/reviewed", validate("param", OutputParam), validate("json", MarkReviewedInput), async (c) =>
        c.json(await markReviewed(deps, { outputId: c.req.valid("param").id, body: c.req.valid("json").body })),
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
      })
      // The preview in the file's dialog iframe: blanks show as boxes, and it is not gated. Same
      // headers as the CV file (decision 69): localGuard checks Origin only on writes, so this read
      // refuses cross-site requests itself, and no other site may embed it.
      .get("/outputs/:id/preview.pdf", validate("param", OutputParam), async (c) => {
        if (c.req.header("sec-fetch-site") === "cross-site") {
          throw new AppError({ code: "forbidden_origin", message: "Another site may not read your files." });
        }
        const { bytes, filename } = await previewPdf(deps, { outputId: c.req.valid("param").id });
        return c.body(bytes.slice().buffer, 200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": inlineDisposition(filename),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Frame-Options": "SAMEORIGIN",
        });
      })
  );
}
