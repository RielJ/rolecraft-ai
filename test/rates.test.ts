import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createFixtureFx, FxError, type FxQuote, type FxSource } from "@/server/adapters/fx";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { fillRates } from "@/server/services/rates";
import { getSettings } from "@/server/services/settings";
import { AddJobResult, ApiErrorBody, FillRatesResponse, SettingsDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Decision 67: Fill rates. Rate sources here are the recorded bodies in test/fixtures/fx (ECB on
 * 16 Oct, currency-api on 18 Oct) or sources that throw, so nothing reaches the network.
 */

const FIXTURES = join(import.meta.dir, "fixtures/fx");
const NOW = "2026-10-18T08:00:00.000Z";
const ECB_DAY = "2026-10-16";
const CA_DAY = "2026-10-18";

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;
let calls: { ecb: number; currencyApi: number };

const down = (source: "ecb" | "currency-api") => async (): Promise<FxQuote> => {
  throw new FxError(source, `${source} is down.`);
};

/** Fixture sources with call counts; `over` swaps either source. */
function setFx(over: Partial<FxSource> = {}): void {
  const base = createFixtureFx({ dir: FIXTURES });
  const fx: FxSource = { ...base, ...over };
  calls = { ecb: 0, currencyApi: 0 };
  deps.fx = {
    ecb: (view) => {
      calls.ecb++;
      return fx.ecb(view);
    },
    currencyApi: (view) => {
      calls.currencyApi++;
      return fx.currencyApi(view);
    },
  };
}

beforeEach(async () => {
  await resetDb();
  deps = await testDeps({ clock: { now: () => new Date(NOW) } });
  app = createApp(deps);
  setFx();
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

/** An open job paid in `currency`. Codes the pay parser does not know are set in SQL. */
async function jobPaidIn(currency: string): Promise<void> {
  const company = `${currency} Co`;
  await json(
    await call("POST", "/jobs/from-paste", {
      title: "Engineer",
      company,
      description: "Remote role. Pay is USD 5,000 per month.",
    }),
    AddJobResult,
    201,
  );
  if (currency !== "USD") await testSql()`UPDATE jobs SET pay_currency = ${currency} WHERE company = ${company}`;
}

const rateOf = async (currency: string) =>
  (await getSettings(deps)).money.fxRates.find((r) => r.currency === currency) ?? null;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("filling", () => {
  test("fills from the ECB with its rate date and the fetch time", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    expect((await getSettings(deps)).money.missingRates).toEqual(["EUR", "USD"]);
    const fill = await fillRates(deps);
    expect(fill).toEqual({
      filled: [
        { currency: "EUR", rate: 70.858, by: "ecb" },
        { currency: "USD", rate: 62.9681, by: "ecb" },
      ],
      kept: [],
      unsupported: [],
      unavailable: [],
      viewChanged: false,
    });
    const settings = await getSettings(deps);
    expect(settings.money.fxRates).toEqual([
      { currency: "EUR", rate: 70.858, setAt: NOW, by: "ecb", rateDate: ECB_DAY },
      { currency: "USD", rate: 62.9681, setAt: NOW, by: "ecb", rateDate: ECB_DAY },
    ]);
    expect(settings.money.missingRates).toEqual([]);
    expect(settings.money.fetch).toEqual({ at: NOW, error: null, unsupported: [] });
    expect(calls).toEqual({ ecb: 1, currencyApi: 0 });
  });

  test("a rate the user typed is kept; once removed, the next fill sets it", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    await call("PATCH", "/settings", { fxRates: { USD: 60 } });
    const fill = await fillRates(deps);
    expect(fill.kept).toEqual(["USD"]);
    expect(fill.filled.map((f) => f.currency)).toEqual(["EUR"]);
    expect(await rateOf("USD")).toMatchObject({ rate: 60, by: "user", rateDate: null });

    await call("PATCH", "/settings", { fxRates: { USD: null } });
    const again = await fillRates(deps);
    expect(again.kept).toEqual([]);
    expect(await rateOf("USD")).toMatchObject({ rate: 62.9681, by: "ecb", rateDate: ECB_DAY });
  });

  test("currencies the ECB lacks come from currency-api", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("VND");
    const fill = await fillRates(deps);
    expect(fill.filled).toEqual([
      { currency: "USD", rate: 62.9681, by: "ecb" },
      { currency: "VND", rate: 0.00243447, by: "currency-api" },
    ]);
    expect(await rateOf("VND")).toMatchObject({ by: "currency-api", rateDate: CA_DAY, setAt: NOW });
    expect(calls).toEqual({ ecb: 1, currencyApi: 1 });
  });

  test("when the ECB fails, every currency comes from currency-api and that is not an error", async () => {
    setFx({ ecb: down("ecb") });
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    const fill = await fillRates(deps);
    expect(fill.filled.map((f) => [f.currency, f.by])).toEqual([
      ["EUR", "currency-api"],
      ["USD", "currency-api"],
    ]);
    expect(fill.unavailable).toEqual([]);
    expect((await getSettings(deps)).money.fetch).toEqual({ at: NOW, error: null, unsupported: [] });
  });

  test("a min pay currency is filled, since the pay filter needs it", async () => {
    const sql = testSql();
    await sql`UPDATE users SET min_pay = ${sql.json({ amount: 3000, currency: "GBP", period: "month" })}`;
    expect((await getSettings(deps)).money.missingRates).toEqual(["GBP"]);
    const fill = await fillRates(deps);
    expect(fill.filled).toEqual([{ currency: "GBP", rate: 83.9699, by: "ecb" }]);
  });

  test("a fetched rate no job needs any more is still updated", async () => {
    const sql = testSql();
    const old = { rate: 50, setAt: "2026-10-01T00:00:00.000Z", by: "ecb", rateDate: "2026-09-30" };
    await sql`UPDATE users SET fx_rates = ${sql.json({ SEK: old })}`;
    const fill = await fillRates(deps);
    expect(fill.filled).toEqual([{ currency: "SEK", rate: 6.35783, by: "ecb" }]);
  });
});

describe("failures", () => {
  test("a currency no source publishes is listed, stays missing and is remembered", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("XTS");
    const fill = await fillRates(deps);
    expect(fill.unsupported).toEqual(["XTS"]);
    expect(fill.filled.map((f) => f.currency)).toEqual(["USD"]);
    const settings = await getSettings(deps);
    expect(settings.money.missingRates).toEqual(["XTS"]);
    expect(settings.money.fetch).toEqual({ at: NOW, error: null, unsupported: ["XTS"] });
  });

  test("partial: currency-api fails, so its currencies are unavailable and the error is kept", async () => {
    setFx({ currencyApi: down("currency-api") });
    await jobPaidIn("USD");
    await jobPaidIn("VND");
    const fill = await fillRates(deps);
    expect(fill.filled.map((f) => f.currency)).toEqual(["USD"]);
    expect(fill.unavailable).toEqual(["VND"]);
    expect((await getSettings(deps)).money.fetch).toEqual({ at: NOW, error: "currency-api is down.", unsupported: [] });
  });

  test("total: both sources fail, so it is a 503, rates stay and the attempt is recorded", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    await fillRates(deps);
    const before = (await getSettings(deps)).money.fxRates;
    setFx({ ecb: down("ecb"), currencyApi: down("currency-api") });
    const err = await json(await call("POST", "/settings/rates/fill"), ApiErrorBody, 503);
    expect(err.error).toEqual({ code: "rates_unavailable", message: "ecb is down. currency-api is down." });
    const settings = await getSettings(deps);
    expect(settings.money.fxRates).toEqual(before);
    expect(settings.money.fetch).toEqual({ at: NOW, error: "ecb is down. currency-api is down.", unsupported: [] });
  });

  test("nothing needed makes no call and records nothing", async () => {
    const fill = await fillRates(deps);
    expect(fill).toEqual({ filled: [], kept: [], unsupported: [], unavailable: [], viewChanged: false });
    expect(calls).toEqual({ ecb: 0, currencyApi: 0 });
    expect((await getSettings(deps)).money.fetch).toBeNull();
  });

  test("only typed rates needed makes no call", async () => {
    await jobPaidIn("USD");
    await call("PATCH", "/settings", { fxRates: { USD: 60 } });
    expect((await fillRates(deps)).kept).toEqual(["USD"]);
    expect(calls).toEqual({ ecb: 0, currencyApi: 0 });
  });
});

describe("while a fill is in flight", () => {
  /** Fixture sources whose ECB answer waits for `release`; `started` resolves once it is asked. */
  function heldEcb() {
    const started = deferred();
    const release = deferred();
    const base = createFixtureFx({ dir: FIXTURES });
    setFx({
      ecb: async (view) => {
        started.resolve();
        await release.promise;
        return base.ecb(view);
      },
    });
    return { started: started.promise, release: release.resolve };
  }

  test("a view currency change writes nothing", async () => {
    await jobPaidIn("USD");
    const held = heldEcb();
    const filling = fillRates(deps);
    await held.started;
    await call("PATCH", "/settings", { viewCurrency: "SGD" });
    held.release();
    expect(await filling).toMatchObject({ filled: [], viewChanged: true });
    const settings = await getSettings(deps);
    expect(settings.money).toMatchObject({ viewCurrency: "SGD", fxRates: [], fetch: null });
  });

  test("a rate the user types wins", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    const held = heldEcb();
    const filling = fillRates(deps);
    await held.started;
    await call("PATCH", "/settings", { fxRates: { USD: 60 } });
    held.release();
    const fill = await filling;
    expect(fill.kept).toEqual(["USD"]);
    expect(fill.filled.map((f) => f.currency)).toEqual(["EUR"]);
    expect(await rateOf("USD")).toMatchObject({ rate: 60, by: "user" });
  });

  test("two fills at once share one fetch", async () => {
    await jobPaidIn("USD");
    const held = heldEcb();
    const first = fillRates(deps);
    const second = fillRates(deps);
    await held.started;
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(calls.ecb).toBe(1);
  });
});

describe("POST /api/settings/rates/fill", () => {
  test("returns the settings and what the fill did", async () => {
    await jobPaidIn("USD");
    const res = await json(await call("POST", "/settings/rates/fill"), FillRatesResponse);
    expect(res.fill.filled).toEqual([{ currency: "USD", rate: 62.9681, by: "ecb" }]);
    expect(SettingsDto.parse(res.settings).money.fxRates).toEqual([
      { currency: "USD", rate: 62.9681, setAt: NOW, by: "ecb", rateDate: ECB_DAY },
    ]);
  });
});
