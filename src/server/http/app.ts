import { Hono } from "hono";
import type { ApiErrorBody } from "@/shared/api";
import { AppError, type Deps } from "../services/context";
import { jobRoutes } from "./routes/jobs";
import { profileRoutes } from "./routes/profile";
import { workspaceRoutes } from "./routes/workspace";

export function createApp(deps: Deps) {
  const app = new Hono()
    .basePath("/api")
    .get("/health", (c) => c.json({ ok: true }))
    .route("/", profileRoutes(deps))
    .route("/", jobRoutes(deps))
    .route("/", workspaceRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      };
      return c.json(body, err.status);
    }
    console.error(JSON.stringify({ level: "error", msg: "unhandled", path: c.req.path, error: String(err) }));
    const body: ApiErrorBody = {
      error: {
        code: "internal",
        message: "Something went wrong on the server. Try again; if it repeats, check the server log.",
      },
    };
    return c.json(body, 500);
  });
  app.notFound((c) => {
    const body: ApiErrorBody = {
      error: { code: "not_found", message: `No API route for ${c.req.method} ${c.req.path}.` },
    };
    return c.json(body, 404);
  });
  return app;
}

export type AppType = ReturnType<typeof createApp>;
