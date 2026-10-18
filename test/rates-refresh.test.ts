import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createFixtureFx, FxError, type FxQuote, type FxSource, offlineFx } from "@/server/adapters/fx";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { getSettings } from "@/server/services/settings";
import { ensureBuiltinSources } from "@/server/services/sources";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, TaskDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

/*
 * Decision 67: every Refresh ends by filling rates when the gate is open (no fetch yet, 20 h after
 * a good one, 1 h after a failed one, or at once for a new currency). Sources are all off, so the
 * Refresh does nothing else, and rates come from test/fixtures/fx or from sources that throw.
 */

const FIXTURES = join(import.meta.dir, "fixtures/fx");
const T0 = Date.parse("2026-10-18T08:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const HOUR = 60;

let deps: Deps;
let app: ReturnType<typeof createApp>;
let now: Date;
let calls: number;

/** Count ECB and currency-api calls together; `source` defaults to the fixture files. */
function setFx(source: FxSource = createFixtureFx({ dir: FIXTURES })): void {
  calls = 0;
  deps.fx = {
    ecb: (view) => {
      calls++;
      return source.ecb(view);
    },
    currencyApi: (view) => {
      calls++;
      return source.currencyApi(view);
    },
  };
}

const down = (source: "ecb" | "currency-api") => async (): Promise<FxQuote> => {
  throw new FxError(source, `${source} is down.`);
};

beforeEach(async () => {
  await resetDb();
  now = at(0);
  deps = await testDeps({ clock: { now: () => now } });
  app = createApp(deps);
  setFx();
  await ensureBuiltinSources(deps);
  await testSql()`UPDATE sources SET enabled = false`;
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function jobPaidIn(currency: "USD" | "EUR"): Promise<void> {
  const res = await call("POST", "/jobs/from-paste", {
    title: "Engineer",
    company: `${currency} Co`,
    description: `Remote role. Pay is ${currency} 5,000 per month.`,
  });
  expect(res.status).toBe(201);
  AddJobResult.parse(await res.json());
}

/** Run a Refresh at `when` and return how many rate calls it made. It must always end done. */
async function refreshAt(when: Date): Promise<number> {
  now = when;
  const before = calls;
  const res = await call("POST", "/refresh");
  expect(res.status).toBe(202);
  const task = TaskDto.parse(await res.json());
  await waitForTask(task.id);
  const done = TaskDto.parse(await (await call("GET", `/tasks/${task.id}`)).json());
  expect({ status: done.status, error: done.error }).toEqual({ status: "done", error: null });
  return calls - before;
}

const rates = async () => (await getSettings(deps)).money.fxRates;

describe("Refresh fills rates", () => {
  test("the first Refresh fills the rates of open jobs", async () => {
    await jobPaidIn("USD");
    expect(await refreshAt(at(0))).toBe(1);
    expect(await rates()).toEqual([
      { currency: "USD", rate: 62.9681, setAt: at(0).toISOString(), by: "ecb", rateDate: "2026-10-16" },
    ]);
  });

  test("after a good fetch: nothing 2 hours later, one fetch 21 hours later", async () => {
    await jobPaidIn("USD");
    await refreshAt(at(0));
    expect(await refreshAt(at(2 * HOUR))).toBe(0);
    expect(await refreshAt(at(21 * HOUR))).toBe(1);
    expect((await rates())[0]?.setAt).toBe(at(21 * HOUR).toISOString());
  });

  test("a new currency 2 hours later is fetched at once", async () => {
    await jobPaidIn("USD");
    await refreshAt(at(0));
    await jobPaidIn("EUR");
    expect(await refreshAt(at(2 * HOUR))).toBe(1);
    expect((await rates()).map((r) => r.currency)).toEqual(["EUR", "USD"]);
  });

  test("after a failed fetch: nothing 30 minutes later, one fetch 61 minutes later", async () => {
    await jobPaidIn("USD");
    setFx({ ecb: down("ecb"), currencyApi: down("currency-api") });
    expect(await refreshAt(at(0))).toBe(2);
    expect(await refreshAt(at(30))).toBe(0);
    setFx();
    expect(await refreshAt(at(61))).toBe(1);
    expect((await getSettings(deps)).money.fetch).toEqual({ at: at(61).toISOString(), error: null, unsupported: [] });
  });

  test("with the sources offline the Refresh still ends done, rates stay and the error shows", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    await refreshAt(at(0));
    const before = await rates();
    expect(before).toHaveLength(2);
    setFx(offlineFx());
    await refreshAt(at(21 * HOUR));
    expect(await rates()).toEqual(before);
    const fetch = (await getSettings(deps)).money.fetch;
    expect(fetch).toMatchObject({ at: at(21 * HOUR).toISOString(), unsupported: [] });
    expect(fetch?.error).toBe("ECB rates are turned off here. currency-api is turned off here.");
  });

  test("a Refresh never touches a rate the user typed", async () => {
    await jobPaidIn("USD");
    await jobPaidIn("EUR");
    await call("PATCH", "/settings", { fxRates: { USD: 60 } });
    await refreshAt(at(0));
    await refreshAt(at(21 * HOUR));
    const list = await rates();
    expect(list.find((r) => r.currency === "USD")).toMatchObject({ rate: 60, by: "user", rateDate: null });
    expect(list.find((r) => r.currency === "EUR")).toMatchObject({ rate: 70.858, by: "ecb" });
  });
});
