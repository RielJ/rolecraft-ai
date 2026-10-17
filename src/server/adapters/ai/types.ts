import type { PromptMessage } from "@/domain/prompts";
import type { AiProvider, AiTier } from "@/shared/enums";

export type AiCompletionRequest = {
  key: string;
  model: string;
  /** The SDK clients ignore it; the pi runner picks its thinking level from it. */
  tier: AiTier;
  system: string;
  messages: readonly PromptMessage[];
  maxOutputTokens: number;
};

export type AiCompletion = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Cost the runner reported (pi does); otherwise runAi prices the tokens from pricing.ts. */
  costUsd?: number;
};

/**
 * Where AI calls go (decision 48). `key`: the provider SDKs with the key saved in Settings.
 * `pi`: the local pi CLI with its own sign-in, the models fixed by env.
 */
export type AiSource = { kind: "key" } | { kind: "pi"; models: Record<AiTier, string> };

/**
 * Why a call failed, in terms the app can act on:
 * - `rejected_key`: the provider refused the key (401 or 403).
 * - `rate_limited`: 429, try later.
 * - `unavailable`: network, timeout or a 5xx.
 * - `bad_request`: the request itself was refused, for example an unknown model.
 */
export type AiFailureKind = "rejected_key" | "rate_limited" | "unavailable" | "bad_request";

export class AiError extends Error {
  readonly kind: AiFailureKind;
  constructor({ kind, message }: { kind: AiFailureKind; message: string }) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
  }
}

/** One provider behind the small interface of decision 29. Methods throw `AiError`. */
export type AiProviderClient = {
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
  /** A call that costs no tokens and fails with `rejected_key` on a bad key. */
  checkKey({ key }: { key: string }): Promise<void>;
};

export type AiClients = Record<AiProvider, AiProviderClient>;

/** Shared status mapping for both SDKs, which expose `status` on their APIError. */
export function failureKind(status: number | undefined): AiFailureKind {
  if (status === undefined) return "unavailable";
  if (status === 401 || status === 403) return "rejected_key";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "bad_request";
}
