import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { z } from "zod";
import type { ApiErrorBody } from "@/shared/api";

/** zValidator with the app's error shape: 400 `{ error: { code: "invalid_input", ... } }`. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const body: ApiErrorBody = {
        error: {
          code: "invalid_input",
          message: z.prettifyError(result.error),
          details: result.error.issues,
        },
      };
      return c.json(body, 400);
    }
  });
}
