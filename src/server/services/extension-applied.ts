import { and, eq } from "drizzle-orm";
import { FROZEN_STATUSES, type OpportunityStatus } from "@/shared/enums";
import type { ApplicationSessionId, ConfirmAppliedResult, PairingId } from "@/shared/extension";
import { applicationSessions, opportunities } from "../db/schema";
import { changeStatus } from "./board";
import { AppError, type Deps, notFound } from "./context";
import { completeSession, requireClaimedSession } from "./extension-sessions";

// confirm-applied (docs/EXTENSION.md). The panel calls it only after the
// user answers Yes to "Did you submit this application?". It moves the opportunity to Applied
// through the board's `changeStatus` (history, applied snapshot, frozen standard answers) and
// completes the session in one transaction: `changeStatus` runs on the transaction handle, so its
// own transaction becomes a savepoint, and a failure (say, a dismissed job) leaves the session
// claimed for a retry.
//
// Idempotency: only this call completes sessions, so a completed session held by this pairing
// whose opportunity is Applied or later is a replay of a confirm that already succeeded. It
// answers the current status with `changed: false` instead of the session_expired error
// `requireClaimedSession` raises for completed rows.

const isAppliedOrLater = (status: OpportunityStatus | null): status is OpportunityStatus =>
  FROZEN_STATUSES.some((s) => s === status);

/**
 * The already-applied answer for a session this pairing completed, or null when the session is
 * not completed by it or the opportunity has since moved back to Saved (or off the board).
 */
async function completedReplay(
  deps: Pick<Deps, "db" | "userId">,
  { id, pairingId }: { id: ApplicationSessionId; pairingId: PairingId },
): Promise<ConfirmAppliedResult | null> {
  const [row] = await deps.db
    .select({ opportunityId: opportunities.id, status: opportunities.status })
    .from(applicationSessions)
    .innerJoin(opportunities, eq(opportunities.id, applicationSessions.opportunityId))
    .where(
      and(
        eq(applicationSessions.id, id),
        eq(applicationSessions.userId, deps.userId),
        eq(applicationSessions.status, "completed"),
        eq(applicationSessions.claimedByPairingId, pairingId),
      ),
    );
  if (!row || !isAppliedOrLater(row.status)) return null;
  return { opportunityId: row.opportunityId, status: row.status, changed: false };
}

const isSessionExpired = (error: unknown): boolean => error instanceof AppError && error.code === "session_expired";

/**
 * Mark the session's opportunity Applied and complete the session. A job already Applied or later
 * keeps its status (`changed: false`), so a late confirm never moves Interviewing back to Applied.
 * A repeat for a session this pairing completed returns the already-applied result.
 */
export async function confirmApplied(
  deps: Deps,
  { id, pairingId }: { id: ApplicationSessionId; pairingId: PairingId },
): Promise<ConfirmAppliedResult> {
  let session: Awaited<ReturnType<typeof requireClaimedSession>>;
  try {
    session = await requireClaimedSession(deps, { id, pairingId });
  } catch (error) {
    if (!isSessionExpired(error)) throw error;
    const replay = await completedReplay(deps, { id, pairingId });
    if (replay) return replay;
    throw error;
  }

  const result = await deps.db.transaction(async (tx): Promise<ConfirmAppliedResult | null> => {
    // First, so a concurrent confirm for the same session waits on this row lock and then finds
    // it completed: exactly one call gets `changed: true`.
    if (!(await completeSession(tx, { id: session.id, now: deps.clock.now() }))) return null;
    const [current] = await tx
      .select({ status: opportunities.status })
      .from(opportunities)
      .where(and(eq(opportunities.id, session.opportunityId), eq(opportunities.userId, deps.userId)))
      .for("update");
    if (!current) throw notFound("That job");
    if (isAppliedOrLater(current.status)) {
      return { opportunityId: session.opportunityId, status: current.status, changed: false };
    }
    const item = await changeStatus({ ...deps, db: tx }, { opportunityId: session.opportunityId, status: "applied" });
    return { opportunityId: item.opportunityId, status: item.status, changed: true };
  });
  if (result) return result;

  // Lost the race to a concurrent confirm (or the session ended in between): answer as it now stands.
  const replay = await completedReplay(deps, { id, pairingId });
  if (replay) return replay;
  throw new AppError({
    code: "session_expired",
    message: "This application session has ended. Click Apply in Rolecraft again.",
  });
}
