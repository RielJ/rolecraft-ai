import { z } from "zod";
import type { AiTier } from "@/shared/enums";
import { type AiCompletion, type AiCompletionRequest, AiError, type AiProviderClient, failureKind } from "./types";

/**
 * The local pi runner (decision 48, PLAN 3.4a). Each call spawns the pi CLI, which signs in with
 * its own stored credentials; this module never reads them. pi runs bare: no tools, extensions,
 * skills, context files, prompt templates or session, and with the app's own system prompt, so the
 * prompt the app built is the only thing the model sees.
 */

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinking = (typeof PI_THINKING_LEVELS)[number];

/** The slice of `Bun.spawn` this module uses, so tests can inject a fake process. */
export type PiSpawn = (
  cmd: string[],
  options: { stdin: Blob; stdout: "pipe"; stderr: "pipe" },
) => {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

export type PiOptions = {
  /** The pi binary, `pi` on PATH by default. */
  bin?: string;
  /** pi's provider for the models (`anthropic/<model>`). */
  piProvider?: string;
  thinking: Record<AiTier, PiThinking>;
  timeoutMs?: number;
  spawn?: PiSpawn;
};

/** The flags that make pi a plain completion runner. */
export const PI_BARE_FLAGS = [
  "-p",
  "--mode",
  "json",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-session",
  "--offline",
] as const;

export function piArgs({
  bin,
  piProvider,
  model,
  thinking,
  system,
}: {
  bin: string;
  piProvider: string;
  model: string;
  thinking: PiThinking;
  system: string;
}): string[] {
  return [
    bin,
    ...PI_BARE_FLAGS,
    "--model",
    `${piProvider}/${model}`,
    "--thinking",
    thinking,
    "--system-prompt",
    system,
  ];
}

/**
 * pi -p takes one prompt. A single user message goes as is; a retry conversation (user, assistant,
 * user) is written out with labelled turns so the model sees its earlier reply.
 */
export function piPromptText(messages: AiCompletionRequest["messages"]): string {
  const [only, ...rest] = messages;
  if (only && rest.length === 0 && only.role === "user") return only.content;
  return messages
    .map((m) => (m.role === "user" ? `### User\n\n${m.content}` : `### Your earlier reply\n\n${m.content}`))
    .join("\n\n");
}

const PiUsage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  cost: z.object({ total: z.number() }).optional(),
});

const PiMessageEnd = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
    model: z.string().optional(),
    stopReason: z.string().nullish(),
    errorMessage: z.string().nullish(),
    usage: PiUsage.nullish(),
  }),
});

export type PiResult =
  | { kind: "ok"; completion: AiCompletion }
  | { kind: "error"; status: number | undefined; message: string }
  | { kind: "empty" };

/** Read pi's JSON lines. The answer is the last assistant `message_end`. */
export function parsePiOutput(jsonl: string, requestedModel: string): PiResult {
  let last: z.infer<typeof PiMessageEnd>["message"] | null = null;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = PiMessageEnd.safeParse(value);
    if (parsed.success && parsed.data.message.role === "assistant") last = parsed.data.message;
  }
  if (!last) return { kind: "empty" };
  if (last.stopReason === "error") {
    const message = last.errorMessage ?? "pi reported an error.";
    const status = /^(\d{3})\b/.exec(message)?.[1];
    return { kind: "error", status: status === undefined ? undefined : Number(status), message };
  }
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join("");
  if (!text.trim()) return { kind: "empty" };
  const usage = last.usage;
  const completion: AiCompletion = {
    text,
    inputTokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
    outputTokens: usage?.output ?? 0,
    model: last.model ?? requestedModel,
  };
  if (usage?.cost) completion.costUsd = usage.cost.total;
  return { kind: "ok", completion };
}

const PiAuthStatus = z.object({ status: z.string() });

/** `pi auth check --json` prints one status line; only `ready` counts. */
export function parsePiAuthCheck(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // A non-JSON line (a warning pi printed) says nothing about readiness; read the next one.
      continue;
    }
    const parsed = PiAuthStatus.safeParse(value);
    if (parsed.success) return parsed.data.status === "ready";
  }
  return false;
}

const defaultSpawn: PiSpawn = (cmd, options) => Bun.spawn(cmd, options);

export function createPiClient(options: PiOptions): AiProviderClient & { authReady(): Promise<boolean> } {
  const bin = options.bin ?? "pi";
  const piProvider = options.piProvider ?? "anthropic";
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 300_000;

  async function run(cmd: string[], stdin: string): Promise<{ stdout: string; stderr: string; exit: number }> {
    let proc: ReturnType<PiSpawn>;
    try {
      proc = spawn(cmd, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      throw new AiError({ kind: "unavailable", message: `pi could not start: ${String(err)}` });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const result = await Promise.race([done, timedOut]);
      if (result === "timeout") {
        proc.kill();
        throw new AiError({ kind: "unavailable", message: `pi took longer than ${timeoutMs / 1000}s.` });
      }
      const [stdout, stderr, exit] = result;
      return { stdout, stderr, exit };
    } finally {
      clearTimeout(timer);
    }
  }

  async function authReady(): Promise<boolean> {
    try {
      const { stdout } = await run([bin, "auth", "check", "--provider", piProvider, "--json", "--no-refresh"], "");
      return parsePiAuthCheck(stdout);
    } catch {
      return false;
    }
  }

  return {
    async complete(request) {
      const cmd = piArgs({
        bin,
        piProvider,
        model: request.model,
        thinking: options.thinking[request.tier],
        system: request.system,
      });
      const { stdout, stderr, exit } = await run(cmd, piPromptText(request.messages));
      const result = parsePiOutput(stdout, request.model);
      switch (result.kind) {
        case "ok":
          return result.completion;
        case "error":
          throw new AiError({ kind: failureKind(result.status), message: `pi: ${result.message.slice(0, 300)}` });
        case "empty":
          throw new AiError({
            kind: "unavailable",
            message: `pi returned no answer (exit ${exit}). ${stderr.trim().slice(0, 300)}`.trim(),
          });
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    },
    async checkKey() {
      if (!(await authReady())) {
        throw new AiError({ kind: "rejected_key", message: `pi is not signed in to ${piProvider}.` });
      }
    },
    authReady,
  };
}
