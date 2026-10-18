import { beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createAnthropicClient } from "@/server/adapters/ai/anthropic";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createOpenAiClient } from "@/server/adapters/ai/openai";
import { costUsd } from "@/server/adapters/ai/pricing";
import { AiError } from "@/server/adapters/ai/types";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ApiErrorBody, SettingsDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps();
  app = createApp(deps);
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

const KEY = "sk-ant-api03-very-secret-key-WXYZ";

describe("AI key", () => {
  test("a fresh install has no key, default models and no spend", async () => {
    const settings = await json(await call("GET", "/settings"), SettingsDto);
    expect(settings).toEqual({
      money: { viewCurrency: "PHP", fxRates: [], missingRates: [], fetch: null },
      ai: {
        via: "key",
        piModels: null,
        provider: null,
        keyHint: null,
        modelLight: null,
        modelWriting: null,
        defaults: {
          anthropic: { light: "claude-haiku-5-5", writing: "claude-sonnet-5-5" },
          openai: { light: "gpt-6-luna", writing: "gpt-6.1-sol" },
        },
        monthlyCapUsd: null,
        eligibilityOnRefresh: false,
      },
      spend: { monthUsd: 0, calls: 0, unpricedCalls: 0 },
    });
  });

  test("saving checks the key, writes a 0600 file, stores only the hint and never returns the key", async () => {
    const res = await call("PUT", "/settings/ai-key", { provider: "anthropic", key: `  ${KEY}  ` });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("very-secret");
    const settings = SettingsDto.parse(JSON.parse(text));
    expect(settings.ai).toMatchObject({ provider: "anthropic", keyHint: "WXYZ" });

    const path = deps.keyStore.pathFor(deps.userId);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(path).text()).toBe(KEY);
    expect(await deps.keyStore.read(deps.userId)).toBe(KEY);

    // The key is in no database column.
    const [row] = await testSql()<{ dump: string }[]>`SELECT row_to_json(users)::text AS dump FROM users`;
    expect(row?.dump).not.toContain("very-secret");

    const again = await call("GET", "/settings");
    expect(await again.text()).not.toContain("very-secret");
  });

  test("no settings response ever contains the key", async () => {
    const bodies: string[] = [];
    const record = async (res: Response) => {
      bodies.push(await res.text());
    };
    await record(await call("PUT", "/settings/ai-key", { provider: "anthropic", key: KEY }));
    await record(await call("GET", "/settings"));
    await record(await call("PATCH", "/settings", { monthlyCapUsd: 5 }));
    await record(await call("PUT", "/settings/ai-key", { provider: "anthropic", key: `${KEY}-bad` }));
    await record(await call("DELETE", "/settings/ai-key"));
    await record(await call("GET", "/settings"));
    expect(bodies).toHaveLength(6);
    for (const body of bodies) expect(body).not.toContain("very-secret");
  });

  test("a rejected key saves nothing and says so", async () => {
    const res = await call("PUT", "/settings/ai-key", { provider: "openai", key: "sk-proj-bad-key-1234" });
    const body = await json(res, ApiErrorBody, 400);
    expect(body.error).toMatchObject({
      code: "key_rejected",
      message: "OpenAI rejected this key. Check that you copied all of it, then paste it again.",
    });
    expect(await deps.keyStore.read(deps.userId)).toBeNull();
    const settings = await json(await call("GET", "/settings"), SettingsDto);
    expect(settings.ai.provider).toBeNull();
  });

  test("a too-short key is invalid input", async () => {
    const res = await call("PUT", "/settings/ai-key", { provider: "openai", key: "short" });
    expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });

  test("removing the key deletes the file and the hint", async () => {
    await call("PUT", "/settings/ai-key", { provider: "anthropic", key: KEY });
    const settings = await json(await call("DELETE", "/settings/ai-key"), SettingsDto);
    expect(settings.ai).toMatchObject({ provider: null, keyHint: null });
    expect(await Bun.file(deps.keyStore.pathFor(deps.userId)).exists()).toBe(false);
  });

  test("switching provider resets the model names to that provider's defaults", async () => {
    await call("PUT", "/settings/ai-key", { provider: "anthropic", key: KEY });
    await call("PATCH", "/settings", { modelWriting: "claude-opus-5" });
    const same = await json(await call("PUT", "/settings/ai-key", { provider: "anthropic", key: KEY }), SettingsDto);
    expect(same.ai.modelWriting).toBe("claude-opus-5");
    const other = await json(
      await call("PUT", "/settings/ai-key", { provider: "openai", key: "sk-proj-good-key-1234" }),
      SettingsDto,
    );
    expect(other.ai).toMatchObject({ provider: "openai", modelWriting: null, keyHint: "1234" });
  });
});

describe("models, cap and toggles", () => {
  test("PATCH sets models, cap and the eligibility toggle; empty model or null cap clears them", async () => {
    const set = await json(
      await call("PATCH", "/settings", {
        modelLight: "claude-haiku-5-5-20261001",
        modelWriting: "claude-opus-5",
        monthlyCapUsd: 12.5,
        eligibilityOnRefresh: true,
      }),
      SettingsDto,
    );
    expect(set.ai).toMatchObject({
      modelLight: "claude-haiku-5-5-20261001",
      modelWriting: "claude-opus-5",
      monthlyCapUsd: 12.5,
      eligibilityOnRefresh: true,
    });
    const cleared = await json(await call("PATCH", "/settings", { modelLight: "", monthlyCapUsd: null }), SettingsDto);
    expect(cleared.ai).toMatchObject({ modelLight: null, modelWriting: "claude-opus-5", monthlyCapUsd: null });
  });

  test("a zero or negative cap and a model name with spaces are invalid", async () => {
    for (const body of [{ monthlyCapUsd: 0 }, { monthlyCapUsd: -5 }, { modelWriting: "gpt 6" }]) {
      const res = await call("PATCH", "/settings", body);
      expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
    }
  });

  test("a cap that rounds below $0.01 is a 400 naming the smallest cap; $0.005 and up round to a valid cap", async () => {
    for (const monthlyCapUsd of [0.001, 0.004999]) {
      const res = await call("PATCH", "/settings", { monthlyCapUsd });
      const { error } = await json(res, ApiErrorBody, 400);
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("The smallest cap is $0.01.");
    }
    const ok = await json(await call("PATCH", "/settings", { monthlyCapUsd: 0.005 }), SettingsDto);
    expect(ok.ai.monthlyCapUsd).toBe(0.01);
  });
});

describe("pricing", () => {
  test("cost is per million tokens, dated names match their alias, unknown models are unpriced", () => {
    expect(costUsd({ model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3, 6);
    expect(costUsd({ model: "claude-sonnet-5-5-20261001", inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2, 6);
    expect(costUsd({ model: "some-new-model", inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe("provider adapters over HTTP", () => {
  /** A fetch that answers every request with one status and body, and records the URLs. */
  function stubFetch(status: number, body: unknown) {
    const urls: string[] = [];
    const fn = async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    return { urls, fetch: Object.assign(fn, { preconnect: fetch.preconnect }) };
  }

  async function failure(run: () => Promise<unknown>): Promise<AiError> {
    try {
      await run();
    } catch (err) {
      if (err instanceof AiError) return err;
      throw err;
    }
    throw new Error("expected an AiError");
  }

  test("Anthropic: a 401 is rejected_key; a 400 is bad_request", async () => {
    const unauthorized = stubFetch(401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const client = createAnthropicClient({ fetch: unauthorized.fetch, baseURL: "http://anthropic.test" });
    expect((await failure(() => client.checkKey({ key: "sk-ant-nope" }))).kind).toBe("rejected_key");
    expect(unauthorized.urls[0]).toStartWith("http://anthropic.test/v1/models");

    const bad = stubFetch(400, {
      type: "error",
      error: { type: "invalid_request_error", message: "model: not found" },
    });
    const badClient = createAnthropicClient({ fetch: bad.fetch, baseURL: "http://anthropic.test" });
    const err = await failure(() =>
      badClient.complete({
        key: "k",
        model: "nope",
        tier: "writing",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 10,
      }),
    );
    expect(err.kind).toBe("bad_request");
  });

  test("Anthropic: a completion returns its text and token counts", async () => {
    const ok = stubFetch(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "Hello [FACT-1]." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 0 },
    });
    const client = createAnthropicClient({ fetch: ok.fetch, baseURL: "http://anthropic.test" });
    const res = await client.complete({
      key: "k",
      model: "claude-sonnet-5-5",
      tier: "writing",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(res).toEqual({ text: "Hello [FACT-1].", inputTokens: 120, outputTokens: 8, model: "claude-sonnet-5-5" });
    expect(ok.urls[0]).toBe("http://anthropic.test/v1/messages");
  });

  test("OpenAI: a 401 is rejected_key; a completion reads output_text and usage", async () => {
    const unauthorized = stubFetch(401, {
      error: { message: "Incorrect API key provided", type: "invalid_request_error" },
    });
    const client = createOpenAiClient({ fetch: unauthorized.fetch, baseURL: "http://openai.test/v1" });
    expect((await failure(() => client.checkKey({ key: "sk-nope" }))).kind).toBe("rejected_key");

    const ok = stubFetch(200, {
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-6.1-sol",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi [FACT-2].", annotations: [] }],
        },
      ],
      usage: { input_tokens: 50, output_tokens: 4, total_tokens: 54 },
    });
    const okClient = createOpenAiClient({ fetch: ok.fetch, baseURL: "http://openai.test/v1" });
    const res = await okClient.complete({
      key: "k",
      model: "gpt-6.1-sol",
      tier: "writing",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(res).toEqual({ text: "Hi [FACT-2].", inputTokens: 50, outputTokens: 4, model: "gpt-6.1-sol" });
    expect(ok.urls[0]).toBe("http://openai.test/v1/responses");
  });
});

describe("view currency and FX rates (decision 20, Q12)", () => {
  const SET_AT = "2026-07-10T08:00:00.000Z";
  beforeEach(async () => {
    deps = await testDeps({ clock: { now: () => new Date(SET_AT) } });
    app = createApp(deps);
  });

  test("rates are saved per currency with the date set; null removes one", async () => {
    const saved = await json(await call("PATCH", "/settings", { fxRates: { usd: 57.8, EUR: 62.1 } }), SettingsDto);
    expect(saved.money).toEqual({
      viewCurrency: "PHP",
      fxRates: [
        { currency: "EUR", rate: 62.1, setAt: SET_AT, by: "user", rateDate: null },
        { currency: "USD", rate: 57.8, setAt: SET_AT, by: "user", rateDate: null },
      ],
      missingRates: [],
      fetch: null,
    });
    const after = await json(await call("PATCH", "/settings", { fxRates: { EUR: null } }), SettingsDto);
    expect(after.money.fxRates).toEqual([{ currency: "USD", rate: 57.8, setAt: SET_AT, by: "user", rateDate: null }]);
  });

  test("the view currency cannot have a rate", async () => {
    const err = await json(await call("PATCH", "/settings", { fxRates: { PHP: 1 } }), ApiErrorBody, 400);
    expect(err.error).toMatchObject({
      code: "invalid_input",
      message: "PHP is your view currency, so it needs no rate.",
    });
  });

  test("changing the view currency clears the rates", async () => {
    await call("PATCH", "/settings", { fxRates: { USD: 57.8 } });
    const saved = await json(await call("PATCH", "/settings", { viewCurrency: "usd" }), SettingsDto);
    expect(saved.money).toEqual({ viewCurrency: "USD", fxRates: [], missingRates: [], fetch: null });
  });

  test("changing the view currency resets the last fetch; keeping it does not", async () => {
    const sql = testSql();
    const fetch = { at: SET_AT, error: null, unsupported: ["XAF"] };
    await sql`UPDATE users SET fx_fetch = ${sql.json(fetch)}`;
    const same = await json(
      await call("PATCH", "/settings", { viewCurrency: "PHP", fxRates: { USD: 60 } }),
      SettingsDto,
    );
    expect(same.money.fetch).toEqual(fetch);
    const changed = await json(await call("PATCH", "/settings", { viewCurrency: "USD" }), SettingsDto);
    expect(changed.money.fetch).toBeNull();
  });

  test("a rate stored before decision 67 reads back as typed by the user", async () => {
    const sql = testSql();
    await sql`UPDATE users SET fx_rates = ${sql.json({ USD: { rate: 57.8, setAt: SET_AT } })}`;
    const settings = await json(await call("GET", "/settings"), SettingsDto);
    expect(settings.money.fxRates).toEqual([
      { currency: "USD", rate: 57.8, setAt: SET_AT, by: "user", rateDate: null },
    ]);
    // Saving another rate writes the old one back in the new shape.
    await call("PATCH", "/settings", { fxRates: { EUR: 62.1 } });
    const [row] = await sql<{ rates: Record<string, unknown> }[]>`SELECT fx_rates AS rates FROM users`;
    expect(row?.rates.USD).toEqual({ rate: 57.8, setAt: SET_AT, by: "user", rateDate: null });
  });

  test("migration 0012's backfill marks stored rates as the user's and leaves an empty map empty", async () => {
    const sql = testSql();
    const file = await Bun.file(new URL("../drizzle/0012_fx_auto.sql", import.meta.url)).text();
    const backfill = file.split("--> statement-breakpoint").find((part) => part.includes("UPDATE"));
    if (!backfill) throw new Error("no backfill statement in 0012");
    await sql`UPDATE users SET fx_rates = ${sql.json({
      USD: { rate: 57.8, setAt: SET_AT },
      EUR: { rate: 70.9, setAt: SET_AT, by: "ecb", rateDate: "2026-10-16" },
    })}`;
    await sql.unsafe(backfill);
    await sql.unsafe(backfill);
    const [row] = await sql<{ rates: unknown }[]>`SELECT fx_rates AS rates FROM users`;
    expect(row?.rates).toEqual({
      USD: { rate: 57.8, setAt: SET_AT, by: "user", rateDate: null },
      EUR: { rate: 70.9, setAt: SET_AT, by: "ecb", rateDate: "2026-10-16" },
    });
    await sql`UPDATE users SET fx_rates = '{}'::jsonb`;
    await sql.unsafe(backfill);
    const [empty] = await sql<{ rates: unknown }[]>`SELECT fx_rates AS rates FROM users`;
    expect(empty?.rates).toEqual({});
  });

  test("a zero or negative rate and a bad code are refused", async () => {
    for (const body of [{ fxRates: { USD: 0 } }, { fxRates: { USD: -1 } }, { viewCurrency: "pesos" }]) {
      const err = await json(await call("PATCH", "/settings", body), ApiErrorBody, 400);
      expect(err.error.code).toBe("invalid_input");
    }
  });

  test("lists currencies of open jobs that have no rate", async () => {
    await call("POST", "/jobs/from-paste", {
      title: "Engineer",
      company: "Euro Co",
      description: "Remote role. Pay is €4,000 per month.",
    });
    await call("POST", "/jobs/from-paste", {
      title: "Engineer",
      company: "Peso Co",
      description: "₱90,000 a month, Manila.",
    });
    const settings = await json(await call("GET", "/settings"), SettingsDto);
    expect(settings.money.missingRates).toEqual(["EUR"]);
    const after = await json(await call("PATCH", "/settings", { fxRates: { EUR: 62.1 } }), SettingsDto);
    expect(after.money.missingRates).toEqual([]);
  });
});
