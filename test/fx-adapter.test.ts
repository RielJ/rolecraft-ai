import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createFixtureFx,
  createFxSource,
  currencyApiUrls,
  FRANKFURTER_URL,
  FxError,
  offlineFx,
} from "@/server/adapters/fx";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { parseEnv } from "@/server/env";

/*
 * Decision 67's rate sources over recorded bodies. The fake fetch serves test/fixtures/fx and
 * throws on any other URL, so nothing here reaches the network.
 */

const FIXTURES = join(import.meta.dir, "fixtures/fx");
const [JSDELIVR, PAGES_DEV] = currencyApiUrls("PHP");
const fixture = (name: string) => Bun.file(join(FIXTURES, name)).text();
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

/** A fetch that answers only the listed URLs, in order per URL, and records every call. */
function fakeFetch(routes: Record<string, (() => Promise<Response>)[]>) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const next = routes[url]?.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return next();
  };
  return { fx: createFxSource(createHttpClient({ fetch, sleep: async () => {} })), calls };
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("ECB through Frankfurter", () => {
  test("crosses the EUR table: USD is 62.9681 PHP on 16 Oct", async () => {
    const { fx, calls } = fakeFetch({
      [FRANKFURTER_URL]: [async () => json(await fixture("frankfurter-latest.json"))],
    });
    const quote = await fx.ecb("PHP");
    expect(quote).toMatchObject({ by: "ecb", rateDate: "2026-10-16" });
    expect(quote.rates.USD).toBe(62.9681);
    expect(quote.rates.EUR).toBe(70.858);
    expect(quote.rates.PHP).toBeUndefined();
    expect(calls).toEqual([FRANKFURTER_URL]);
  });

  test("a view currency the ECB does not publish throws", async () => {
    const { fx } = fakeFetch({ [FRANKFURTER_URL]: [async () => json(await fixture("frankfurter-latest.json"))] });
    const err = await caught(() => fx.ecb("VND"));
    expect(err).toBeInstanceOf(FxError);
    expect(err).toMatchObject({ source: "ecb", message: "The ECB publishes no rate for VND." });
  });

  test("an HTML page or malformed JSON is an FxError", async () => {
    for (const body of ["<html><body>Down for maintenance</body></html>", '{"base":"EUR","rates":{"USD":"x"}}']) {
      const { fx } = fakeFetch({ [FRANKFURTER_URL]: [async () => json(body)] });
      const err = await caught(() => fx.ecb("PHP"));
      expect(err).toBeInstanceOf(FxError);
      expect(err).toMatchObject({ source: "ecb", message: "Frankfurter sent ECB rates the app could not read." });
    }
  });
});

describe("currency-api", () => {
  test("inverts the PHP table with uppercase keys, and skips crypto and the view currency", async () => {
    const { fx } = fakeFetch({ [JSDELIVR]: [async () => json(await fixture("currency-api-php.json"))] });
    const quote = await fx.currencyApi("PHP");
    expect(quote.by).toBe("currency-api");
    expect(quote.rateDate).toBe("2026-10-18");
    expect(quote.rates.USD).toBeCloseTo(62.99, 1);
    expect(quote.rates.VND).toBe(0.00243447);
    expect(Object.keys(quote.rates).every((k) => /^[A-Z]{3}$/.test(k))).toBe(true);
    expect(quote.rates.PHP).toBeUndefined();
    expect(quote.rates.BTC).toBeUndefined();
  });

  test("jsDelivr answering 503 three times falls back to the pages.dev mirror", async () => {
    const unavailable = async () => json("", 503);
    const { fx, calls } = fakeFetch({
      [JSDELIVR]: [unavailable, unavailable, unavailable],
      [PAGES_DEV]: [async () => json(await fixture("currency-api-php.json"))],
    });
    const quote = await fx.currencyApi("PHP");
    expect(quote.rates.VND).toBe(0.00243447);
    expect(calls).toEqual([JSDELIVR, JSDELIVR, JSDELIVR, PAGES_DEV]);
  });

  test("junk from jsDelivr also falls back to the mirror", async () => {
    const { fx } = fakeFetch({
      [JSDELIVR]: [async () => json("<!doctype html><p>Bandwidth exceeded</p>")],
      [PAGES_DEV]: [async () => json(await fixture("currency-api-php.json"))],
    });
    expect((await fx.currencyApi("PHP")).rates.VND).toBe(0.00243447);
  });

  test("both answering 404 is an FxError from currency-api", async () => {
    const { fx } = fakeFetch({ [JSDELIVR]: [async () => json("", 404)], [PAGES_DEV]: [async () => json("", 404)] });
    const err = await caught(() => fx.currencyApi("PHP"));
    expect(err).toBeInstanceOf(FxError);
    expect(err).toMatchObject({
      source: "currency-api",
      message: "Could not get rates from currency-api. The site answered 404.",
    });
  });

  test("a body without the view currency's table is an FxError", async () => {
    const body = JSON.stringify({ date: "2026-10-18", usd: { php: 62.99 } });
    const { fx } = fakeFetch({ [JSDELIVR]: [async () => json(body)], [PAGES_DEV]: [async () => json(body)] });
    expect(await caught(() => fx.currencyApi("PHP"))).toMatchObject({ source: "currency-api" });
  });
});

describe("offline and fixture sources", () => {
  test("offlineFx rejects both sources", async () => {
    const fx = offlineFx();
    expect(await caught(() => fx.ecb("PHP"))).toMatchObject({ source: "ecb" });
    expect(await caught(() => fx.currencyApi("PHP"))).toMatchObject({ source: "currency-api" });
  });

  test("the fixture source reads test/fixtures/fx", async () => {
    const fx = createFixtureFx({ dir: FIXTURES });
    expect((await fx.ecb("PHP")).rates.USD).toBe(62.9681);
    expect((await fx.currencyApi("PHP")).rates.VND).toBe(0.00243447);
  });

  test("HB_FX defaults to live, and HB_FX_DIR's default is the fixtures directory", async () => {
    const env = parseEnv({});
    expect(env.HB_FX).toBe("live");
    expect(parseEnv({ HB_FX: "fixture" }).HB_FX).toBe("fixture");
    expect(() => parseEnv({ HB_FX: "offline" })).toThrow();
    const fx = createFixtureFx({ dir: join(import.meta.dir, "..", env.HB_FX_DIR) });
    expect((await fx.ecb("PHP")).rateDate).toBe("2026-10-16");
  });

  test("an empty fixture directory fails like an unreachable site", async () => {
    const fx = createFixtureFx({ dir: join(FIXTURES, "does-not-exist") });
    expect(await caught(() => fx.ecb("PHP"))).toMatchObject({
      source: "ecb",
      message: "Could not get ECB rates from Frankfurter. The site could not be reached.",
    });
    expect(await caught(() => fx.currencyApi("PHP"))).toBeInstanceOf(FxError);
  });
});
