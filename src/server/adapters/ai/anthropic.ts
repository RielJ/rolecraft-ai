import Anthropic from "@anthropic-ai/sdk";
import { AiError, type AiProviderClient, failureKind } from "./types";

type Options = { fetch?: typeof fetch; baseURL?: string };

function toAiError(err: unknown): AiError {
  if (err instanceof Anthropic.APIError) {
    const kind = failureKind(err.status);
    return new AiError({ kind, message: `Anthropic: ${err.message}` });
  }
  return new AiError({ kind: "unavailable", message: `Anthropic: ${String(err)}` });
}

export function createAnthropicClient(options: Options = {}): AiProviderClient {
  const client = (key: string) => new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000, ...options });

  return {
    async complete({ key, model, system, messages, maxOutputTokens }) {
      try {
        const res = await client(key).messages.create({
          model,
          max_tokens: maxOutputTokens,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return {
          text,
          inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
          outputTokens: res.usage.output_tokens,
          model: res.model,
        };
      } catch (err) {
        throw toAiError(err);
      }
    },
    async checkKey({ key }) {
      try {
        await client(key).models.list({ limit: 1 });
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
