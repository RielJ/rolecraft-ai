import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createAnthropicClient } from "./adapters/ai/anthropic";
import { createFakeAi } from "./adapters/ai/fake";
import { createOpenAiClient } from "./adapters/ai/openai";
import type { AiClients } from "./adapters/ai/types";
import { createHttpClient } from "./adapters/http";
import { createFileKeyStore } from "./adapters/key-store";
import { createChromiumPdf } from "./adapters/pdf";
import { createDb } from "./db/client";
import { migrateDb } from "./db/migrate";
import { parseEnv } from "./env";
import { createApp } from "./http/app";
import type { Deps } from "./services/context";
import { ensureUser } from "./services/profile";
import { markInterrupted } from "./services/tasks";

// Composition root: parse env, migrate, ensure the user row, build deps, serve.
const env = parseEnv(process.env);
await migrateDb({ url: env.DATABASE_URL });
const { db, close } = createDb({ url: env.DATABASE_URL });
const userId = await ensureUser(db);
// Tasks run in this process, so any still `running` died with the last one (decision 36).
const interrupted = await markInterrupted(db);
if (interrupted > 0) console.info(JSON.stringify({ level: "info", msg: "tasks interrupted", count: interrupted }));
const pdf = createChromiumPdf({ executablePath: env.HB_CHROMIUM_PATH });
const fake = env.HB_AI === "fake" ? createFakeAi() : null;
const ai: AiClients = fake
  ? { anthropic: fake, openai: fake }
  : { anthropic: createAnthropicClient(), openai: createOpenAiClient() };
const keyStore = createFileKeyStore({ dir: env.HB_DATA_DIR });

const deps: Deps = { db, userId, pdf, ai, keyStore, http: createHttpClient(), clock: { now: () => new Date() } };

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
