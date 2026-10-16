import { Hono } from "hono";
import { z } from "zod";
import { ConfirmOverCapInput, TaskId } from "@/shared/api";
import type { Deps } from "../../services/context";
import { retrySplit } from "../../services/profile";
import { getTask, retryTask } from "../../services/tasks";
import { retryDraft } from "../../services/workspace";
import { validate } from "../validate";

const TaskParam = z.object({ id: TaskId });

export function taskRoutes(deps: Deps) {
  return new Hono()
    .get("/tasks/:id", validate("param", TaskParam), async (c) =>
      c.json(await getTask(deps, { taskId: c.req.valid("param").id })),
    )
    .post("/tasks/:id/retry", validate("param", TaskParam), validate("json", ConfirmOverCapInput), async (c) =>
      c.json(
        await retryTask(deps, {
          taskId: c.req.valid("param").id,
          confirmOverCap: c.req.valid("json").confirmOverCap ?? false,
          handlers: {
            draft: (input, options) => retryDraft(deps, input, options),
            split: (input, options) => retrySplit(deps, input, options),
          },
        }),
        202,
      ),
    );
}
