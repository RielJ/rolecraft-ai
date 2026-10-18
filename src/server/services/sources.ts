import { and, asc, count, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import {
  type AddSourceInput,
  type RefreshDto,
  RefreshResult,
  type SourceDto,
  type SourceId,
  type SourceList,
  type TaskDto,
  type UpdateSourceInput,
} from "@/shared/api";
import { BUILTIN_SOURCE_KINDS, type SourceKind } from "@/shared/enums";
import { SOURCE_SITES } from "@/shared/labels";
import { boardFromUrl, SourceError } from "../adapters/sources";
import { eligibilityOverrides, jobs, opportunities, sources, tasks } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";
import { fillRatesIfDue } from "./rates";
import { runRefresh } from "./sync";
import { getTask, startTask } from "./tasks";
import { loadSkillDictionary } from "./user-skills";

/**
 * The user's side of sources: list, add a company board, toggle, keywords, delete, and start a
 * refresh. These run as the app role; only `services/sync.ts` runs as `hb_sync`.
 */

type SourceRow = typeof sources.$inferSelect;

const isBuiltin = (kind: SourceKind) => BUILTIN_SOURCE_KINDS.some((k) => k === kind);

function toSourceDto(row: SourceRow): SourceDto {
  return {
    id: row.id,
    kind: row.kind,
    board: row.board,
    label: row.label,
    enabled: row.enabled,
    keywords: row.keywords,
    builtin: isBuiltin(row.kind),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastCount: row.lastCount,
    lastDropped: row.lastDropped,
    lastError: row.lastError,
  };
}

/**
 * Insert a row for each built-in board the user does not have yet, on by default (Q10). Safe to
 * run on every start: an existing row, turned off or given keywords, is left as it is.
 */
export async function ensureBuiltinSources(deps: Pick<Deps, "db" | "userId">): Promise<void> {
  await deps.db
    .insert(sources)
    .values(
      BUILTIN_SOURCE_KINDS.map((kind) => ({ userId: deps.userId, kind, board: null, label: SOURCE_SITES[kind].name })),
    )
    .onConflictDoNothing();
}

export async function listSources(deps: Pick<Deps, "db" | "userId">): Promise<SourceList> {
  await ensureBuiltinSources(deps);
  const rows = await deps.db
    .select()
    .from(sources)
    .where(eq(sources.userId, deps.userId))
    .orderBy(asc(sources.board), asc(sources.label), asc(sources.createdAt));
  // Built-ins first (board is NULL), then company boards by label.
  const sorted = [...rows].sort((a, b) => Number(a.board !== null) - Number(b.board !== null));
  return { sources: sorted.map(toSourceDto) };
}

/**
 * Add a company board from a careers link. The board is checked with its ATS before it is
 * saved, so a typo never becomes a source that fails on every refresh.
 */
export async function addCompanyBoard(deps: Deps, { url }: AddSourceInput): Promise<SourceDto> {
  const found = boardFromUrl({ adapters: deps.sources, url });
  if (!found) {
    throw new AppError({
      code: "invalid_input",
      message:
        "This link is not a company board we can read. Paste the job list link from Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee or Workable, for example jobs.lever.co/company.",
    });
  }
  const { adapter, board } = found;
  const [existing] = await deps.db
    .select({ label: sources.label })
    .from(sources)
    .where(and(eq(sources.userId, deps.userId), eq(sources.kind, adapter.kind), eq(sources.board, board)));
  if (existing) {
    throw new AppError({
      code: "source_exists",
      message: `${existing.label} on ${adapter.name} is already one of your sources.`,
    });
  }
  let label: string;
  try {
    ({ label } = await adapter.board.check(board));
  } catch (error) {
    if (error instanceof SourceError) throw new AppError({ code: "invalid_input", message: error.message });
    throw error;
  }
  const [row] = await deps.db
    .insert(sources)
    .values({ userId: deps.userId, kind: adapter.kind, board, label })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw new AppError({
      code: "source_exists",
      message: `${label} on ${adapter.name} is already one of your sources.`,
    });
  }
  return toSourceDto(row);
}

export async function updateSource(
  deps: Pick<Deps, "db" | "userId">,
  { sourceId, input }: { sourceId: SourceId; input: UpdateSourceInput },
): Promise<SourceDto> {
  const patch: Partial<Pick<SourceRow, "enabled" | "keywords">> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.keywords !== undefined) patch.keywords = input.keywords;
  const [row] = await deps.db
    .update(sources)
    .set(patch)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, deps.userId)))
    .returning();
  if (!row) throw notFound("That source");
  return toSourceDto(row);
}

/**
 * Delete a company board. Its listings go with it; a job seen only there keeps its row and
 * closes on the next refresh's prune rules like any other. Built-ins can only be turned off.
 */
export async function deleteSource(
  deps: Pick<Deps, "db" | "userId">,
  { sourceId }: { sourceId: SourceId },
): Promise<void> {
  const [row] = await deps.db
    .select({ kind: sources.kind })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, deps.userId)));
  if (!row) throw notFound("That source");
  if (isBuiltin(row.kind)) {
    throw new AppError({ code: "invalid_input", message: "Built-in boards cannot be deleted. Turn it off instead." });
  }
  await deps.db.delete(sources).where(eq(sources.id, sourceId));
}

/** `POST /api/refresh`: start a refresh task; a second one while it runs is `409 refresh_running`. */
export async function startRefresh(deps: Deps): Promise<TaskDto> {
  await ensureBuiltinSources(deps);
  return startTask(deps, {
    kind: "refresh",
    input: {},
    // The user's skills are read here, as the app role: the sync role cannot read them (decision 66).
    run: async (ctx) => {
      const result = await runRefresh(deps, ctx, { skills: await loadSkillDictionary(deps) });
      // After the sources, so currencies from new jobs get rates in this Refresh. As the app role,
      // never under hb_sync; it never fails the Refresh (decision 67).
      await fillRatesIfDue(deps, ctx);
      return result;
    },
  });
}

/** `GET /api/refresh`: the newest refresh and, once it is done, its summary. */
export async function latestRefresh(deps: Pick<Deps, "db" | "userId">): Promise<RefreshDto> {
  const [latest] = await deps.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, deps.userId), eq(tasks.kind, "refresh")))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (!latest) return { task: null, result: null, lastRefreshedAt: null, openJobs: await openJobs(deps) };
  // Status first, result second: a task finishes with one UPDATE of both, so a task read as done
  // always has its result. The other order can see a refresh that ended in between as done with
  // no result, and the Refresh button would never sum it up.
  const task = await getTask(deps, { taskId: latest.id });
  const [row] = await deps.db.select({ result: tasks.result }).from(tasks).where(eq(tasks.id, latest.id));
  const parsed = RefreshResult.safeParse(row?.result);
  // Read after the status for the same reason: a task read as done is always counted here.
  const [lastRefreshedAt, open] = await Promise.all([lastRefreshed(deps), openJobs(deps)]);
  return { task, result: parsed.success ? parsed.data : null, lastRefreshedAt, openJobs: open };
}

/**
 * When the newest refresh that finished without failing ended: the top bar's "Refreshed 3 days
 * ago" (decision 11). A failed or interrupted refresh did not refresh the feed, so it does not
 * count; a refresh whose sources partly failed still finished.
 */
async function lastRefreshed(deps: Pick<Deps, "db" | "userId">): Promise<string | null> {
  const [row] = await deps.db
    .select({ finishedAt: tasks.finishedAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, deps.userId),
        eq(tasks.kind, "refresh"),
        eq(tasks.status, "done"),
        isNotNull(tasks.finishedAt),
      ),
    )
    .orderBy(desc(tasks.finishedAt))
    .limit(1);
  return row?.finishedAt?.toISOString() ?? null;
}

/**
 * The top bar's job count: what Matches can show before its own filters. Open jobs that are not on
 * the board or dismissed, and not excluded unless the user moved them to Matches (decision 53).
 */
async function openJobs(deps: Pick<Deps, "db" | "userId">): Promise<number> {
  const [row] = await deps.db
    .select({ n: count() })
    .from(jobs)
    .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
    .leftJoin(eligibilityOverrides, eq(eligibilityOverrides.jobId, jobs.id))
    .where(
      and(
        eq(jobs.userId, deps.userId),
        isNull(jobs.closedAt),
        isNull(opportunities.id),
        or(ne(jobs.eligibility, "excluded"), isNotNull(eligibilityOverrides.jobId)),
      ),
    );
  return row?.n ?? 0;
}
