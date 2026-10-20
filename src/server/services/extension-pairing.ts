import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import {
  type ClaimPairingResult,
  type CreatePairingResult,
  type ExtensionOrigin,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  type PairingCode,
  type PairingDto,
  type PairingId,
  type PairingList,
  PairingToken,
} from "@/shared/extension";
import { extensionPairings } from "../db/schema";
import { AppError, type Deps, notFound } from "./context";

// Pairing the Chrome extension (docs/EXTENSION.md). The SPA creates a
// one-time code; the extension claims it with its chrome-extension:// Origin and gets a bearer
// token once. Only SHA-256 digests of the code and token are stored, and neither is ever logged.

type PairingRow = typeof extensionPairings.$inferSelect;

/** The pairing a bearer token belongs to, set on the request by the extension guard. */
export type AuthedPairing = { id: PairingId; extensionOrigin: ExtensionOrigin };

const LIST_LIMIT = 100;
const CREATE_ATTEMPTS = 5;

/** Hex SHA-256 of a code or token: what the table stores and looks up. */
function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time compare of two hex digests. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 8 characters from the pairing alphabet, uniform (rejection sampling keeps `% 30` unbiased). */
function newCode(): string {
  const size = PAIRING_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH * 2)) {
      if (byte < limit && code.length < PAIRING_CODE_LENGTH) code += PAIRING_CODE_ALPHABET[byte % size];
    }
  }
  return code;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; typeof e === "object" && e !== null; e = "cause" in e ? e.cause : null) {
    if ("code" in e && e.code === "23505") return true;
  }
  return false;
}

function unauthorized(message: string): AppError {
  return new AppError({ code: "unauthorized", message });
}

function toDto(row: PairingRow, now: Date): PairingDto {
  const base = { id: row.id, createdAt: row.createdAt.toISOString() };
  if (row.revokedAt !== null) {
    return { status: "revoked", ...base, extensionOrigin: row.extensionOrigin, revokedAt: row.revokedAt.toISOString() };
  }
  if (row.claimedAt !== null) {
    // extension_pairings_claim_origin: claimed_at and extension_origin are set together.
    if (row.extensionOrigin === null) throw new Error("claimed pairing without an origin");
    return {
      status: "active",
      ...base,
      extensionOrigin: row.extensionOrigin,
      claimedAt: row.claimedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
  }
  if (row.codeExpiresAt <= now) return { status: "expired", ...base };
  return { status: "waiting", ...base, codeExpiresAt: row.codeExpiresAt.toISOString() };
}

/**
 * A new waiting pairing and its code, shown once as `ABCD-EFGH`. Drops this user's codes that
 * expired unclaimed. A digest collision with a live code (unique index) retries with a new code.
 */
export async function createPairing(deps: Pick<Deps, "db" | "userId" | "clock">): Promise<CreatePairingResult> {
  const now = deps.clock.now();
  await deps.db
    .delete(extensionPairings)
    .where(
      and(
        eq(extensionPairings.userId, deps.userId),
        isNull(extensionPairings.claimedAt),
        isNull(extensionPairings.revokedAt),
        lte(extensionPairings.codeExpiresAt, now),
      ),
    );

  for (let attempt = 1; ; attempt++) {
    const code = newCode();
    try {
      const [row] = await deps.db
        .insert(extensionPairings)
        .values({
          userId: deps.userId,
          codeHash: digest(code),
          codeExpiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS),
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("pairing insert returned no row");
      return { pairing: toDto(row, now), code: `${code.slice(0, 4)}-${code.slice(4)}` };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= CREATE_ATTEMPTS) throw err;
    }
  }
}

/** Newest first. Carries no code or token material. */
export async function listPairings(deps: Pick<Deps, "db" | "userId" | "clock">): Promise<PairingList> {
  const now = deps.clock.now();
  const rows = await deps.db
    .select()
    .from(extensionPairings)
    .where(eq(extensionPairings.userId, deps.userId))
    .orderBy(desc(extensionPairings.createdAt))
    .limit(LIST_LIMIT);
  return { pairings: rows.map((row) => toDto(row, now)) };
}

/** Revoke a waiting or active pairing. Its code and token stop working at once. Idempotent. */
export async function revokePairing(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { id }: { id: PairingId },
): Promise<PairingDto> {
  const now = deps.clock.now();
  const mine = and(eq(extensionPairings.id, id), eq(extensionPairings.userId, deps.userId));
  const [revoked] = await deps.db
    .update(extensionPairings)
    .set({ revokedAt: now })
    .where(and(mine, isNull(extensionPairings.revokedAt)))
    .returning();
  const [row] = revoked ? [revoked] : await deps.db.select().from(extensionPairings).where(mine);
  if (!row) throw notFound("That pairing");
  return toDto(row, now);
}

/**
 * Exchange a live code for a bearer token, binding `extensionOrigin`. One conditional UPDATE, so
 * two racing claims cannot both win. Wrong, used, revoked and expired codes are one answer.
 */
export async function claimPairing(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { code, extensionOrigin }: { code: PairingCode; extensionOrigin: ExtensionOrigin },
): Promise<ClaimPairingResult> {
  const now = deps.clock.now();
  const token = PairingToken.parse(randomBytes(32).toString("base64url"));
  const [row] = await deps.db
    .update(extensionPairings)
    .set({ tokenHash: digest(token), claimedAt: now, extensionOrigin })
    .where(
      and(
        eq(extensionPairings.userId, deps.userId),
        eq(extensionPairings.codeHash, digest(code)),
        isNull(extensionPairings.claimedAt),
        isNull(extensionPairings.revokedAt),
        gt(extensionPairings.codeExpiresAt, now),
      ),
    )
    .returning({ id: extensionPairings.id });
  if (!row) {
    throw unauthorized("That code is wrong, already used or expired. Create a new code in Hanapbuhay settings.");
  }
  return { pairingId: row.id, token };
}

/**
 * The active pairing for `token`, after checking `origin` when the request sent one. Records
 * the use. Unknown or revoked token: 401. Origin other than the paired extension: 403.
 */
export async function authenticatePairing(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { token, origin }: { token: PairingToken; origin: string | undefined },
): Promise<AuthedPairing> {
  const tokenDigest = digest(token);
  const [row] = await deps.db
    .select({
      id: extensionPairings.id,
      tokenHash: extensionPairings.tokenHash,
      extensionOrigin: extensionPairings.extensionOrigin,
      revokedAt: extensionPairings.revokedAt,
    })
    .from(extensionPairings)
    .where(and(eq(extensionPairings.userId, deps.userId), eq(extensionPairings.tokenHash, tokenDigest)));
  if (
    !row ||
    row.tokenHash === null ||
    row.extensionOrigin === null ||
    row.revokedAt !== null ||
    !digestsEqual(row.tokenHash, tokenDigest)
  ) {
    throw unauthorized("This extension is not paired, or its pairing was revoked. Pair it again.");
  }
  if (origin !== undefined && origin !== row.extensionOrigin) {
    throw new AppError({ code: "forbidden_origin", message: "This token belongs to a different extension." });
  }
  await deps.db.update(extensionPairings).set({ lastUsedAt: deps.clock.now() }).where(eq(extensionPairings.id, row.id));
  return { id: row.id, extensionOrigin: row.extensionOrigin };
}

/** True when `origin` belongs to an active (claimed, not revoked) pairing. For CORS preflight. */
export async function isPairedOrigin(
  deps: Pick<Deps, "db" | "userId">,
  { origin }: { origin: ExtensionOrigin },
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: extensionPairings.id })
    .from(extensionPairings)
    .where(
      and(
        eq(extensionPairings.userId, deps.userId),
        eq(extensionPairings.extensionOrigin, origin),
        isNotNull(extensionPairings.claimedAt),
        isNull(extensionPairings.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
