import { beforeEach, describe, expect, test } from "bun:test";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import { AppError, type Deps } from "@/server/services/context";
import { getTask, markInterrupted, startTask, waitForTask } from "@/server/services/tasks";
import { AddJobResult, ApiErrorBody, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

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

/** A promise the test resolves by hand, to hold a task in `running`. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("startTask and getTask", () => {
  test("a task runs right away, records its step, and finishes done with its result", async () => {
    const hold = gate();
    const started = await startTask(deps, {
      kind: "draft",
      input: { n: 1 },
      run: async (ctx) => {
        await ctx.step("Halfway");
        await hold.promise;
        return { ok: 1 };
      },
    });
    expect(started).toMatchObject({ kind: "draft", status: "running", step: "", error: null, finishedAt: null });
    await Bun.sleep(5);
    expect((await getTask(deps, { taskId: started.id })).step).toBe("Halfway");

    hold.open();
    await waitForTask(started.id);
    const done = await json(await call("GET", `/tasks/${started.id}`), TaskDto);
    expect(done).toMatchObject({ status: "done", error: null });
    expect(done.finishedAt).not.toBeNull();
    const [row] = await testSql()<{ result: unknown; input: unknown }[]>`
      SELECT result, input FROM tasks WHERE id = ${started.id}`;
    expect(row).toEqual({ result: { ok: 1 }, input: { n: 1 } });
  });

  test("a failing task keeps the error message of an AppError and hides others", async () => {
    const shown = await startTask(deps, {
      kind: "draft",
      input: {},
      run: async () => {
        throw new AppError({ code: "invalid_input", message: "Shown to the user." });
      },
    });
    const hidden = await startTask(deps, {
      kind: "draft",
      input: {},
      run: async () => {
        throw new Error("secret stack detail");
      },
    });
    await Promise.all([waitForTask(shown.id), waitForTask(hidden.id)]);
    expect(await getTask(deps, { taskId: shown.id })).toMatchObject({ status: "failed", error: "Shown to the user." });
    const failed = await getTask(deps, { taskId: hidden.id });
    expect(failed.status).toBe("failed");
    expect(failed.error).not.toContain("secret");
  });

  test("only one refresh runs at a time: the second is 409 refresh_running with the running id", async () => {
    const hold = gate();
    const first = await startTask(deps, { kind: "refresh", input: {}, run: () => hold.promise });
    try {
      await startTask(deps, { kind: "refresh", input: {}, run: async () => {} });
      throw new Error("expected refresh_running");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (!(err instanceof AppError)) return;
      expect(err.code).toBe("refresh_running");
      expect(err.status).toBe(409);
      expect(err.details).toEqual({ taskId: first.id });
    }
    hold.open();
    await waitForTask(first.id);
    // Once it finished, the slot is free.
    const next = await startTask(deps, { kind: "refresh", input: {}, run: async () => {} });
    await waitForTask(next.id);
    expect((await getTask(deps, { taskId: next.id })).status).toBe("done");
  });

  test("an unknown task is 404", async () => {
    const res = await call("GET", "/tasks/00000000-0000-4000-8000-000000000000");
    expect((await json(res, ApiErrorBody, 404)).error.code).toBe("not_found");
  });
});

describe("restart and retry", () => {
  test("boot marks running tasks interrupted; a late finish does not overwrite that", async () => {
    const hold = gate();
    const task = await startTask(deps, { kind: "draft", input: {}, run: () => hold.promise });
    expect(await markInterrupted(deps.db)).toBe(1);
    expect(await getTask(deps, { taskId: task.id })).toMatchObject({ status: "interrupted" });
    hold.open();
    await waitForTask(task.id);
    expect(await getTask(deps, { taskId: task.id })).toMatchObject({ status: "interrupted" });
  });

  test("Retry starts a new draft task from the interrupted task's input", async () => {
    await call("PUT", "/profile", {
      contact: { fullName: "Juan Dela Cruz", email: "", phone: "", location: "Manila", links: [] },
    });
    await waitForSplits(
      await json(await call("PUT", "/profile/cv", { text: "- Built a payments API in Go" }), ProfileDto),
    );
    await call("POST", "/facts/confirm-all");
    await call("PUT", "/settings/ai-key", { provider: "openai", key: "sk-proj-good-key-9z8y" });
    const added = await json(
      await call("POST", "/jobs/from-paste", { title: "Engineer", company: "Acme", description: "Build APIs." }),
      AddJobResult,
      201,
    );
    const ws = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    const resume = ws.files.find((f) => f.kind === "resume");
    if (!resume) throw new Error("no resume");

    // A draft task left running by a process that died: only the row exists.
    const sql = testSql();
    const input = { opportunityId: added.opportunityId, outputIds: [resume.id] };
    const [dead] = await sql<{ id: string }[]>`
      INSERT INTO tasks (user_id, kind, status, step, input, created_at)
      VALUES (${deps.userId}, 'draft', 'running', 'Drafting resume', ${sql.json(input)}, '2026-10-16T07:00:00Z')
      RETURNING id`;
    if (!dead) throw new Error("no task row");
    expect(await markInterrupted(deps.db)).toBe(1);

    const before = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    expect(before.draftTask).toMatchObject({ id: dead.id, status: "interrupted", outputIds: [resume.id] });

    const retried = await json(await call("POST", `/tasks/${dead.id}/retry`, {}), TaskDto, 202);
    expect(retried.id).not.toBe(dead.id);
    await waitForTask(retried.id);
    expect(await getTask(deps, { taskId: retried.id })).toMatchObject({ kind: "draft", status: "done" });
    const [row] = await sql<{ input: unknown }[]>`SELECT input FROM tasks WHERE id = ${retried.id}`;
    expect(row?.input).toEqual(input);

    const after = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    expect(after.files.find((f) => f.kind === "resume")?.body).toContain("[FACT-1]");
    expect(after.draftTask).toMatchObject({ id: retried.id, status: "done" });
    // Only the resume was in the input, so only the resume was drafted.
    expect(after.files.find((f) => f.kind === "letter")?.body).toBeNull();
  });

  test("a done task cannot be retried", async () => {
    const task = await startTask(deps, { kind: "draft", input: {}, run: async () => {} });
    await waitForTask(task.id);
    const res = await call("POST", `/tasks/${task.id}/retry`, {});
    expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });
});
