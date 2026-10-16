import OpenAI from "openai";
import { AiError, type AiProviderClient, failureKind } from "./types";

type Options = { fetch?: typeof fetch; baseURL?: string };

function toAiError(err: unknown): AiError {
  if (err instanceof OpenAI.APIError) {
    const kind = failureKind(err.status);
    return new AiError({ kind, message: `OpenAI: ${err.message}` });
  }
  return new AiError({ kind: "unavailable", message: `OpenAI: ${String(err)}` });
}

export function createOpenAiClient(options: Options = {}): AiProviderClient {
  const client = (key: string) => new OpenAI({ apiKey: key, maxRetries: 2, timeout: 120_000, ...options });

  return {
    async complete({ key, model, system, messages, maxOutputTokens }) {
      try {
        const res = await client(key).responses.create({
          model,
          instructions: system,
          input: messages.map((m) => ({ role: m.role, content: m.content })),
          max_output_tokens: maxOutputTokens,
          store: false,
        });
        if (res.output_text === "" && res.status === "incomplete") {
          throw new AiError({
            kind: "bad_request",
            message: `OpenAI stopped before writing any text (${res.incomplete_details?.reason ?? "incomplete"}).`,
          });
        }
        return {
          text: res.output_text,
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          model: res.model,
        };
      } catch (err) {
        throw err instanceof AiError ? err : toAiError(err);
      }
    },
    async checkKey({ key }) {
      try {
        await client(key).models.list();
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
