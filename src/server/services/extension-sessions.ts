import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { applyUrlKey } from "@/domain/dedup";
import type { OpportunityId } from "@/shared/api";
import {
  type ActiveSessionResponse,
  APPLICATION_SESSION_TTL_MS,
  type ApplicationSessionDto,
  type ApplicationSessionId,
  type ClaimSessionInput,
  type ClaimSessionResult,
  type CreateSessionResult,
  type PairingId,
  type UrlMismatchDetails,
} from "@/shared/extension";
import type { DbOrTx } from "../db/client";
import { applicationSessions, jobs, opportunities, users } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";
import type { AuthedPairing } from "./extension-pairing";

// The workspace Apply handoff (docs/EXTENSION.md). Apply records a pending
// session and the SPA opens the job's apply URL unchanged: nothing about the session travels in
// the URL. The paired extension finds the session with `activeSession` and binds it to a tab with
// `claimSession`. At most one session per user is live (pending or claimed); the partial unique
// index application_sessions_one_live enforces it.
//
// Two windows, each stored in expires_at:
// - pending: APPLICATION_SESSION_TTL_MS (15 min) from Apply, the handoff window.
// - claimed: CLAIMED_SESSION_TTL_MS from the first claim, long enough to fill a form. A re-claim
//   by the same pairing does not extend it.
// A live session past expires_at is marked expired the next time anything reads it.

/** How long a claimed session stays usable after its first claim. */
export const CLAIMED_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/** The DTO caps apply_url at this length (src/shared/extension.ts). */
const MAX_APPLY_URL = 2000;

const LIVE = ["pending", "claimed"] as const;

type SessionRow = typeof applicationSessions.$inferSelect;
type JobSummary = { title: string; company: string };

function toDto(row: SessionRow, job: JobSummary): ApplicationSessionDto {
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    status: row.status,
    applyUrl: row.applyUrl,
    applyUrlKey: row.applyUrlKey,
    title: job.title,
    company: job.company,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
  };
}

function sessionExpired(): AppError {
  return new AppError({
    code: "session_expired",
    message: "This application session has ended. Click Apply in Hanapbuhay again.",
  });
}

/** Mark this user's live sessions whose window has passed as expired. */
async function expirePastDue(db: DbOrTx, { userId, now }: { userId: Deps["userId"]; now: Date }): Promise<void> {
  await db
    .update(applicationSessions)
    .set({ status: "expired" })
    .where(
      and(
        eq(applicationSessions.userId, userId),
        inArray(applicationSessions.status, LIVE),
        lte(applicationSessions.expiresAt, now),
      ),
    );
}

/** A session row of this user with its job's title and company, or undefined. */
async function sessionWithJob(deps: Pick<Deps, "db" | "userId">, where: { id: ApplicationSessionId } | { live: true }) {
  const [row] = await deps.db
    .select({ session: applicationSessions, title: jobs.title, company: jobs.company })
    .from(applicationSessions)
    .innerJoin(opportunities, eq(opportunities.id, applicationSessions.opportunityId))
    .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
    .where(
      and(
        eq(applicationSessions.userId, deps.userId),
        "id" in where ? eq(applicationSessions.id, where.id) : inArray(applicationSessions.status, LIVE),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Apply: a pending session for `opportunityId`'s apply URL, valid for 15 minutes. Earlier live
 * sessions expire in the same transaction. The user row is locked first, so two concurrent
 * Applies run one after the other instead of tripping the one-live index.
 */
export async function createSession(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { opportunityId }: { opportunityId: OpportunityId },
): Promise<CreateSessionResult> {
  const [job] = await deps.db
    .select({ applyUrl: jobs.applyUrl, title: jobs.title, company: jobs.company })
    .from(opportunities)
    .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  if (!job) throw notFound("That job");
  const applyUrl = job.applyUrl;
  const key = applyUrl === null || applyUrl.length > MAX_APPLY_URL ? null : applyUrlKey(applyUrl);
  if (applyUrl === null || key === null) {
    throw new AppError({
      code: "invalid_input",
      message: "This job has no web apply link, so the extension cannot follow it. Apply on the job's page instead.",
    });
  }

  const now = deps.clock.now();
  const row = await deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, deps.userId)).for("no key update");
    await tx
      .update(applicationSessions)
      .set({ status: "expired" })
      .where(and(eq(applicationSessions.userId, deps.userId), inArray(applicationSessions.status, LIVE)));
    const [inserted] = await tx
      .insert(applicationSessions)
      .values({
        userId: deps.userId,
        opportunityId,
        applyUrl,
        applyUrlKey: key,
        status: "pending",
        expiresAt: new Date(now.getTime() + APPLICATION_SESSION_TTL_MS),
        createdAt: now,
      })
      .returning();
    if (!inserted) throw new Error("application session insert returned no row");
    return inserted;
  });
  return { session: toDto(row, job) };
}

/** The user's live session, after expiring any whose window has passed. */
export async function activeSession(deps: Pick<Deps, "db" | "userId" | "clock">): Promise<ActiveSessionResponse> {
  await expirePastDue(deps.db, { userId: deps.userId, now: deps.clock.now() });
  const row = await sessionWithJob(deps, { live: true });
  return row ? { kind: "active", session: toDto(row.session, row) } : { kind: "none" };
}

/**
 * Bind a session to the calling pairing's tab. The tab's `applyUrlKey` must equal the session's,
 * or the user must confirm the mismatch (`409 url_mismatch` with `UrlMismatchDetails` otherwise).
 * Ended sessions are `409 session_expired`. A session another pairing holds is 404 to this one.
 * A repeat claim by the holder returns the session unchanged, without extending its window.
 */
export async function claimSession(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { id, pairing, input }: { id: ApplicationSessionId; pairing: AuthedPairing; input: ClaimSessionInput },
): Promise<ClaimSessionResult> {
  const now = deps.clock.now();
  await expirePastDue(deps.db, { userId: deps.userId, now });
  const found = await sessionWithJob(deps, { id });
  if (!found) throw notFound("That application session");
  const { session } = found;

  switch (session.status) {
    case "expired":
    case "completed":
      throw sessionExpired();
    case "claimed":
      if (session.claimedByPairingId !== pairing.id) throw notFound("That application session");
      break;
    case "pending":
      break;
    default: {
      const _exhaustive: never = session.status;
      throw new Error(`unknown session status ${String(_exhaustive)}`);
    }
  }

  const tabUrlKey = applyUrlKey(input.tabUrl);
  if (tabUrlKey !== session.applyUrlKey && !input.confirmMismatch) {
    const details: UrlMismatchDetails = { sessionUrlKey: session.applyUrlKey, tabUrlKey };
    throw new AppError({
      code: "url_mismatch",
      message: "This tab is not the job's apply page. Confirm to use this tab for the application anyway.",
      details,
    });
  }
  if (session.status === "claimed") return { session: toDto(session, found) };

  // Conditional on still pending and unexpired, so a racing claim or a new Apply cannot be overwritten.
  const [updated] = await deps.db
    .update(applicationSessions)
    .set({
      status: "claimed",
      claimedByPairingId: pairing.id,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + CLAIMED_SESSION_TTL_MS),
    })
    .where(
      and(
        eq(applicationSessions.id, session.id),
        eq(applicationSessions.userId, deps.userId),
        eq(applicationSessions.status, "pending"),
        gt(applicationSessions.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) {
    // Lost a race (another claim, a new Apply, or the window closed): answer as the session now
    // stands. It is no longer an unexpired pending row, so this recursion ends on the next call.
    return claimSession(deps, { id, pairing, input });
  }
  return { session: toDto(updated, found) };
}

/** A claimed session as Tasks 6 and 7 use it. */
export type ClaimedSession = Pick<SessionRow, "id" | "opportunityId" | "applyUrl" | "applyUrlKey" | "expiresAt"> & {
  claimedAt: Date;
};

/**
 * The session `pairingId` holds, for routes that act on it (prefill, outputs, confirm-applied).
 * Expires past-due sessions first. Unknown, or held by another pairing: 404. Pending (never
 * claimed), expired, superseded or completed: 409 session_expired.
 */
export async function requireClaimedSession(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { id, pairingId }: { id: ApplicationSessionId; pairingId: PairingId },
): Promise<ClaimedSession> {
  await expirePastDue(deps.db, { userId: deps.userId, now: deps.clock.now() });
  const [row] = await deps.db
    .select()
    .from(applicationSessions)
    .where(and(eq(applicationSessions.id, id), eq(applicationSessions.userId, deps.userId)));
  if (!row) throw notFound("That application session");
  if (row.claimedByPairingId !== null && row.claimedByPairingId !== pairingId) {
    throw notFound("That application session");
  }
  switch (row.status) {
    case "claimed":
      break;
    case "pending":
    case "expired":
    case "completed":
      throw sessionExpired();
    default: {
      const _exhaustive: never = row.status;
      throw new Error(`unknown session status ${String(_exhaustive)}`);
    }
  }
  // application_sessions_claimed: a claimed row has claimed_at. A claimed row with no pairing
  // (its pairing was deleted, FK set null) is not this pairing's.
  if (row.claimedAt === null || row.claimedByPairingId !== pairingId) throw notFound("That application session");
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    applyUrl: row.applyUrl,
    applyUrlKey: row.applyUrlKey,
    claimedAt: row.claimedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Mark a claimed session completed (Task 7, confirm-applied), inside the caller's transaction.
 * Only a claimed row changes, so the status CHECKs hold (completed needs claimed_at). True when
 * this call completed it; false when it was not claimed (already completed, pending, expired).
 * The caller checks ownership first with `requireClaimedSession`.
 */
export async function completeSession(
  tx: DbOrTx,
  { id, now }: { id: ApplicationSessionId; now: Date },
): Promise<boolean> {
  const done = await tx
    .update(applicationSessions)
    .set({ status: "completed", completedAt: now })
    .where(and(eq(applicationSessions.id, id), eq(applicationSessions.status, "claimed")))
    .returning({ id: applicationSessions.id });
  return done.length > 0;
}
