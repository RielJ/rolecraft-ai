import { Hono } from "hono";
import { z } from "zod";
import {
  AddLinkInput,
  DismissInput,
  JobId,
  MergeInput,
  type MergeResult,
  PasteJobInput,
  type SavedJob,
  UndoInput,
} from "@/shared/api";
import type { Deps } from "../../services/context";
import { addJobFromLink, addPastedJob, dismissJob, mergeJob, saveJob, undoJob } from "../../services/jobs";
import { validate } from "../validate";

const JobParam = z.object({ id: JobId });

export function jobRoutes(deps: Deps) {
  return new Hono()
    .post("/jobs/from-paste", validate("json", PasteJobInput), async (c) => {
      const result = await addPastedJob(deps, c.req.valid("json"));
      return c.json(result, result.kind === "created" ? 201 : 200);
    })
    .post("/jobs/from-link", validate("json", AddLinkInput), async (c) => {
      const result = await addJobFromLink(deps, c.req.valid("json"));
      return c.json(result, result.kind === "created" ? 201 : 200);
    })
    .post("/jobs/:id/save", validate("param", JobParam), async (c) => {
      const saved: SavedJob = await saveJob(deps, c.req.valid("param").id);
      return c.json(saved);
    })
    .post("/jobs/:id/dismiss", validate("param", JobParam), validate("json", DismissInput), async (c) => {
      await dismissJob(deps, { jobId: c.req.valid("param").id, reason: c.req.valid("json").reason });
      return c.json({ ok: true });
    })
    .post("/jobs/:id/undo", validate("param", JobParam), validate("json", UndoInput), async (c) => {
      await undoJob(deps, { jobId: c.req.valid("param").id, action: c.req.valid("json").action });
      return c.json({ ok: true });
    })
    .post("/jobs/:id/merge", validate("param", JobParam), validate("json", MergeInput), async (c) => {
      const merged: MergeResult = await mergeJob(deps, {
        jobId: c.req.valid("param").id,
        into: c.req.valid("json").into,
      });
      return c.json(merged);
    });
}
