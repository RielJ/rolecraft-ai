import { Hono } from "hono";
import { z } from "zod";
import { DraftInput, MarkReviewedInput, OutputId, TaskId, UpdateOutputInput } from "@/shared/api";
import { ApplicationSessionId } from "@/shared/extension";
import type { Deps } from "../../../services/context";
import {
  draftForSession,
  editSessionOutput,
  extensionTask,
  reviewSessionOutput,
  sessionOutputPdf,
  sessionOutputs,
} from "../../../services/extension-prefill";
import type { ExtensionEnv } from "../../extension-guard";
import { validate } from "../../validate";

const SessionParam = z.object({ id: ApplicationSessionId });
const SessionOutputParam = z.object({ id: ApplicationSessionId, outputId: OutputId });
const TaskParam = z.object({ id: TaskId });

/**
 * The panel's materials, all scoped to a session the calling pairing has claimed:
 * - `GET sessions/:id/outputs`: ExtensionOutputList (no bodies).
 * - `PATCH sessions/:id/outputs/:outputId`: UpdateOutputInput in, ExtensionOutputDto out.
 * - `POST sessions/:id/outputs/:outputId/reviewed`: MarkReviewedInput in (the text the panel showed),
 *   ExtensionOutputDto out; 409 `output_changed` when the stored body no longer reads that way.
 * - `GET sessions/:id/outputs/:outputId/pdf`: resume or letter as application/pdf.
 * - `POST sessions/:id/draft`: DraftInput in, TaskDto (202) out.
 * - `GET tasks/:id`: TaskDto of a draft for a job this pairing holds a session for.
 * Mounted behind the bearer guard in ./index.ts, which also sets `Cache-Control: no-store`.
 */
export function extensionMaterialRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>()
    .get("/sessions/:id/outputs", validate("param", SessionParam), async (c) =>
      c.json(await sessionOutputs(deps, { sessionId: c.req.valid("param").id, pairingId: c.get("pairing").id })),
    )
    .patch(
      "/sessions/:id/outputs/:outputId",
      validate("param", SessionOutputParam),
      validate("json", UpdateOutputInput),
      async (c) => {
        const { id, outputId } = c.req.valid("param");
        return c.json(
          await editSessionOutput(deps, {
            sessionId: id,
            pairingId: c.get("pairing").id,
            outputId,
            input: c.req.valid("json"),
          }),
        );
      },
    )
    .post(
      "/sessions/:id/outputs/:outputId/reviewed",
      validate("param", SessionOutputParam),
      validate("json", MarkReviewedInput),
      async (c) => {
        const { id, outputId } = c.req.valid("param");
        return c.json(
          await reviewSessionOutput(deps, {
            sessionId: id,
            pairingId: c.get("pairing").id,
            outputId,
            input: c.req.valid("json"),
          }),
        );
      },
    )
    .get("/sessions/:id/outputs/:outputId/pdf", validate("param", SessionOutputParam), async (c) => {
      const { id, outputId } = c.req.valid("param");
      const { bytes, filename } = await sessionOutputPdf(deps, {
        sessionId: id,
        pairingId: c.get("pairing").id,
        outputId,
      });
      return c.body(bytes.slice().buffer, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      });
    })
    .post("/sessions/:id/draft", validate("param", SessionParam), validate("json", DraftInput), async (c) =>
      c.json(
        await draftForSession(deps, {
          sessionId: c.req.valid("param").id,
          pairingId: c.get("pairing").id,
          input: c.req.valid("json"),
        }),
        202,
      ),
    )
    .get("/tasks/:id", validate("param", TaskParam), async (c) =>
      c.json(await extensionTask(deps, { taskId: c.req.valid("param").id, pairingId: c.get("pairing").id })),
    );
}
