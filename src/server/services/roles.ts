import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildRolesPrompt,
  buildRolesRetryPrompt,
  cleanModelText,
  type Prompt,
  ROLES_MAX_TOKENS,
  type RolesItem,
} from "@/domain/prompts";
import { checkRoles, type RoleCandidate, type RoleFields, roleForSection } from "@/domain/work-roles";
import type { ItemId, RoleDto, RoleId, RoleInput, UserId } from "@/shared/api";
import type { DbOrTx } from "../db/client";
import { facts, profileItems, roles } from "../db/schema";
import { type AiConfig, estimateUsd, runAi } from "./ai";
import { AppError, type Deps } from "./context";
import type { TaskContext } from "./tasks";

/*
 * Roles (decision 71, docs/plans/roles.md): read from a CV or experience add-on in the split task
 * or a "Read roles" task, kept only where every field is in the text, and editable on Profile.
 * Facts link to a role when their section names exactly one role's company.
 */

type RoleRow = typeof roles.$inferSelect;

const toFields = (r: Pick<RoleRow, "title" | "company" | "location" | "startText" | "endText">): RoleFields => ({
  title: r.title,
  company: r.company,
  location: r.location,
  start: r.startText,
  end: r.endText,
});

/** Every role of the user, by item, most recent first, with how many facts sit under each. */
export async function loadRolesByItem(deps: Pick<Deps, "db" | "userId">): Promise<Map<ItemId, RoleDto[]>> {
  const [rows, counts] = await Promise.all([
    deps.db.select().from(roles).where(eq(roles.userId, deps.userId)).orderBy(asc(roles.itemId), asc(roles.position)),
    deps.db
      .select({ roleId: facts.roleId, n: count() })
      .from(facts)
      .where(and(eq(facts.userId, deps.userId), isNotNull(facts.roleId)))
      .groupBy(facts.roleId),
  ]);
  const factCount = new Map(counts.map((c) => [c.roleId, c.n]));
  const byItem = new Map<ItemId, RoleDto[]>();
  for (const row of rows) {
    const dto: RoleDto = { id: row.id, ...toFields(row), factCount: factCount.get(row.id) ?? 0 };
    byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), dto]);
  }
  return byItem;
}

/** Every role of the user in draft order: the CV's, then each add-on's by when it was added. */
export async function loadDraftRoles(
  deps: Pick<Deps, "db" | "userId">,
): Promise<(RoleFields & { id: RoleId; itemId: ItemId })[]> {
  const rows = await deps.db
    .select({ role: roles })
    .from(roles)
    .innerJoin(profileItems, eq(profileItems.id, roles.itemId))
    .where(eq(roles.userId, deps.userId))
    .orderBy(sql`${profileItems.kind} <> 'cv'`, asc(profileItems.createdAt), asc(profileItems.id), asc(roles.position));
  return rows.map(({ role }) => ({ id: role.id, itemId: role.itemId, ...toFields(role) }));
}

/**
 * Link the item's facts to its roles by section. `onlyUnlinked` leaves facts that already have a
 * role alone (a save, or a split that did not read roles); otherwise every link is recomputed.
 */
export async function linkFacts(
  db: DbOrTx,
  { itemId, onlyUnlinked }: { itemId: ItemId; onlyUnlinked: boolean },
): Promise<void> {
  const itemRoles = await db
    .select({ id: roles.id, company: roles.company })
    .from(roles)
    .where(eq(roles.itemId, itemId));
  if (!onlyUnlinked) await db.update(facts).set({ roleId: null }).where(eq(facts.itemId, itemId));
  if (itemRoles.length === 0) return;
  const rows = await db
    .select({ id: facts.id, section: facts.section })
    .from(facts)
    .where(and(eq(facts.itemId, itemId), isNull(facts.roleId)));
  const byRole = new Map<RoleId, (typeof rows)[number]["id"][]>();
  for (const fact of rows) {
    const role = roleForSection({ section: fact.section, roles: itemRoles });
    if (role) byRole.set(role.id, [...(byRole.get(role.id) ?? []), fact.id]);
  }
  for (const [roleId, ids] of byRole) await db.update(facts).set({ roleId }).where(inArray(facts.id, ids));
}

/**
 * Replace an item's roles with a fresh read. Its facts' links are cleared first and recomputed;
 * their text and status never change. Run it in the transaction that locked the item.
 */
export async function replaceRoles(
  db: DbOrTx,
  { userId, itemId, read }: { userId: UserId; itemId: ItemId; read: readonly RoleFields[] },
): Promise<void> {
  await db.update(facts).set({ roleId: null }).where(eq(facts.itemId, itemId));
  await db.delete(roles).where(eq(roles.itemId, itemId));
  if (read.length > 0) {
    await db.insert(roles).values(
      read.map((r, position) => ({
        userId,
        itemId,
        position,
        title: r.title,
        company: r.company,
        location: r.location,
        startText: r.start,
        endText: r.end,
      })),
    );
  }
  await linkFacts(db, { itemId, onlyUnlinked: true });
}

/**
 * Save the list Profile shows: rows with an id keep that role (and its facts), rows without one are
 * new, and roles left out are removed (their facts keep no role). Facts without a role then link
 * by section, so an added role picks up its facts.
 */
export async function writeRoles(
  db: DbOrTx,
  { userId, itemId, list }: { userId: UserId; itemId: ItemId; list: readonly RoleInput[] },
): Promise<void> {
  const existing = new Set(
    (await db.select({ id: roles.id }).from(roles).where(eq(roles.itemId, itemId))).map((r) => r.id),
  );
  const keep = list.flatMap((r) => (r.id ? [r.id] : []));
  if (keep.some((id) => !existing.has(id)) || new Set(keep).size !== keep.length) {
    throw new AppError({
      code: "invalid_input",
      message: "These roles changed since the page loaded. Reload the page, then save them again.",
    });
  }
  const gone = [...existing].filter((id) => !keep.includes(id));
  if (gone.length) await db.delete(roles).where(inArray(roles.id, gone));
  for (const [position, r] of list.entries()) {
    const values = {
      position,
      title: r.title,
      company: r.company,
      location: r.location,
      startText: r.start,
      endText: r.end,
    };
    if (r.id) await db.update(roles).set(values).where(eq(roles.id, r.id));
    else await db.insert(roles).values({ userId, itemId, ...values });
  }
  await linkFacts(db, { itemId, onlyUnlinked: true });
}

// ---------- Reading roles with AI ----------

const RolesReply = z.object({
  roles: z.array(
    z.object({
      title: z.string().nullish(),
      company: z.string().nullish(),
      location: z.string().nullish(),
      start: z.string().nullish(),
      end: z.string().nullish(),
    }),
  ),
});

function parseRoles(text: string): { ok: true; roles: RoleCandidate[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(cleanModelText(text));
  } catch {
    return { ok: false, error: "the reply was not JSON" };
  }
  const parsed = RolesReply.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, roles: parsed.data.roles };
}

/** What a roles read costs at most, for the cap check before a split or a Read roles. */
export function rolesEstimateUsd({ config, item }: { config: AiConfig; item: RolesItem }): number {
  return estimateUsd({
    model: config.models.light,
    prompt: buildRolesPrompt({ item }),
    maxOutputTokens: ROLES_MAX_TOKENS,
  });
}

/**
 * Light-tier roles read with one retry on an unreadable reply, then `checkRoles` against the
 * item's text: a field the text lacks is dropped, and so is a role without a title or company.
 */
export async function readRolesWithAi(
  deps: Deps,
  ctx: TaskContext,
  {
    item,
    evidence,
    config,
    confirmOverCap,
  }: { item: RolesItem; evidence: string; config: AiConfig; confirmOverCap: boolean },
): Promise<RoleFields[]> {
  const ai = (prompt: Prompt) =>
    runAi(deps, {
      tier: "light",
      purpose: "roles",
      taskId: ctx.taskId,
      prompt,
      maxOutputTokens: ROLES_MAX_TOKENS,
      confirmOverCap,
    });
  const prompt = buildRolesPrompt({ item });
  const first = await ai(prompt);
  let parsed = parseRoles(first.text);
  if (!parsed.ok) {
    await ctx.step("Asking the AI again for a readable list of roles");
    const retry = await ai(buildRolesRetryPrompt({ prompt, reply: first.text }));
    parsed = parseRoles(retry.text);
  }
  if (!parsed.ok) {
    throw new AppError({
      code: "ai_unavailable",
      message: `The ${config.models.light} reply listing your roles could not be read twice (${parsed.error}). Retry, or type your roles on Profile.`,
    });
  }
  return checkRoles({ text: evidence, roles: parsed.roles });
}
