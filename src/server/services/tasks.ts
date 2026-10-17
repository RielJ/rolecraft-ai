import { and, desc, eq, sql } from "drizzle-orm";
import type { TaskDto, TaskId } from "@/shared/api";
import type { TaskKind } from "@/shared/enums";
import type { Db } from "../db/client";
import { tasks } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";

/**
 * Long work (decision 36). Every task goes through `startTask` and `getTask`, so pg-boss can
 * replace this module later. Tasks run in this process right away; the row is the record the
 * UI polls, and `input` is enough to start the same work again.
 */

type TaskRow = typeof tasks.$inferSelect;

export type TaskContext = {
  taskId: TaskId;
  /** Record the current step for the UI ("Drafting resume (1 of 3)"). */
  step(text: string): Promise<void>;
};

export type TaskRun = (ctx: TaskContext) => Promise<unknown>;

const inflight = new Map<TaskId, Promise<void>>();

function toTaskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    step: row.step,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error && "cause" in err ? err.cause : err;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

function failureMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  console.error(JSON.stringify({ level: "error", msg: "task failed", error: String(err) }));
  return "Something went wrong while this ran. Try again; if it repeats, check the server log.";
}

/**
 * Insert a `running` row and start `run` without waiting for it. A second running refresh hits
 * the partial unique index and becomes `409 refresh_running` with the running task's id.
 */
export async function startTask(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { kind, input, run }: { kind: TaskKind; input: unknown; run: TaskRun },
): Promise<TaskDto> {
  let row: TaskRow;
  try {
    const [inserted] = await deps.db
      .insert(tasks)
      // created_at comes from the database clock so "latest task" ordering holds under a fixed test clock.
      .values({ userId: deps.userId, kind, input })
      .returning();
    if (!inserted) throw new Error("insert returned no row");
    row = inserted;
  } catch (err) {
    if (kind === "refresh" && isUniqueViolation(err)) {
      const [running] = await deps.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.userId, deps.userId), eq(tasks.kind, "refresh"), eq(tasks.status, "running")));
      throw new AppError({
        code: "refresh_running",
        message: "A refresh is already running. Wait for it to finish.",
        details: { taskId: running?.id ?? null },
      });
    }
    throw err;
  }

  const taskId = row.id;
  const ctx: TaskContext = {
    taskId,
    async step(text) {
      await deps.db.update(tasks).set({ step: text }).where(eq(tasks.id, taskId));
    },
  };
  const finish = async (patch: Partial<typeof tasks.$inferInsert>) => {
    // Only a running task finishes; a task marked interrupted stays that way.
    await deps.db
      .update(tasks)
      .set({ ...patch, finishedAt: deps.clock.now() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")));
  };
  const done = (async () => {
    try {
      const result = await run(ctx);
      await finish({ status: "done", result: result ?? null, step: "" });
    } catch (err) {
      await finish({ status: "failed", error: failureMessage(err) });
    }
  })().finally(() => inflight.delete(taskId));
  inflight.set(taskId, done);
  return toTaskDto(row);
}

export async function getTask(deps: Pick<Deps, "db" | "userId">, { taskId }: { taskId: TaskId }): Promise<TaskDto> {
  const [row] = await deps.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, deps.userId)));
  if (!row) throw notFound("That task");
  return toTaskDto(row);
}

/** The newest task of a kind whose input matches, for resuming progress after a reload. */
export async function latestTask(
  deps: Pick<Deps, "db" | "userId">,
  { kind, inputMatches }: { kind: TaskKind; inputMatches: Record<string, unknown> },
): Promise<{ task: TaskDto; input: unknown; result: unknown } | null> {
  const [row] = await deps.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, deps.userId),
        eq(tasks.kind, kind),
        sql`${tasks.input} @> ${JSON.stringify(inputMatches)}::jsonb`,
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return row ? { task: toTaskDto(row), input: row.input, result: row.result } : null;
}

/** On boot: anything still `running` died with the previous process (decision 36). */
export async function markInterrupted(db: Db): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ status: "interrupted", finishedAt: sql`now()` })
    .where(eq(tasks.status, "running"))
    .returning({ id: tasks.id });
  return rows.length;
}

/** How a kind starts again from its stored `input`. */
export type RetryHandler = (input: unknown, options: { confirmOverCap: boolean }) => Promise<TaskDto>;

/**
 * Retry a failed or interrupted task by starting a new one from its `input`. Each kind's
 * handler is passed in by the caller, so this module never imports the services it runs.
 */
export async function retryTask(
  deps: Pick<Deps, "db" | "userId">,
  {
    taskId,
    confirmOverCap,
    handlers,
  }: { taskId: TaskId; confirmOverCap: boolean; handlers: Partial<Record<TaskKind, RetryHandler>> },
): Promise<TaskDto> {
  const [row] = await deps.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, deps.userId)));
  if (!row) throw notFound("That task");
  if (row.status === "running" || row.status === "done") {
    throw new AppError({ code: "invalid_input", message: "Only a failed or interrupted task can be retried." });
  }
  const handler = handlers[row.kind];
  if (!handler) {
    throw new AppError({ code: "invalid_input", message: "This kind of task cannot be retried here." });
  }
  return handler(row.input, { confirmOverCap });
}

/** Wait until a started task settles. Tests use it; the UI polls `getTask` instead. */
export async function waitForTask(taskId: TaskId): Promise<void> {
  await inflight.get(taskId);
}
