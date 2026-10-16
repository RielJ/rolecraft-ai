import { eq } from "drizzle-orm";
import type { SaveAiKeyInput, SettingsDto, UpdateSettingsInput } from "@/shared/api";
import { DEFAULT_MODELS } from "../adapters/ai/pricing";
import { AiError } from "../adapters/ai/types";
import { users } from "../db/schema";
import { aiFailure, monthSpend, PROVIDER_NAMES } from "./ai";
import { AppError, type Deps } from "./context";

/** Settings for AI: provider, key hint, models, cap, spend. The key itself never leaves the server. */
export async function getSettings(deps: Deps): Promise<SettingsDto> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, deps.userId));
  if (!user) throw new Error("user row missing");
  const spend = await monthSpend(deps);
  return {
    ai: {
      provider: user.aiProvider,
      keyHint: user.aiKeyHint,
      modelLight: user.modelLight,
      modelWriting: user.modelWriting,
      defaults: DEFAULT_MODELS,
      monthlyCapUsd: user.monthlyCapUsd === null ? null : Number(user.monthlyCapUsd),
      eligibilityOnRefresh: user.aiEligibilityOnRefresh,
    },
    spend: { monthUsd: spend.usd, calls: spend.calls, unpricedCalls: spend.unpriced },
  };
}

/**
 * Check the key with the provider, then write it to the key file (mode 0600) and store only its
 * last four characters. A rejected key saves nothing.
 */
export async function saveAiKey(deps: Deps, { provider, key }: SaveAiKeyInput): Promise<SettingsDto> {
  try {
    await deps.ai[provider].checkKey({ key });
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    if (err.kind === "rejected_key") {
      throw new AppError({
        code: "key_rejected",
        message: `${PROVIDER_NAMES[provider]} rejected this key. Check that you copied all of it, then paste it again.`,
      });
    }
    throw aiFailure(err, provider);
  }

  const [before] = await deps.db.select({ provider: users.aiProvider }).from(users).where(eq(users.id, deps.userId));
  await deps.keyStore.write(deps.userId, key);
  await deps.db
    .update(users)
    .set({
      aiProvider: provider,
      aiKeyHint: key.slice(-4),
      // Model names belong to a provider, so switching providers goes back to its defaults.
      ...(before?.provider === provider ? {} : { modelLight: null, modelWriting: null }),
    })
    .where(eq(users.id, deps.userId));
  return getSettings(deps);
}

export async function removeAiKey(deps: Deps): Promise<SettingsDto> {
  await deps.keyStore.remove(deps.userId);
  await deps.db.update(users).set({ aiProvider: null, aiKeyHint: null }).where(eq(users.id, deps.userId));
  return getSettings(deps);
}

export async function updateSettings(deps: Deps, input: UpdateSettingsInput): Promise<SettingsDto> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.modelLight !== undefined) patch.modelLight = input.modelLight || null;
  if (input.modelWriting !== undefined) patch.modelWriting = input.modelWriting || null;
  if (input.monthlyCapUsd !== undefined) {
    patch.monthlyCapUsd = input.monthlyCapUsd === null ? null : input.monthlyCapUsd.toFixed(2);
  }
  if (input.eligibilityOnRefresh !== undefined) patch.aiEligibilityOnRefresh = input.eligibilityOnRefresh;
  if (Object.keys(patch).length) await deps.db.update(users).set(patch).where(eq(users.id, deps.userId));
  return getSettings(deps);
}
