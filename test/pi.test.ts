import { beforeEach, describe, expect, test } from "bun:test";
import type { FakeAi } from "@/server/adapters/ai/fake";
import {
  createPiClient,
  PI_BARE_FLAGS,
  type PiSpawn,
  parsePiAuthCheck,
  parsePiOutput,
  piArgs,
  piPromptText,
} from "@/server/adapters/ai/pi";
import { AiError } from "@/server/adapters/ai/types";
import { createApp } from "@/server/http/app";
import { runAi } from "@/server/services/ai";
import type { Deps } from "@/server/services/context";
import { ApiErrorBody, SettingsDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/** One assistant message_end line the way pi --mode json prints it. */
function messageEnd(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello there." }],
      model: "claude-opus-5-5",
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: { total: 0.0123 } },
      ...over,
    },
  });
}

const USER_END = JSON.stringify({ type: "message_end", message: { role: "user", content: "hi" } });

type Call = { cmd: string[]; stdin: string };

/** A spawn that records each call and answers with fixed stdout and exit code. */
function fakeSpawn(stdout: string, exit = 0, calls: Call[] = []): PiSpawn {
  return (cmd, options) => {
    const call: Call = { cmd, stdin: "" };
    calls.push(call);
    const stdinRead = options.stdin.text().then((t) => {
      call.stdin = t;
    });
    return {
      stdout: new Response(stdout).body ?? new ReadableStream(),
      stderr: new Response("").body ?? new ReadableStream(),
      exited: stdinRead.then(() => exit),
      kill() {},
    };
  };
}

const THINKING = { light: "off", writing: "low" } as const;

describe("pi adapter", () => {
  test("argv runs pi bare with the model, thinking and system prompt; the prompt is not in argv", async () => {
    const calls: Call[] = [];
    const pi = createPiClient({ thinking: THINKING, spawn: fakeSpawn(`${USER_END}\n${messageEnd()}\n`, 0, calls) });
    await pi.complete({
      key: "",
      model: "claude-opus-5-5",
      tier: "writing",
      system: "SYS",
      messages: [{ role: "user", content: "SECRET CV TEXT" }],
      maxOutputTokens: 100,
    });
    const [call] = calls;
    expect(call?.cmd).toEqual(
      piArgs({ bin: "pi", piProvider: "anthropic", model: "claude-opus-5-5", thinking: "low", system: "SYS" }),
    );
    for (const flag of ["--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-session"]) {
      expect(call?.cmd).toContain(flag);
    }
    expect(call?.cmd.join(" ")).not.toContain("SECRET CV TEXT");
    expect(call?.stdin).toBe("SECRET CV TEXT");
  });

  test("the light tier uses its own thinking level", async () => {
    const calls: Call[] = [];
    const pi = createPiClient({ thinking: THINKING, spawn: fakeSpawn(messageEnd(), 0, calls) });
    await pi.complete({
      key: "",
      model: "claude-haiku-5-5",
      tier: "light",
      system: "S",
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 10,
    });
    const cmd = calls[0]?.cmd ?? [];
    expect(cmd[cmd.indexOf("--thinking") + 1]).toBe("off");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("anthropic/claude-haiku-5-5");
  });

  test("the answer, tokens and reported cost come from the last assistant message_end", () => {
    const out = `garbage line\n${USER_END}\n${messageEnd({ content: [{ type: "text", text: "first" }] })}\n${messageEnd()}\n`;
    expect(parsePiOutput(out, "m")).toEqual({
      kind: "ok",
      completion: {
        text: "Hello there.",
        inputTokens: 108,
        outputTokens: 20,
        model: "claude-opus-5-5",
        costUsd: 0.0123,
      },
    });
  });

  test("an error stop maps its HTTP status; no answer is unavailable", async () => {
    const err = messageEnd({ stopReason: "error", errorMessage: "429 rate limited", content: [] });
    expect(parsePiOutput(err, "m")).toEqual({ kind: "error", status: 429, message: "429 rate limited" });
    expect(parsePiOutput(USER_END, "m")).toEqual({ kind: "empty" });

    const limited = createPiClient({ thinking: THINKING, spawn: fakeSpawn(err) });
    const request = {
      key: "",
      model: "m",
      tier: "light" as const,
      system: "s",
      messages: [{ role: "user" as const, content: "x" }],
      maxOutputTokens: 1,
    };
    expect(await limited.complete(request).catch((e: unknown) => e)).toMatchObject({ kind: "rate_limited" });
    const silent = createPiClient({ thinking: THINKING, spawn: fakeSpawn("", 1) });
    const e = await silent.complete(request).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e).toMatchObject({ kind: "unavailable" });
  });

  test("a retry conversation is written out with labelled turns", () => {
    expect(piPromptText([{ role: "user", content: "only" }])).toBe("only");
    const text = piPromptText([
      { role: "user", content: "draft" },
      { role: "assistant", content: "bad" },
      { role: "user", content: "fix" },
    ]);
    expect(text).toContain("### Your earlier reply\n\nbad");
    expect(text.indexOf("draft")).toBeLessThan(text.indexOf("fix"));
  });

  test("auth check counts only status ready", async () => {
    expect(parsePiAuthCheck('warning\n{"status":"ready","provider":"anthropic"}')).toBe(true);
    expect(parsePiAuthCheck('{"status":"missing"}')).toBe(false);
    expect(parsePiAuthCheck("")).toBe(false);
    const calls: Call[] = [];
    const pi = createPiClient({ thinking: THINKING, spawn: fakeSpawn('{"status":"ready"}', 0, calls) });
    expect(await pi.authReady()).toBe(true);
    expect(calls[0]?.cmd).toEqual(["pi", "auth", "check", "--provider", "anthropic", "--json", "--no-refresh"]);
    expect(PI_BARE_FLAGS).toContain("--offline");
  });
});

describe("HB_AI=pi in the app", () => {
  const PI_MODELS = { light: "claude-haiku-5-5", writing: "claude-opus-5-5" };
  let deps: Deps & { fake: FakeAi };
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await resetDb();
    deps = await testDeps({ aiSource: { kind: "pi", models: PI_MODELS } });
    app = createApp(deps);
  });

  test("Settings reports pi with its models, and saving a key is refused", async () => {
    const settings = SettingsDto.parse(await (await app.request("/api/settings")).json());
    expect(settings.ai.via).toBe("pi");
    expect(settings.ai.piModels).toEqual(PI_MODELS);
    const res = await app.request("/api/settings/ai-key", {
      method: "PUT",
      body: JSON.stringify({ provider: "anthropic", key: "sk-ant-good-key-a1B2" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBody.parse(await res.json()).error.message).toContain("HB_AI=pi");
  });

  test("runAi needs no saved key, uses the tier's pi model and records pi's reported cost", async () => {
    const calls: Call[] = [];
    const pi = createPiClient({ thinking: THINKING, spawn: fakeSpawn(messageEnd(), 0, calls) });
    const done = await runAi(
      { ...deps, ai: { anthropic: pi, openai: pi } },
      {
        purpose: "draft",
        tier: "writing",
        prompt: { system: "s", messages: [{ role: "user", content: "x" }] },
        maxOutputTokens: 10,
      },
    );
    expect(done.text).toBe("Hello there.");
    const cmd = calls[0]?.cmd ?? [];
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("anthropic/claude-opus-5-5");
    const [row] = await testSql()<{ provider: string; model: string; cost_usd: string }[]>`
      select provider, model, cost_usd::text from ai_calls`;
    expect(row?.provider).toBe("anthropic");
    expect(row?.model).toBe("claude-opus-5-5");
    expect(Number(row?.cost_usd)).toBeCloseTo(0.0123, 6);
  });
});
