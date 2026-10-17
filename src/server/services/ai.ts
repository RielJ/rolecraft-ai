import { and, eq, sql } from "drizzle-orm";
import { estimateTokens, type Prompt, promptText } from "@/domain/prompts";
import type { AiCallId, TaskId } from "@/shared/api";
import type { AiProvider, AiPurpose, AiTier } from "@/shared/enums";
import { costUsd, DEFAULT_MODELS } from "../adapters/ai/pricing";
import { AiError, type AiSource } from "../adapters/ai/types";
import type { DbOrTx } from "../db/client";
import { aiCalls, users } from "../db/schema";
import { AppError, type Deps } from "./context";

/**
 * Every AI call goes through `runAi`: it reads the key, picks the tier's model, checks the
 * monthly cap, calls the provider and records an `ai_calls` row (decision 31). It takes the
 * database handle from `deps`, so the sync pipeline can pass its `hb_sync` transaction later.
 */

type AiDeps = Pick<Deps, "userId" | "ai" | "aiSource" | "keyStore" | "clock"> & { db: DbOrTx };

export const PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

export type AiConfig = {
  /** `pi` runs through the local pi CLI (decision 48); `key` uses the saved API key. */
  via: AiSource["kind"];
  provider: AiProvider;
  key: string;
  models: Record<AiTier, string>;
  capUsd: number | null;
};

/**
 * The saved provider, key and models, or null when no key is saved. With the pi runner there is
 * no key: the models come from env and only the cap is read from the user row.
 */
export async function loadAiConfig(deps: Omit<AiDeps, "ai" | "clock">): Promise<AiConfig | null> {
  if (deps.aiSource.kind === "pi") {
    const [user] = await deps.db.select({ cap: users.monthlyCapUsd }).from(users).where(eq(users.id, deps.userId));
    return {
      via: "pi",
      provider: "anthropic",
      key: "",
      models: deps.aiSource.models,
      capUsd: user?.cap == null ? null : Number(user.cap),
    };
  }
  const [user] = await deps.db
    .select({
      provider: users.aiProvider,
      modelLight: users.modelLight,
      modelWriting: users.modelWriting,
      cap: users.monthlyCapUsd,
    })
    .from(users)
    .where(eq(users.id, deps.userId));
  if (!user?.provider) return null;
  const key = await deps.keyStore.read(deps.userId);
  if (key === null) return null;
  const defaults = DEFAULT_MODELS[user.provider];
  return {
    via: "key",
    provider: user.provider,
    key,
    models: { light: user.modelLight || defaults.light, writing: user.modelWriting || defaults.writing },
    capUsd: user.cap === null ? null : Number(user.cap),
  };
}

export async function requireAiConfig(deps: Omit<AiDeps, "ai" | "clock">): Promise<AiConfig> {
  const config = await loadAiConfig(deps);
  if (!config) {
    throw new AppError({ code: "no_ai_key", message: "Add an AI key in Settings first, then draft again." });
  }
  return config;
}

/** This month's spend in USD, with the month taken in Asia/Manila (section 2, `ai_calls`). */
export async function monthSpend(deps: Pick<AiDeps, "db" | "userId" | "clock">): Promise<{
  usd: number;
  calls: number;
  unpriced: number;
}> {
  const now = deps.clock.now().toISOString();
  const [row] = await deps.db
    .select({
      usd: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)`,
      calls: sql<number>`count(*)::int`,
      unpriced: sql<number>`count(*) FILTER (WHERE ${aiCalls.costUsd} IS NULL)::int`,
    })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.userId, deps.userId),
        sql`${aiCalls.createdAt} >= date_trunc('month', ${now}::timestamptz AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'`,
      ),
    );
  return { usd: Number(row?.usd ?? 0), calls: row?.calls ?? 0, unpriced: row?.unpriced ?? 0 };
}

/** Cost estimate before a call: the whole prompt in, the full output budget out. Unpriced is 0. */
export function estimateUsd({
  model,
  prompt,
  maxOutputTokens,
}: {
  model: string;
  prompt: Prompt;
  maxOutputTokens: number;
}) {
  return costUsd({ model, inputTokens: estimateTokens(promptText(prompt)), outputTokens: maxOutputTokens }) ?? 0;
}

/**
 * `402 over_cap` when this month's spend plus the estimate would cross the cap, unless the user
 * confirmed. No cap means no check.
 */
export async function checkCap(
  deps: Pick<AiDeps, "db" | "userId" | "clock">,
  { capUsd, estimateUsd, confirmOverCap }: { capUsd: number | null; estimateUsd: number; confirmOverCap: boolean },
): Promise<void> {
  if (capUsd === null || confirmOverCap) return;
  const { usd } = await monthSpend(deps);
  if (usd + estimateUsd <= capUsd) return;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  throw new AppError({
    code: "over_cap",
    message: `This would take this month's AI spend past your $${capUsd.toFixed(2)} cap. Confirm to go over it, or raise the cap in Settings.`,
    details: { monthUsd: round(usd), capUsd, estimateUsd: round(estimateUsd) },
  });
}

/** The same, for the local pi runner: the way out is pi's own sign-in, not Settings. */
function piFailure(err: AiError): AppError {
  switch (err.kind) {
    case "rejected_key":
      return new AppError({
        code: "key_rejected",
        message: "pi is not signed in to Anthropic. Run pi, sign in with /login, then try again.",
      });
    case "rate_limited":
      return new AppError({
        code: "ai_unavailable",
        message: "Your pi plan is rate limited right now. Wait a few minutes, then try again.",
      });
    case "unavailable":
      return new AppError({
        code: "ai_unavailable",
        message: `Could not run pi (${err.message}). Check that pi is installed and on PATH, then try again.`,
      });
    case "bad_request":
      return new AppError({
        code: "ai_unavailable",
        message: `pi refused the request (${err.message}). Check HB_PI_MODEL_LIGHT and HB_PI_MODEL_WRITING.`,
      });
    default: {
      const _exhaustive: never = err.kind;
      return _exhaustive;
    }
  }
}

/** Turn a provider failure into a message that names the problem and the way out. */
export function aiFailure(err: AiError, provider: AiProvider, via: AiSource["kind"] = "key"): AppError {
  if (via === "pi") return piFailure(err);
  const name = PROVIDER_NAMES[provider];
  switch (err.kind) {
    case "rejected_key":
      return new AppError({
        code: "key_rejected",
        message: `${name} rejected the saved key. Paste a new key in Settings.`,
      });
    case "rate_limited":
      return new AppError({
        code: "ai_unavailable",
        message: `${name} is rate limiting this key. Wait a minute, then try again.`,
      });
    case "unavailable":
      return new AppError({
        code: "ai_unavailable",
        message: `Could not reach ${name}. Check your connection, then try again.`,
      });
    case "bad_request":
      return new AppError({
        code: "ai_unavailable",
        message: `${name} refused the request (${err.message}). Check the model names in Settings.`,
      });
    default: {
      const _exhaustive: never = err.kind;
      return _exhaustive;
    }
  }
}

export async function runAi(
  deps: AiDeps,
  {
    tier,
    purpose,
    taskId = null,
    prompt,
    maxOutputTokens,
    confirmOverCap = false,
  }: {
    tier: AiTier;
    purpose: AiPurpose;
    taskId?: TaskId | null;
    prompt: Prompt;
    maxOutputTokens: number;
    confirmOverCap?: boolean;
  },
): Promise<{ text: string; aiCallId: AiCallId }> {
  const config = await requireAiConfig(deps);
  const model = config.models[tier];
  await checkCap(deps, {
    capUsd: config.capUsd,
    estimateUsd: estimateUsd({ model, prompt, maxOutputTokens }),
    confirmOverCap,
  });

  let completion: Awaited<ReturnType<Deps["ai"]["anthropic"]["complete"]>>;
  try {
    completion = await deps.ai[config.provider].complete({
      key: config.key,
      model,
      tier,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens,
    });
  } catch (err) {
    if (err instanceof AiError) throw aiFailure(err, config.provider, config.via);
    throw err;
  }

  // A runner that reports its own cost (pi) is trusted over the price table.
  const cost =
    completion.costUsd ??
    costUsd({ model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens });
  const [row] = await deps.db
    .insert(aiCalls)
    .values({
      userId: deps.userId,
      taskId,
      tier,
      purpose,
      provider: config.provider,
      model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd: cost === null ? null : cost.toFixed(6),
      createdAt: deps.clock.now(),
    })
    .returning({ id: aiCalls.id });
  if (!row) throw new Error("ai_calls insert returned no row");
  return { text: completion.text, aiCallId: row.id };
}
