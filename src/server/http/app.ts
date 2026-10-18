import { Hono } from "hono";
import type { ApiErrorBody } from "@/shared/api";
import { AppError, type Deps } from "../services/context";
import { localGuard } from "./local-guard";
import { boardRoutes } from "./routes/board";
import { extensionRoutes } from "./routes/extension";
import { extensionWebRoutes } from "./routes/extension-web";
import { filteredRoutes } from "./routes/filtered";
import { jobRoutes } from "./routes/jobs";
import { matchRoutes } from "./routes/matches";
import { profileRoutes } from "./routes/profile";
import { settingsRoutes } from "./routes/settings";
import { setupRoutes } from "./routes/setup";
import { sourceRoutes } from "./routes/sources";
import { taskRoutes } from "./routes/tasks";
import { workspaceRoutes } from "./routes/workspace";

/** `allowedHosts`: HB_ALLOWED_HOSTS. Tests omit it; app.request sends Host localhost, which passes. */
export function createApp(deps: Deps, { allowedHosts = [] }: { allowedHosts?: readonly string[] } = {}) {
  const app = new Hono()
    .basePath("/api")
    // First, so it runs before every route (Host check, and Origin check on mutating calls).
    .use(localGuard({ allowedHosts }))
    .route("/", setupRoutes(deps))
    .route("/", profileRoutes(deps))
    .route("/", jobRoutes(deps))
    .route("/", matchRoutes(deps))
    .route("/", boardRoutes(deps))
    .route("/", filteredRoutes(deps))
    .route("/", workspaceRoutes(deps))
    .route("/", settingsRoutes(deps))
    .route("/", sourceRoutes(deps))
    .route("/", taskRoutes(deps))
    // Prefixed mounts, so their middleware (JSON check; bearer guard and CORS) stays inside them.
    .route("/extension-web", extensionWebRoutes(deps))
    .route("/extension", extensionRoutes(deps));

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
