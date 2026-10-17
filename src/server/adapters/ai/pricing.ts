import type { AiProvider, AiTier } from "@/shared/enums";

/** USD per million tokens. Optional higher rates above a prompt-size threshold. */
type Price = {
  input: number;
  output: number;
  long?: { overInputTokens: number; input: number; output: number };
};

/**
 * Standard (non-batch) prices, read from the providers' pricing pages on 2026-10-17:
 * https://platform.claude.com/docs/en/about-claude/pricing and
 * https://developers.openai.com/api/docs/pricing. A model missing here records `cost_usd = NULL`.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, long: { overInputTokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4, output: 20 },
};

/**
 * Light-tier models that passed the evaluation set (`bun run eval`, decision 30): no missed
 * exclusion and no invented claim. A provider's light default must be its cheapest entry here.
 */
export const EVAL_PASSED_LIGHT: Partial<Record<AiProvider, { model: string; date: string; via: "key" | "pi" }>> = {
  // 15 eligibility cases (12 sent to the model), 4 drafting cases; two drafts fixed on the app's retry.
  anthropic: { model: "claude-haiku-5-5", date: "2026-10-17", via: "pi" },
};

/**
 * Models used when the user has not picked one (decision 30). Light is the cheapest model that
 * passed the eval where one has (Anthropic), else the provider's cheapest current model (OpenAI,
 * not yet evaluated). Writing is the mid model.
 */
export const DEFAULT_MODELS: Record<AiProvider, Record<AiTier, string>> = {
  anthropic: { light: "claude-haiku-5-5", writing: "claude-sonnet-5-5" },
  openai: { light: "gpt-6-luna", writing: "gpt-6.1-sol" },
};

/** Dated snapshots ("claude-haiku-4-5-20251001") are priced as their alias. */
function priceOf(model: string): Price | undefined {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, "")];
}

/** Estimated cost in USD, or null when the model is not in the price list. */
export function costUsd({
  model,
  inputTokens,
  outputTokens,
}: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const rate = price.long && inputTokens > price.long.overInputTokens ? price.long : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
