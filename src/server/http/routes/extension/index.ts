import { Hono } from "hono";
import type { Deps } from "../../../services/context";
import { bearerGuard, type ExtensionEnv, noStore, pairedPreflight } from "../../extension-guard";
import { extensionAppliedRoutes } from "./applied";
import { extensionImportRoutes } from "./import";
import { extensionMaterialRoutes } from "./materials";
import { pairClaimRoutes, pingRoutes } from "./pair";
import { extensionPreferenceRoutes } from "./preferences";
import { extensionPrefillRoutes } from "./prefill";
import { extensionSessionRoutes } from "./sessions";

/**
 * Routes the Chrome extension calls, mounted by createApp with `.route("/extension", ...)` so the
 * middleware here only ever sees /api/extension/*. Order matters:
 * 1. `noStore` wraps everything, errors and preflights included.
 * 2. `pair/claim` (and its preflight) answers before the guard: it authenticates with the code.
 * 3. The guarded tree: paired-origin preflight, then the bearer guard, then every other route.
 *    Unknown paths under /api/extension also hit the guard, so they fail closed with 401.
 * Later tasks replace their stub file (./sessions.ts, ./import.ts, ...); this file stays as is.
 */
export function extensionRoutes(deps: Deps) {
  const guarded = new Hono<ExtensionEnv>()
    .use(pairedPreflight(deps))
    .use(bearerGuard(deps))
    .route("/", pingRoutes())
    .route("/", extensionSessionRoutes(deps))
    .route("/", extensionImportRoutes(deps))
    .route("/", extensionPreferenceRoutes(deps))
    .route("/", extensionPrefillRoutes(deps))
    .route("/", extensionMaterialRoutes(deps))
    .route("/", extensionAppliedRoutes(deps));

  return new Hono().use(noStore).route("/pair", pairClaimRoutes(deps)).route("/", guarded);
}
