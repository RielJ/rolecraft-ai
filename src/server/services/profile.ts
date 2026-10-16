import { and, asc, eq, inArray } from "drizzle-orm";
import { factKey } from "@/domain/citations";
import { splitFacts } from "@/domain/split";
import { normalize } from "@/domain/text";
import type {
  Contact,
  FactId,
  PasteCvInput,
  ProfileDto,
  StandardAnswers,
  UpdateFactInput,
  UpdateProfileInput,
  UserId,
} from "@/shared/api";
import type { Db } from "../db/client";
import { facts, profileItems, users } from "../db/schema";
import { type Deps, notFound } from "./context";

/** The single users row (decision 28). Created on first boot. */
export async function ensureUser(db: Db): Promise<UserId> {
  const [existing] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(users).values({}).returning({ id: users.id });
  if (!created) throw new Error("Could not create the user row.");
  return created.id;
}

export async function loadContact(deps: Pick<Deps, "db" | "userId">): Promise<{
  contact: Contact;
  standardAnswers: StandardAnswers;
}> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, deps.userId));
  if (!user) throw notFound("Your profile");
  return {
    contact: {
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      location: user.location,
      links: user.links,
    },
    standardAnswers: user.standardAnswers,
  };
}

export async function getProfile(deps: Deps): Promise<ProfileDto> {
  const { contact, standardAnswers } = await loadContact(deps);
  const [cv] = await deps.db
    .select({ id: profileItems.id, body: profileItems.body, rev: profileItems.rev })
    .from(profileItems)
    .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
  const rows = await deps.db
    .select({
      id: facts.id,
      no: facts.no,
      text: facts.text,
      status: facts.status,
      itemId: profileItems.id,
      itemKind: profileItems.kind,
      itemTitle: profileItems.title,
      usage: profileItems.usage,
    })
    .from(facts)
    .innerJoin(profileItems, eq(profileItems.id, facts.itemId))
    .where(eq(facts.userId, deps.userId))
    .orderBy(asc(facts.no));
  return {
    contact,
    standardAnswers,
    cv: cv ? { id: cv.id, text: cv.body, rev: cv.rev } : null,
    facts: rows.map(({ no, ...row }) => ({ ...row, key: factKey(no) })),
  };
}

export async function updateProfile(deps: Deps, input: UpdateProfileInput): Promise<ProfileDto> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.contact) Object.assign(patch, input.contact);
  if (input.standardAnswers) {
    // Patch semantics: keys not sent are kept. A blank answer removes its key, so
    // "answered" always means non-empty text.
    const { standardAnswers: current } = await loadContact(deps);
    patch.standardAnswers = Object.fromEntries(
      Object.entries({ ...current, ...input.standardAnswers }).filter(([, v]) => v !== undefined && v.trim() !== ""),
    );
  }
  if (Object.keys(patch).length) await deps.db.update(users).set(patch).where(eq(users.id, deps.userId));
  return getProfile(deps);
}

/**
 * Store pasted CV text in the single `cv` item and split it by rule into pending facts.
 * Re-pasting keeps unchanged facts (id, key, status, citations), drops vanished pending ones,
 * and leaves vanished confirmed ones in place with an old `seen_rev` (section 3.3).
 */
export async function pasteCv(deps: Deps, input: PasteCvInput): Promise<ProfileDto> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: profileItems.id, rev: profileItems.rev })
      .from(profileItems)
      .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
    const item = existing
      ? { id: existing.id, rev: existing.rev + 1 }
      : await tx
          .insert(profileItems)
          .values({ userId: deps.userId, kind: "cv", title: "CV", body: input.text })
          .returning({ id: profileItems.id, rev: profileItems.rev })
          .then(([row]) => {
            if (!row) throw new Error("Could not save the CV.");
            return row;
          });
    if (existing) {
      await tx
        .update(profileItems)
        .set({ body: input.text, rev: item.rev, updatedAt: now })
        .where(eq(profileItems.id, item.id));
    }

    const candidates = splitFacts({ text: input.text });
    const current = await tx
      .select({ id: facts.id, text: facts.text, status: facts.status })
      .from(facts)
      .where(eq(facts.itemId, item.id));
    const byText = new Map(current.map((f) => [normalize(f.text), f]));
    const wanted = new Set(candidates.map(normalize));

    const kept = current.filter((f) => wanted.has(normalize(f.text))).map((f) => f.id);
    const vanishedPending = current
      .filter((f) => !wanted.has(normalize(f.text)) && f.status === "pending")
      .map((f) => f.id);
    if (kept.length) await tx.update(facts).set({ seenRev: item.rev }).where(inArray(facts.id, kept));
    if (vanishedPending.length) await tx.delete(facts).where(inArray(facts.id, vanishedPending));

    const added = candidates.filter((text) => !byText.has(normalize(text)));
    if (added.length) {
      await tx
        .insert(facts)
        .values(added.map((text) => ({ userId: deps.userId, itemId: item.id, text, seenRev: item.rev })));
    }
  });
  return getProfile(deps);
}

async function requireFact(deps: Deps, factId: FactId): Promise<void> {
  const [row] = await deps.db
    .select({ id: facts.id })
    .from(facts)
    .where(and(eq(facts.id, factId), eq(facts.userId, deps.userId)));
  if (!row) throw notFound("That fact");
}

export async function confirmFact(deps: Deps, { factId }: { factId: FactId }): Promise<ProfileDto> {
  await requireFact(deps, factId);
  await deps.db.update(facts).set({ status: "confirmed", updatedAt: deps.clock.now() }).where(eq(facts.id, factId));
  return getProfile(deps);
}

export async function confirmAllFacts(deps: Deps): Promise<ProfileDto> {
  await deps.db
    .update(facts)
    .set({ status: "confirmed", updatedAt: deps.clock.now() })
    .where(and(eq(facts.userId, deps.userId), eq(facts.status, "pending")));
  return getProfile(deps);
}

export async function updateFact(
  deps: Deps,
  { factId, text }: { factId: FactId } & UpdateFactInput,
): Promise<ProfileDto> {
  await requireFact(deps, factId);
  await deps.db.update(facts).set({ text, updatedAt: deps.clock.now() }).where(eq(facts.id, factId));
  return getProfile(deps);
}

/** Discard a pending fact, or delete a confirmed one. Citations keep their snapshot (FK SET NULL). */
export async function deleteFact(deps: Deps, { factId }: { factId: FactId }): Promise<ProfileDto> {
  await requireFact(deps, factId);
  await deps.db.delete(facts).where(eq(facts.id, factId));
  return getProfile(deps);
}
