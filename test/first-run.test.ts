import { beforeEach, describe, expect, test } from "bun:test";
import { createHttpClient } from "@/server/adapters/http";
import { createDb } from "@/server/db/client";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { HealthDto, ProfileDto, SetupDto, type SetupStepId, TaskDto } from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Slice 11: `GET /api/setup` derives each checklist step from data (section 4, Setup checklist),
 * and `GET /api/health` answers only when Postgres does.
 */

let deps: Deps;
let app: ReturnType<typeof createApp>;

// Every source answers with an empty list, so a refresh finishes without touching the network.
const emptyFeeds = createHttpClient({
  fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  sleep: async () => {},
});

beforeEach(async () => {
  await resetDb();
  deps = await testDeps({ http: emptyFeeds });
  app = createApp(deps);
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function ok<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

async function setup(): Promise<SetupDto> {
  return ok(await call("GET", "/setup"), SetupDto);
}

const doneSteps = (s: SetupDto): SetupStepId[] => s.steps.filter((step) => step.done).map((step) => step.id);

describe("GET /api/setup", () => {
  test("a fresh database has every step undone except sources, which are on by default", async () => {
    const s = await setup();
    expect(s.steps.map((step) => step.id)).toEqual(["ai", "cv", "facts", "preferences", "sources", "first_refresh"]);
    // The five built-ins are seeded on (Q10), so the sources step starts done.
    expect(doneSteps(s)).toEqual(["sources"]);
    expect(s).toMatchObject({ done: false, aiVia: "key", refreshStarted: false });
  });

  test("each step ticks itself from data, and all done hides the checklist", async () => {
    await ok(await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-test-key-ABCD" }), {
      parse: (v) => v,
    });
    expect(doneSteps(await setup())).toEqual(["ai", "sources"]);

    const profile = await ok(
      await call("PUT", "/profile/cv", { text: "- Built a React Native app used by 40,000 riders." }),
      ProfileDto,
    );
    await waitForSplits(profile);
    expect(doneSteps(await setup())).toEqual(["ai", "cv", "sources"]);

    await ok(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(doneSteps(await setup())).toEqual(["ai", "cv", "facts", "sources"]);

    // Titles alone are not enough: the role filter needs families too (section 3.7a).
    await ok(await call("PUT", "/profile", { targeting: { targetTitles: ["Frontend Engineer"] } }), ProfileDto);
    expect(doneSteps(await setup())).not.toContain("preferences");
    await ok(await call("PUT", "/profile", { targeting: { roleFamilies: ["engineering"] } }), ProfileDto);
    expect(doneSteps(await setup())).toContain("preferences");

    const task = await ok(await call("POST", "/refresh"), TaskDto, 202);
    expect((await setup()).refreshStarted).toBe(true);
    await waitForTask(task.id);
    const all = await setup();
    expect(all.steps.every((step) => step.done)).toBe(true);
    expect(all.done).toBe(true);
  });

  test("a pending fact means the facts step is not done", async () => {
    const profile = await ok(
      await call("PUT", "/profile/cv", { text: "- Led a team of four.\n- Shipped a design system." }),
      ProfileDto,
    );
    await waitForSplits(profile);
    const [first] = (await ok(await call("GET", "/profile"), ProfileDto)).facts;
    if (!first) throw new Error("the split made no facts");
    await ok(await call("POST", `/facts/${first.id}/confirm`), ProfileDto);
    expect(doneSteps(await setup())).not.toContain("facts");
  });

  test("turning every source off undoes the sources step", async () => {
    await call("GET", "/sources");
    await testSql()`UPDATE sources SET enabled = false`;
    expect(doneSteps(await setup())).not.toContain("sources");
  });

  test("a failed first refresh counts as started but not done", async () => {
    await testSql()`
      INSERT INTO tasks (user_id, kind, status, input, error, finished_at)
      VALUES (${deps.userId}, 'refresh', 'failed', '{}', 'boom', now())`;
    const s = await setup();
    expect(s.refreshStarted).toBe(true);
    expect(doneSteps(s)).not.toContain("first_refresh");
  });

  test("with the pi runner the AI step needs no key", async () => {
    const pi = await testDeps({ aiSource: { kind: "pi", models: { light: "claude-haiku-5-5", writing: "x" } } });
    const s = await ok(await createApp(pi).request("/api/setup"), SetupDto);
    expect(s.aiVia).toBe("pi");
    expect(doneSteps(s)).toContain("ai");
  });
});

describe("GET /api/health", () => {
  test("answers ok when Postgres does", async () => {
    expect(await ok(await call("GET", "/health"), HealthDto)).toEqual({ ok: true, db: "ok" });
  });

  test("answers 503 when Postgres does not", async () => {
    // Nothing listens on port 1, so every query fails to connect.
    const nowhere = createDb({ url: "postgres://hanapbuhay:hanapbuhay@127.0.0.1:1/hanapbuhay", max: 1 });
    try {
      const broken = createApp({ ...deps, db: nowhere.db });
      expect(await ok(await broken.request("/api/health"), HealthDto, 503)).toEqual({ ok: false, db: "unreachable" });
    } finally {
      await nowhere.close();
    }
  });
});
