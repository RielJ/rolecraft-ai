import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createChromiumPdf } from "./adapters/pdf";
import { createDb } from "./db/client";
import { migrateDb } from "./db/migrate";
import { parseEnv } from "./env";
import { createApp } from "./http/app";
import type { Deps } from "./services/context";
import { ensureUser } from "./services/profile";

// Composition root: parse env, migrate, ensure the user row, build deps, serve.
const env = parseEnv(process.env);
await migrateDb({ url: env.DATABASE_URL });
const { db, close } = createDb({ url: env.DATABASE_URL });
const userId = await ensureUser(db);
const pdf = createChromiumPdf({ executablePath: env.HB_CHROMIUM_PATH });

const deps: Deps = { db, userId, pdf, clock: { now: () => new Date() } };

const server = new Hono()
  .route("/", createApp(deps))
  .use("/*", serveStatic({ root: env.HB_STATIC_DIR }))
  // SPA fallback: any non-API path that is not a file gets index.html.
  .get("*", serveStatic({ root: env.HB_STATIC_DIR, path: "index.html" }));

const bun = Bun.serve({ port: env.PORT, fetch: server.fetch });
console.info(JSON.stringify({ level: "info", msg: "listening", url: bun.url.href }));

async function shutdown(): Promise<void> {
  await bun.stop();
  await pdf.close();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
