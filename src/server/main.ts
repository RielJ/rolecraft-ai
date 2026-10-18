import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createAnthropicClient } from "./adapters/ai/anthropic";
import { createFakeAi } from "./adapters/ai/fake";
import { createOpenAiClient } from "./adapters/ai/openai";
import { createPiClient } from "./adapters/ai/pi";
import type { AiClients, AiSource } from "./adapters/ai/types";
import { createGhReader, createPublicReader, type GithubReader } from "./adapters/github";
import { createFixtureReader } from "./adapters/github-fixture";
import { createHttpClient } from "./adapters/http";
import { createFileKeyStore } from "./adapters/key-store";
import { createChromiumPdf } from "./adapters/pdf";
import { createSourceAdapters } from "./adapters/sources";
import { createFixtureSources } from "./adapters/sources/fixture";
import { createDb } from "./db/client";
import { migrateDb } from "./db/migrate";
import { parseEnv } from "./env";
import { createApp } from "./http/app";
import type { Deps } from "./services/context";
import { ensureUser } from "./services/profile";
import { ensureBuiltinSources } from "./services/sources";
import { markInterrupted } from "./services/tasks";

// Composition root: parse env, migrate, ensure the user row, build deps, serve.
const env = parseEnv(process.env);
await migrateDb({ url: env.DATABASE_URL });
const { db, close } = createDb({ url: env.DATABASE_URL });
const userId = await ensureUser(db);
// The five built-in boards, on by default (Q10). Idempotent: existing rows keep their settings.
await ensureBuiltinSources({ db, userId });
// Tasks run in this process, so any still `running` died with the last one (decision 36).
const interrupted = await markInterrupted(db);
if (interrupted > 0) console.info(JSON.stringify({ level: "info", msg: "tasks interrupted", count: interrupted }));
const pdf = createChromiumPdf({ executablePath: env.HB_CHROMIUM_PATH });
function buildAi(): { ai: AiClients; aiSource: AiSource } {
  switch (env.HB_AI) {
    case "fake": {
      const fake = createFakeAi();
      return { ai: { anthropic: fake, openai: fake }, aiSource: { kind: "key" } };
    }
    case "live":
      return { ai: { anthropic: createAnthropicClient(), openai: createOpenAiClient() }, aiSource: { kind: "key" } };
    case "pi": {
      const pi = createPiClient({
        bin: env.HB_PI_BIN,
        thinking: { light: env.HB_PI_THINKING_LIGHT, writing: env.HB_PI_THINKING_WRITING },
      });
      // Not fatal: the user can sign in to pi while the app runs. Drafts say how until then.
      void pi.authReady().then((ready) => {
        if (!ready) console.warn(JSON.stringify({ level: "warn", msg: "pi is not signed in to anthropic" }));
      });
      return {
        ai: { anthropic: pi, openai: pi },
        aiSource: { kind: "pi", models: { light: env.HB_PI_MODEL_LIGHT, writing: env.HB_PI_MODEL_WRITING } },
      };
    }
    default: {
      const _exhaustive: never = env.HB_AI;
      return _exhaustive;
    }
  }
}
const { ai, aiSource } = buildAi();
const keyStore = createFileKeyStore({ dir: env.HB_DATA_DIR });

const http = createHttpClient();
const sources =
  env.HB_SOURCES === "fixture"
    ? createFixtureSources({ dir: env.HB_SOURCES_DIR, log: env.HB_SOURCES_LOG })
    : createSourceAdapters(http);

function buildGithub(): GithubReader {
  const user = env.HB_GITHUB_USER ?? null;
  switch (env.HB_GITHUB) {
    case "public":
      return createPublicReader({ http, user });
    case "gh":
      // env.ts refuses HB_GITHUB=gh without HB_GITHUB_USER.
      return createGhReader({ user: env.HB_GITHUB_USER ?? "", bin: env.HB_GH_BIN });
    case "fixture":
      return createFixtureReader({ dir: env.HB_GITHUB_DIR, user });
    default: {
      const _exhaustive: never = env.HB_GITHUB;
      return _exhaustive;
    }
  }
}
const github = buildGithub();

const deps: Deps = {
  db,
  userId,
  pdf,
  ai,
  aiSource,
  keyStore,
  http,
  sources,
  github,
  clock: { now: () => new Date() },
};

const server = new Hono()
  .route("/", createApp(deps, { allowedHosts: env.HB_ALLOWED_HOSTS }))
  .use("/*", serveStatic({ root: env.HB_STATIC_DIR }))
  // SPA fallback: any non-API path that is not a file gets index.html.
  .get("*", serveStatic({ root: env.HB_STATIC_DIR, path: "index.html" }));

const bun = Bun.serve({ hostname: env.HB_HOST, port: env.PORT, fetch: server.fetch });
console.info(JSON.stringify({ level: "info", msg: "listening", url: bun.url.href }));

async function shutdown(): Promise<void> {
  await bun.stop();
  await pdf.close();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
