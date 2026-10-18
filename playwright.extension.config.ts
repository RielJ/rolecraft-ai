import { defineConfig } from "@playwright/test";
import { EXTENSION_E2E_PORT, serverEnv } from "./e2e-extension/server-env";

// The extension end-to-end run (docs/EXTENSION.md, "Run the end-to-end test"). The built
// extension loads into a persistent Chromium context (e2e-extension/fixtures.ts) against the real
// server on its own port and the same e2e database as playwright.config.ts. The port differs from
// `bun run e2e`, so the two runs never share a server.
export default defineConfig({
  testDir: "./e2e-extension",
  // Not *.spec.ts: `bun test` would pick that up (bunfig.toml ignores e2e/ only).
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${EXTENSION_E2E_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun src/server/main.ts",
    url: `http://localhost:${EXTENSION_E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: serverEnv(EXTENSION_E2E_PORT),
    stdout: "pipe",
    stderr: "pipe",
  },
});
