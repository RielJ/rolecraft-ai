import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { boardMetrics } from "@/domain/metrics";
import { type FxRates, monthlyInView, payFromColumns } from "@/domain/pay";
import type {
  BoardItemDto,
  BoardMetricsDto,
  ChangeStatusInput,
  OpportunityId,
  UpdateOpportunityInput,
  WorkspaceDto,
} from "@/shared/api";
import { FROZEN_STATUSES, MUST_ANSWERS, type OpportunityStatus, type OpportunityType } from "@/shared/enums";
import { FOLLOW_UP_DAYS } from "@/shared/labels";
import type { DbOrTx } from "../db/client";
import { type HistoryEntry, jobs, opportunities, outputs, users } from "../db/schema";
import { AppError, type Clock, type Deps, notFound } from "./context";
import { loadContact } from "./profile";
import { latestTask } from "./tasks";
import { contractTerms, getWorkspace, isReady } from "./workspace";

const DAY_MS = 24 * 60 * 60 * 1000;

const isFrozen = (status: OpportunityStatus | null): boolean => FROZEN_STATUSES.some((s) => s === status);

/** The quiet "follow up or close?" hint: Applied with no change for FOLLOW_UP_DAYS or more (decision 18). */
export function followUp({
  status,
  statusChangedAt,
  clock,
}: {
  status: OpportunityStatus;
  statusChangedAt: Date;
  clock: Clock;
}): { days: number } | null {
  if (status !== "applied") return null;
  const days = Math.floor((clock.now().getTime() - statusChangedAt.getTime()) / DAY_MS);
  return days >= FOLLOW_UP_DAYS ? { days } : null;
}

async function boardRows(deps: Deps, opportunityId?: OpportunityId) {
  return deps.db
    .select({
      opportunity: opportunities,
      title: jobs.title,
      company: jobs.company,
      postedAt: jobs.postedAt,
      firstSeenAt: jobs.firstSeenAt,
      eligibility: jobs.eligibility,
      locationText: jobs.locationText,
      payMin: jobs.payMin,
      payMax: jobs.payMax,
      payCurrency: jobs.payCurrency,
      payPeriod: jobs.payPeriod,
      payPhrase: jobs.payPhrase,
    })
    .from(opportunities)
    .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
    .where(
      and(
        eq(opportunities.userId, deps.userId),
        isNotNull(opportunities.status),
        opportunityId === undefined ? undefined : eq(opportunities.id, opportunityId),
      ),
    )
    .orderBy(desc(opportunities.statusChangedAt), desc(opportunities.createdAt));
}

/** The view currency and rates, read once per request, so card pay matches Matches. */
type PayView = { viewCurrency: string; rates: FxRates };

async function loadPayView(deps: Deps): Promise<PayView> {
  const [user] = await deps.db
    .select({ viewCurrency: users.viewCurrency, fxRates: users.fxRates })
    .from(users)
    .where(eq(users.id, deps.userId));
  if (!user) throw notFound("Your profile");
  return {
    viewCurrency: user.viewCurrency,
    rates: Object.fromEntries(Object.entries(user.fxRates).map(([code, e]) => [code, e.rate])),
  };
}

/** Compact monthly pay in the view currency, else the posting's own words, as Matches shows it. */
function cardPay(row: Awaited<ReturnType<typeof boardRows>>[number], view: PayView): string | null {
  const pay = payFromColumns(row);
  if (pay === null) return null;
  return monthlyInView({ pay, ...view, compact: true }) ?? row.payPhrase ?? null;
}

async function toBoardItem(
  deps: Deps,
  row: Awaited<ReturnType<typeof boardRows>>[number],
  view: PayView,
): Promise<BoardItemDto | null> {
  const { opportunity: o, title, company, postedAt, firstSeenAt } = row;
  if (o.status === null) return null;
  const statusChangedAt = o.statusChangedAt ?? o.createdAt;
  return {
    opportunityId: o.id,
    type: o.type,
    status: o.status,
    outcome: o.outcome,
    title,
    company,
    savedAt: o.createdAt.toISOString(),
    postedAt: postedAt?.toISOString() ?? null,
    firstSeenAt: firstSeenAt.toISOString(),
    statusChangedAt: statusChangedAt.toISOString(),
    eligibility: row.eligibility,
    locationText: row.locationText,
    pay: cardPay(row, view),
    ready: await isReady(deps, { opportunityId: o.id }),
    drafting: await draftingState(deps, o.id),
    notes: o.notes,
    contract: contractTerms(o),
    followUp: followUp({ status: o.status, statusChangedAt, clock: deps.clock }),
  };
}

/** A running or failed draft, for the card; a finished, interrupted or absent one is null. */
async function draftingState(deps: Deps, opportunityId: OpportunityId): Promise<BoardItemDto["drafting"]> {
  const latest = await latestTask(deps, { kind: "draft", inputMatches: { opportunityId } });
  const status = latest?.task.status;
  return status === "running" || status === "failed" ? status : null;
}

/** Everything on the board, most recently moved first. Columns are grouped by the SPA. */
export async function listBoard(deps: Deps): Promise<BoardItemDto[]> {
  const items: BoardItemDto[] = [];
  const view = await loadPayView(deps);
  for (const row of await boardRows(deps)) {
    const item = await toBoardItem(deps, row, view);
    if (item) items.push(item);
  }
  return items;
}

/**
 * The Board's metrics line (decision 52): every opportunity's dated status history and Ready time,
 * read by `src/domain/metrics.ts` at the injected clock's now. Dismissed rows keep their history,
 * so a job applied to and later moved off the board still counts.
 */
export async function getBoardMetrics(deps: Deps): Promise<BoardMetricsDto> {
  const rows = await deps.db
    .select({ history: opportunities.history, readyAt: opportunities.readyAt })
    .from(opportunities)
    .where(eq(opportunities.userId, deps.userId));
  return boardMetrics({
    now: deps.clock.now(),
    opportunities: rows.map(({ history, readyAt }) => ({
      history: history.map((entry) => ({ at: new Date(entry.at), to: entry.to })),
      readyAt,
    })),
  });
}

async function boardItem(deps: Deps, opportunityId: OpportunityId): Promise<BoardItemDto> {
  const [row] = await boardRows(deps, opportunityId);
  const item = row ? await toBoardItem(deps, row, await loadPayView(deps)) : null;
  if (!item) throw notFound("That job");
  return item;
}

/**
 * Applying freezes what was sent (section 3.5): copy each resolved standard answer into the
 * must-answer bodies that still lean on the profile, so later profile edits cannot change them.
 */
async function copyStandardAnswers(tx: DbOrTx, deps: Deps, opportunityId: OpportunityId): Promise<void> {
  const { standardAnswers } = await loadContact(deps);
  for (const category of MUST_ANSWERS) {
    const answer = standardAnswers[category]?.trim();
    if (!answer) continue;
    await tx
      .update(outputs)
      .set({ body: answer })
      .where(and(eq(outputs.opportunityId, opportunityId), eq(outputs.mustAnswer, category), isNull(outputs.body)));
  }
}

/**
 * Move an opportunity on the board (decision 17). Every change appends to `history` and sets
 * `status_changed_at`. Moving from Saved to Applied or later writes `applied_snapshot` and copies
 * standard answers, which freezes files and answers (decision 26). Moving back to Saved unfreezes
 * them; the snapshot stays until the next apply replaces it.
 */
export async function changeStatus(
  deps: Deps,
  { opportunityId, ...input }: { opportunityId: OpportunityId } & ChangeStatusInput,
): Promise<BoardItemDto> {
  const outcome = input.status === "closed" ? input.outcome : null;
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ opportunity: opportunities, job: jobs })
      .from(opportunities)
      .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)))
      .for("update", { of: opportunities });
    if (!row) throw notFound("That job");
    const { opportunity: current, job } = row;
    if (current.status === null) {
      throw new AppError({
        code: "invalid_input",
        message: "This job was dismissed, so it is not on the board. Save it again first.",
      });
    }
    if (current.status === input.status && current.outcome === outcome) return;

    const now = deps.clock.now();
    const entry: HistoryEntry = {
      at: now.toISOString(),
      from: current.status,
      to: input.status,
      ...(outcome === null ? {} : { outcome }),
    };
    const applying = !isFrozen(current.status) && isFrozen(input.status);
    await tx
      .update(opportunities)
      .set({
        status: input.status,
        outcome,
        statusChangedAt: now,
        history: sql`${opportunities.history} || ${JSON.stringify([entry])}::jsonb`,
        ...(applying
          ? {
              appliedSnapshot: {
                title: job.title,
                company: job.company,
                description: job.description,
                applyUrl: job.applyUrl,
                at: now.toISOString(),
              },
            }
          : {}),
      })
      .where(eq(opportunities.id, opportunityId));
    if (applying) await copyStandardAnswers(tx, deps, opportunityId);
  });
  return boardItem(deps, opportunityId);
}

/** Blank text means "not set". */
function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Notes, job or contract, and contract terms (decisions 16, 18). None of these are files or
 * answers, so they stay editable after applying. Switching to a job clears the terms.
 */
export async function updateOpportunity(
  deps: Deps,
  { opportunityId, notes, type, contract }: { opportunityId: OpportunityId } & UpdateOpportunityInput,
): Promise<WorkspaceDto> {
  const [current] = await deps.db
    .select({ type: opportunities.type })
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  if (!current) throw notFound("That job");
  const nextType: OpportunityType = type ?? current.type;
  if (nextType === "job" && contract !== undefined) {
    throw new AppError({
      code: "invalid_input",
      message: "Jobs have no rate or platform. Switch it to a contract first.",
    });
  }

  const patch: Partial<typeof opportunities.$inferInsert> = {};
  if (notes !== undefined) patch.notes = notes;
  if (type !== undefined) patch.type = type;
  if (nextType === "job") {
    Object.assign(patch, { rateAmount: null, rateType: null, rateCurrency: null, platform: null });
  } else if (contract !== undefined) {
    if (contract.rateAmount !== undefined) {
      patch.rateAmount = contract.rateAmount === null ? null : contract.rateAmount.toFixed(2);
    }
    if (contract.rateType !== undefined) patch.rateType = contract.rateType;
    const currency = blankToNull(contract.rateCurrency);
    if (currency !== undefined) patch.rateCurrency = currency === null ? null : currency.toUpperCase();
    const platform = blankToNull(contract.platform);
    if (platform !== undefined) patch.platform = platform;
  }
  await deps.db.update(opportunities).set(patch).where(eq(opportunities.id, opportunityId));
  return getWorkspace(deps, { opportunityId });
}
