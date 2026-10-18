import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_DATABASE_URL, E2E_GITHUB_DIR, E2E_SOURCES_LOG } from "../playwright.config";

/** The webServer port for `bun run e2e:extension`. `bun run e2e` uses 3100. */
export const EXTENSION_E2E_PORT = Number(process.env.HB_E2E_EXTENSION_PORT ?? 3110);

/** A second server the "server stopped" test starts and kills itself. */
export const STOPPABLE_SERVER_PORT = EXTENSION_E2E_PORT + 1;

/**
 * Environment for a server under test: the e2e database, fake AI, fixture sources and GitHub, as
 * in playwright.config.ts. Both the config's webServer and the stoppable server use it.
 */
export function serverEnv(port: number): Record<string, string> {
  return {
    PORT: String(port),
    DATABASE_URL: E2E_DATABASE_URL,
    HB_STATIC_DIR: "./dist",
    HB_AI: "fake",
    HB_SOURCES: "fixture",
    HB_SOURCES_LOG: E2E_SOURCES_LOG,
    HB_GITHUB: "fixture",
    HB_GITHUB_DIR: E2E_GITHUB_DIR,
    HB_DATA_DIR: join(tmpdir(), "hanapbuhay-e2e-extension-data"),
  };
}
