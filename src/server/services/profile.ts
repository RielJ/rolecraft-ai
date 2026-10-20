import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { factKey } from "@/domain/citations";
import { contactFromCv, fillContact } from "@/domain/contact";
import { diffFacts } from "@/domain/facts-diff";
import { SKILLS, skillsInFacts } from "@/domain/features";
import { githubUserFor, projectRoleOf } from "@/domain/project-role";
import {
  buildSplitPrompt,
  buildSplitRetryPrompt,
  cleanModelText,
  type Prompt,
  SPLIT_MAX_TOKENS,
  type SplitItem,
} from "@/domain/prompts";
import { checkCandidates, type FactCandidate, sectionIn, splitSections } from "@/domain/split";
import { normalize } from "@/domain/text";
import { MAX_ADDED_SKILLS, normalizeSkillName, profileSkills } from "@/domain/user-skills";
import { isRoleHeader, type RoleFields } from "@/domain/work-roles";
import {
  type AddonInput,
  type Contact,
  type FactId,
  GithubReadSummary,
  type ItemFolderDto,
  type ItemGithubDto,
  type ItemId,
  MAX_STORED_CV_BYTES,
  type ProfileDto,
  type ProfileItemDto,
  type RoleDto,
  RolesReadTaskInput,
  type SaveRolesInput,
  type SetSkillInput,
  SplitTaskInput,
  type StandardAnswers,
  type Targeting,
  type TaskDto,
  type UpdateFactInput,
  type UpdateProfileInput,
  type UserId,
} from "@/shared/api";
import { type FactOrigin, hasRoles, type ProfileItemKind } from "@/shared/enums";
import { githubLabel, parseGithubLink } from "@/shared/github-link";
import { itemKindLabel } from "@/shared/labels";
import { extractCvText } from "../adapters/extract";
import type { Db, Tx } from "../db/client";
import { MERGE_SYNC_LOCK } from "../db/locks";
import { cvFiles, facts, profileItems, userSkills, users } from "../db/schema";
import { type AiConfig, checkCap, estimateUsd, loadAiConfig, requireAiConfig, runAi } from "./ai";
import { AppError, type Deps, notFound } from "./context";
import { linkFacts, loadRolesByItem, readRolesWithAi, replaceRoles, rolesEstimateUsd, writeRoles } from "./roles";
import { latestTask, startTask, type TaskContext } from "./tasks";
import { applySkillChange, loadSkillDictionary, loadUserSkillRows } from "./user-skills";

type ItemRow = typeof profileItems.$inferSelect;

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
  targeting: Targeting;
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
    targeting: {
      targetTitles: user.targetTitles,
      roleFamilies: user.roleFamilies,
      excludeTitleWords: user.excludeTitleWords,
      seniority: user.seniority,
      yearsExperience: user.yearsExperience,
      minPay: user.minPay,
    },
  };
}

/**
 * The item's read source: its folder (decision 81), else its GitHub link, with the read task and
 * what the last finished read did. Both null for other items.
 */
async function readSourceOf(
  deps: Deps,
  row: ItemRow,
): Promise<{ github: ItemGithubDto | null; folder: ItemFolderDto | null }> {
  if (row.kind === "cv") return { github: null, folder: null };
  const link = row.link ? parseGithubLink(row.link) : null;
  if (!row.folder && !link) return { github: null, folder: null };
  const read = await latestTask(deps, { kind: "github_read", inputMatches: { itemId: row.id } });
  const summary = GithubReadSummary.safeParse(read?.result);
  const lastRead = summary.success ? summary.data : null;
  if (row.folder) {
    return {
      github: null,
      folder: { path: row.folder, private: row.githubPrivate, readTask: read?.task ?? null, lastRead },
    };
  }
  if (!link) return { github: null, folder: null };
  const github: ItemGithubDto = {
    kind: link.kind,
    label: githubLabel(link),
    private: row.githubPrivate,
    readTask: read?.task ?? null,
    lastRead,
  };
  return { github, folder: null };
}

async function toItemDto(
  deps: Deps,
  row: ItemRow,
  { itemRoles, githubUser }: { itemRoles: readonly RoleDto[]; githubUser: string | null },
): Promise<ProfileItemDto> {
  const withRoles = hasRoles(row.kind);
  const [split, { github, folder }, rolesRead] = await Promise.all([
    latestTask(deps, { kind: "split", inputMatches: { itemId: row.id } }),
    readSourceOf(deps, row),
    withRoles ? latestTask(deps, { kind: "roles_read", inputMatches: { itemId: row.id } }) : null,
  ]);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    happenedOn: row.happenedOn,
    link: row.link,
    skills: row.skills,
    usage: row.usage,
    rev: row.rev,
    fileName: row.fileName,
    splitTask: split?.task ?? null,
    github,
    folder,
    project: projectDto(row, githubUser),
    roles: withRoles ? [...itemRoles] : [],
    rolesTask: rolesRead?.task ?? null,
  };
}

function projectDto(row: ItemRow, githubUser: string | null): ProfileItemDto["project"] {
  const found = projectRoleOf({
    kind: row.kind,
    choice: row.projectRoleChoice,
    read: row.projectRoleRead,
    link: row.link,
    githubUser,
  });
  return found ? { ...found, choice: row.projectRoleChoice } : null;
}

/** The stored CV file's name, size and upload time. Never its bytes. */
async function loadCvFile(deps: Pick<Deps, "db" | "userId">): Promise<ProfileDto["cvFile"]> {
  const [row] = await deps.db
    .select({ fileName: cvFiles.fileName, size: cvFiles.size, uploadedAt: cvFiles.createdAt })
    .from(cvFiles)
    .where(eq(cvFiles.userId, deps.userId));
  return row ? { ...row, uploadedAt: row.uploadedAt.toISOString() } : null;
}

/** The stored CV file with its bytes, for `GET /api/profile/cv/file` only (decision 69). */
export async function readCvFile(deps: Pick<Deps, "db" | "userId">): Promise<{ fileName: string; data: Uint8Array }> {
  const [row] = await deps.db
    .select({ fileName: cvFiles.fileName, data: cvFiles.data })
    .from(cvFiles)
    .where(eq(cvFiles.userId, deps.userId));
  if (!row) {
    throw new AppError({
      code: "not_found",
      message: "No copy of your CV's PDF is kept. Upload the PDF again to see it here.",
    });
  }
  return row;
}

export async function getProfile(deps: Deps): Promise<ProfileDto> {
  const [{ contact, standardAnswers, targeting }, items, rows, aiConfig, skillRows, cvFile, rolesByItem] =
    await Promise.all([
      loadContact(deps),
      deps.db
        .select()
        .from(profileItems)
        .where(eq(profileItems.userId, deps.userId))
        .orderBy(asc(profileItems.createdAt), asc(profileItems.id)),
      deps.db
        .select({
          id: facts.id,
          no: facts.no,
          text: facts.text,
          section: facts.section,
          roleId: facts.roleId,
          status: facts.status,
          seenRev: facts.seenRev,
          origin: facts.origin,
          evidence: facts.evidence,
          itemId: profileItems.id,
          itemKind: profileItems.kind,
          itemTitle: profileItems.title,
          itemRev: profileItems.rev,
          itemGithubRev: profileItems.githubRev,
          usage: profileItems.usage,
        })
        .from(facts)
        .innerJoin(profileItems, eq(profileItems.id, facts.itemId))
        .where(eq(facts.userId, deps.userId))
        .orderBy(asc(facts.no)),
      loadAiConfig(deps),
      loadUserSkillRows(deps),
      loadCvFile(deps),
      loadRolesByItem(deps),
    ]);
  const githubUser = githubUserFor({ configured: deps.github.user, links: contact.links })?.user ?? null;
  const dtos = await Promise.all(
    items.map((row) => toItemDto(deps, row, { itemRoles: rolesByItem.get(row.id) ?? [], githubUser })),
  );
  const skillsFound = skillsInFacts({ texts: rows.filter((r) => r.status === "confirmed").map((r) => r.text) });
  return {
    contact,
    standardAnswers,
    targeting,
    cv: dtos.find((i) => i.kind === "cv") ?? null,
    addons: dtos.filter((i) => i.kind !== "cv"),
    facts: rows.map(({ no, seenRev, itemRev, itemGithubRev, ...row }) => ({
      ...row,
      key: factKey(no),
      // Text facts follow the item's text versions, GitHub facts its reads.
      inLatest: seenRev >= (row.origin === "github" ? itemGithubRev : itemRev),
    })),
    skillsFound,
    skillChips: profileSkills({ factSkills: skillsFound, rows: skillRows }).chips,
    skillCatalog: SKILLS.map((s) => s.name),
    cvFile,
    aiReady: aiConfig !== null,
    projectScan: { github: deps.github.list !== null, local: deps.projects !== null },
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
  if (input.targeting?.targetTitles) patch.targetTitles = input.targeting.targetTitles;
  if (input.targeting?.roleFamilies) patch.roleFamilies = input.targeting.roleFamilies;
  if (input.targeting?.excludeTitleWords) patch.excludeTitleWords = input.targeting.excludeTitleWords;
  // Null clears these; a missing key keeps what is stored.
  if (input.targeting?.seniority !== undefined) patch.seniority = input.targeting.seniority;
  if (input.targeting?.yearsExperience !== undefined) patch.yearsExperience = input.targeting.yearsExperience;
  if (input.targeting?.minPay !== undefined) patch.minPay = input.targeting.minPay;
  if (Object.keys(patch).length) await deps.db.update(users).set(patch).where(eq(users.id, deps.userId));
  return getProfile(deps);
}

// ---------- Skills used for matching (decision 66) ----------

/**
 * Add a skill to matching, hide one found in confirmed facts, or clear either. One row per skill,
 * so adding a hidden skill un-hides it. Matching changes on the next read. Adding or removing a
 * skill of your own also updates stored jobs' skills in the same transaction (decision 68).
 */
export async function setSkill(deps: Deps, { name, state }: SetSkillInput): Promise<ProfileDto> {
  const clean = normalizeSkillName(name);
  if (clean.kind === "rejected") throw new AppError({ code: "invalid_input", message: clean.message });
  await deps.db.transaction(async (tx) => {
    const scope = { db: tx, userId: deps.userId };
    // A built-in is already read on every job, and hiding is a read-time filter: no job changes.
    const custom = !clean.builtin;
    if (custom) {
      // No sync transaction may write a job between reading the jobs and stamping them.
      await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${MERGE_SYNC_LOCK})`));
    }
    const before = custom ? await loadSkillDictionary(scope) : null;
    await writeSkillRow(tx, deps, { clean, state });
    if (before) await applySkillChange(tx, { userId: deps.userId, before, after: await loadSkillDictionary(scope) });
  });
  return getProfile(deps);
}

async function writeSkillRow(
  tx: Tx,
  deps: Pick<Deps, "userId" | "clock">,
  { clean, state }: { clean: { name: string; key: string }; state: SetSkillInput["state"] },
): Promise<void> {
  const mine = and(eq(userSkills.userId, deps.userId), eq(userSkills.key, clean.key));
  switch (state) {
    case "none":
      await tx.delete(userSkills).where(mine);
      return;
    case "hidden": {
      const confirmed = await tx
        .select({ text: facts.text })
        .from(facts)
        .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")));
      if (!skillsInFacts({ texts: confirmed.map((f) => f.text) }).includes(clean.name)) {
        throw new AppError({
          code: "not_in_facts",
          message: `None of your confirmed facts names ${clean.name}, so there is nothing to hide. Remove it instead.`,
        });
      }
      await upsertSkill(tx, deps, { ...clean, kind: "hidden" });
      return;
    }
    case "added": {
      const [[existing], [total]] = await Promise.all([
        tx.select({ kind: userSkills.kind }).from(userSkills).where(mine),
        tx
          .select({ n: count() })
          .from(userSkills)
          .where(and(eq(userSkills.userId, deps.userId), eq(userSkills.kind, "added"))),
      ]);
      if (existing?.kind !== "added" && (total?.n ?? 0) >= MAX_ADDED_SKILLS) {
        throw new AppError({
          code: "too_many_skills",
          message: `You can add up to ${MAX_ADDED_SKILLS} skills. Remove one you no longer use, then add ${clean.name}.`,
        });
      }
      await upsertSkill(tx, deps, { ...clean, kind: "added" });
      return;
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

async function upsertSkill(
  tx: Tx,
  deps: Pick<Deps, "userId" | "clock">,
  { key, name, kind }: { key: string; name: string; kind: "added" | "hidden" },
): Promise<void> {
  const now = deps.clock.now();
  await tx
    .insert(userSkills)
    .values({ userId: deps.userId, key, name, kind, createdAt: now })
    .onConflictDoUpdate({
      target: [userSkills.userId, userSkills.key],
      set: { name, kind, createdAt: now },
      // The same state again keeps the row, so an added skill keeps its place in the order.
      setWhere: sql`${userSkills.kind} <> excluded.kind`,
    });
}

// ---------- Split (section 3.3, steps 2 and 3) ----------

/** The text facts an item's earlier versions produced, oldest first. A new item has none. */
async function savedTexts(deps: Pick<Deps, "db">, itemId: ItemId | null): Promise<string[]> {
  if (!itemId) return [];
  const rows = await deps.db
    .select({ text: facts.text })
    .from(facts)
    .where(and(eq(facts.itemId, itemId), eq(facts.origin, "text")))
    .orderBy(asc(facts.no));
  return rows.map((r) => r.text);
}

function splitItem(row: Pick<ItemRow, "kind" | "title" | "body" | "skills">, saved: readonly string[]): SplitItem {
  return { kindLabel: itemKindLabel(row.kind), title: row.title, body: row.body, skills: row.skills, saved };
}

/** The item's own text is the only evidence a fact may rest on. An add-on's title is part of it. */
function evidenceOf(row: Pick<ItemRow, "kind" | "title" | "body">): string {
  return row.kind === "cv" ? row.body : `${row.title}\n${row.body}`;
}

/**
 * With an AI key, `402 over_cap` before anything is saved when this split would cross the cap.
 * Without a key the rule splitter runs, which costs nothing.
 */
async function checkSplitCap(
  deps: Deps,
  {
    item,
    kind,
    confirmOverCap,
    extraUsd = 0,
  }: { item: SplitItem; kind: ProfileItemKind; confirmOverCap: boolean; extraUsd?: number },
): Promise<void> {
  await checkSplitsCap(deps, { splits: [{ item, kind }], confirmOverCap, extraUsd });
}

/**
 * The same for several splits started together: one check against their summed estimate, plus
 * `extraUsd` for work started with them, such as reads for facts (decision 81).
 */
async function checkSplitsCap(
  deps: Deps,
  {
    splits,
    confirmOverCap,
    extraUsd = 0,
  }: {
    splits: readonly { item: SplitItem; kind: ProfileItemKind }[];
    confirmOverCap: boolean;
    extraUsd?: number;
  },
): Promise<void> {
  const config = await loadAiConfig(deps);
  if (!config) return;
  let total = extraUsd;
  for (const { item, kind } of splits) {
    const prompt = buildSplitPrompt({ item });
    // A CV or experience add-on also has its roles read in the same task (decision 71).
    const roles = hasRoles(kind) ? rolesEstimateUsd({ config, item }) : 0;
    total += estimateUsd({ model: config.models.light, prompt, maxOutputTokens: SPLIT_MAX_TOKENS }) + roles;
  }
  await checkCap(deps, { capUsd: config.capUsd, estimateUsd: total, confirmOverCap });
}

const SplitResult = z.object({
  facts: z.array(z.object({ text: z.string(), section: z.string().nullish() })),
});

function parseSplit(text: string): { ok: true; facts: FactCandidate[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(cleanModelText(text));
  } catch {
    return { ok: false, error: "the reply was not JSON" };
  }
  const parsed = SplitResult.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, facts: parsed.data.facts.map((f) => ({ text: f.text, section: f.section ?? null })) };
}

/** Light-tier split with one retry on an unreadable reply, then the task fails with the parse error. */
async function aiCandidates(
  deps: Deps,
  ctx: TaskContext,
  { item, config, confirmOverCap }: { item: SplitItem; config: AiConfig; confirmOverCap: boolean },
): Promise<FactCandidate[]> {
  const ai = (prompt: Prompt) =>
    runAi(deps, {
      tier: "light",
      purpose: "split",
      taskId: ctx.taskId,
      prompt,
      maxOutputTokens: SPLIT_MAX_TOKENS,
      confirmOverCap,
    });
  const prompt = buildSplitPrompt({ item });
  const first = await ai(prompt);
  const parsed = parseSplit(first.text);
  if (parsed.ok) return parsed.facts;
  await ctx.step("Asking the AI again for a readable reply");
  const retry = await ai(buildSplitRetryPrompt({ prompt, reply: first.text }));
  const again = parseSplit(retry.text);
  if (again.ok) return again.facts;
  throw new AppError({
    code: "ai_unavailable",
    message: `The ${config.models.light} reply could not be read twice (${again.error}). Retry, or remove the AI key in Settings to split by rule.`,
  });
}

type SplitOutcome =
  | {
      kind: "applied";
      method: "ai" | "rules";
      added: number;
      unchanged: number;
      removed: number;
      vanished: number;
      dropped: string[];
      /**
       * The roles read (decision 71): how many were kept, or why the read failed. A failed read
       * keeps the facts and the item's saved roles. Absent when roles were not read.
       */
      roles?: { kind: "read"; count: number } | { kind: "failed"; error: string };
    }
  | { kind: "skipped"; reason: "item_deleted" | "newer_version" };

/**
 * Apply a split to the facts of one item version. The item row is locked, so a newer save that
 * bumped `rev` meanwhile wins: this older split is skipped and the newer one runs on its own.
 */
async function applySplit(
  deps: Deps,
  {
    itemId,
    rev,
    candidates,
    roles,
  }: {
    itemId: ItemId;
    rev: number;
    candidates: readonly FactCandidate[];
    /** A fresh roles read replaces the item's roles; null keeps them and links new facts to them. */
    roles: readonly RoleFields[] | null;
  },
) {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ rev: profileItems.rev })
      .from(profileItems)
      .where(eq(profileItems.id, itemId))
      .for("update");
    if (!locked) return { kind: "skipped", reason: "item_deleted" } as const;
    if (locked.rev !== rev) return { kind: "skipped", reason: "newer_version" } as const;

    // Facts read from GitHub are diffed by the GitHub read, never by a re-split of the text.
    const existing = await tx
      .select({ id: facts.id, text: facts.text, status: facts.status })
      .from(facts)
      .where(and(eq(facts.itemId, itemId), eq(facts.origin, "text")));
    const diff = diffFacts({ existing, candidates: candidates.map((c) => c.text) });
    const sectionOf = new Map(candidates.map((c) => [normalize(c.text), c.section]));
    const textOf = new Map(existing.map((f) => [f.id, f.text]));
    // An unchanged fact keeps its status but takes this version's section: one update per section.
    const bySection = new Map<string | null, FactId[]>();
    for (const id of diff.unchanged) {
      const section = sectionOf.get(normalize(textOf.get(id) ?? "")) ?? null;
      bySection.set(section, [...(bySection.get(section) ?? []), id]);
    }
    for (const [section, ids] of bySection) {
      await tx.update(facts).set({ seenRev: rev, section }).where(inArray(facts.id, ids));
    }
    if (diff.removed.length) await tx.delete(facts).where(inArray(facts.id, diff.removed));
    if (diff.added.length) {
      await tx.insert(facts).values(
        diff.added.map((text) => ({
          userId: deps.userId,
          itemId,
          text,
          section: sectionOf.get(normalize(text)) ?? null,
          seenRev: rev,
        })),
      );
    }
    if (roles) await replaceRoles(tx, { userId: deps.userId, itemId, read: roles });
    else await linkFacts(tx, { itemId, onlyUnlinked: true });
    return {
      kind: "applied",
      added: diff.added.length,
      unchanged: diff.unchanged.length,
      removed: diff.removed.length,
      vanished: diff.vanished.length,
    } as const;
  });
}

async function runSplit(
  deps: Deps,
  ctx: TaskContext,
  { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean },
): Promise<SplitOutcome> {
  const [row] = await deps.db.select().from(profileItems).where(eq(profileItems.id, itemId));
  if (!row) return { kind: "skipped", reason: "item_deleted" };
  const what = row.kind === "cv" ? "your CV" : `"${row.title}"`;
  const item = splitItem(row, await savedTexts(deps, row.id));

  const config = await loadAiConfig(deps);
  await ctx.step(`Splitting ${what} into facts${config ? " with AI" : ""}`);
  const candidates = config
    ? await aiCandidates(deps, ctx, { item, config, confirmOverCap })
    : splitSections({ text: row.body });
  const evidence = evidenceOf(row);
  // Roles need AI; without it the saved roles stay and new facts link to them by section.
  let roles: RoleFields[] | null = null;
  let rolesError: string | null = null;
  if (config && hasRoles(row.kind)) {
    await ctx.step(`Reading the roles in ${what}`);
    try {
      roles = await readRolesWithAi(deps, ctx, { item, evidence, config, confirmOverCap });
    } catch (error) {
      // The facts are the split's job; "Read roles from your CV" can try the roles again.
      if (!(error instanceof AppError)) throw error;
      rolesError = error.message;
    }
  }

  await ctx.step("Checking each fact against your text");
  // A candidate that is only a role's header repeats the role, so it is not a fact (decision 71).
  // Without a fresh read, the item's saved roles decide.
  const headerRoles = roles ?? (hasRoles(row.kind) ? ((await loadRolesByItem(deps)).get(row.id) ?? []) : []);
  const claims = candidates.filter((c) => !isRoleHeader({ text: c.text, roles: headerRoles }));
  const { kept, dropped } = checkCandidates({ candidates: claims.map((c) => c.text), evidence });
  // A section must be in the text too; one that isn't is dropped and the fact shows ungrouped.
  const sectionOf = new Map(claims.map((c) => [normalize(c.text), sectionIn({ section: c.section, evidence })]));
  const checked = kept.map((text) => ({ text, section: sectionOf.get(normalize(text)) ?? null }));

  await ctx.step("Comparing with your current facts");
  const applied = await applySplit(deps, { itemId, rev: row.rev, candidates: checked, roles });
  if (applied.kind === "skipped") return applied;
  return {
    ...applied,
    method: config ? "ai" : "rules",
    dropped: dropped.map((d) => d.text),
    ...(roles ? { roles: { kind: "read" as const, count: roles.length } } : {}),
    ...(rolesError !== null ? { roles: { kind: "failed" as const, error: rolesError } } : {}),
  };
}

async function startSplit(
  deps: Deps,
  { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean },
): Promise<TaskDto> {
  const input: SplitTaskInput = { itemId };
  return startTask(deps, { kind: "split", input, run: (ctx) => runSplit(deps, ctx, { itemId, confirmOverCap }) });
}

/** Retry handler for `split` tasks: split the item's current text again. */
export async function retrySplit(deps: Deps, input: unknown, { confirmOverCap }: { confirmOverCap: boolean }) {
  const parsed = SplitTaskInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError({ code: "invalid_input", message: "This task's input is unreadable. Save the item again." });
  }
  const row = await loadItem(deps, parsed.data.itemId);
  await checkSplitCap(deps, { item: splitItem(row, await savedTexts(deps, row.id)), kind: row.kind, confirmOverCap });
  return startSplit(deps, { itemId: row.id, confirmOverCap });
}

// ---------- Roles (decision 71) ----------

/** The CV or an experience add-on: the only items roles are read from or saved on. */
async function loadRoleItem(deps: Pick<Deps, "db" | "userId">, itemId: ItemId): Promise<ItemRow> {
  const row = await loadItem(deps, itemId);
  if (!hasRoles(row.kind)) {
    throw new AppError({
      code: "invalid_input",
      message: `Roles belong to your CV and experience add-ons. "${row.title}" is ${itemKindLabel(row.kind).toLowerCase()}; change its kind to Experience to give it roles.`,
    });
  }
  return row;
}

type RolesReadOutcome =
  | { kind: "applied"; roles: number }
  | { kind: "skipped"; reason: "item_deleted" | "newer_version" };

async function runRolesRead(
  deps: Deps,
  ctx: TaskContext,
  { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean },
): Promise<RolesReadOutcome> {
  const [row] = await deps.db.select().from(profileItems).where(eq(profileItems.id, itemId));
  if (!row) return { kind: "skipped", reason: "item_deleted" };
  const config = await requireAiConfig(deps);
  const what = row.kind === "cv" ? "your CV" : `"${row.title}"`;
  await ctx.step(`Reading the roles in ${what} with AI`);
  const read = await readRolesWithAi(deps, ctx, {
    item: splitItem(row, []),
    evidence: evidenceOf(row),
    config,
    confirmOverCap,
  });
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ rev: profileItems.rev })
      .from(profileItems)
      .where(eq(profileItems.id, itemId))
      .for("update");
    if (!locked) return { kind: "skipped", reason: "item_deleted" } as const;
    // A newer save started its own split, which reads the roles again.
    if (locked.rev !== row.rev) return { kind: "skipped", reason: "newer_version" } as const;
    await replaceRoles(tx, { userId: deps.userId, itemId, read });
    return { kind: "applied", roles: read.length } as const;
  });
}

async function startRolesRead(
  deps: Deps,
  { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean },
): Promise<TaskDto> {
  const row = await loadRoleItem(deps, itemId);
  const config = await requireAiConfig(deps);
  const running = await latestTask(deps, { kind: "roles_read", inputMatches: { itemId } });
  if (running?.task.status === "running") {
    throw new AppError({ code: "invalid_input", message: "Your roles are being read already. Wait for it to finish." });
  }
  await checkCap(deps, {
    capUsd: config.capUsd,
    estimateUsd: rolesEstimateUsd({ config, item: splitItem(row, []) }),
    confirmOverCap,
  });
  const input: RolesReadTaskInput = { itemId };
  return startTask(deps, {
    kind: "roles_read",
    input,
    run: (ctx) => runRolesRead(deps, ctx, { itemId, confirmOverCap }),
  });
}

/**
 * "Read roles from your CV": read an item's roles with AI, replacing the ones it has. Its facts
 * are not split again; only their links to roles are recomputed.
 */
export async function readItemRoles(
  deps: Deps,
  { itemId, confirmOverCap = false }: { itemId: ItemId; confirmOverCap?: boolean | undefined },
): Promise<ProfileDto> {
  await startRolesRead(deps, { itemId, confirmOverCap });
  return getProfile(deps);
}

/** Retry handler for `roles_read` tasks. */
export async function retryRolesRead(
  deps: Deps,
  input: unknown,
  { confirmOverCap }: { confirmOverCap: boolean },
): Promise<TaskDto> {
  const parsed = RolesReadTaskInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError({ code: "invalid_input", message: "This task's input is unreadable. Read the roles again." });
  }
  return startRolesRead(deps, { itemId: parsed.data.itemId, confirmOverCap });
}

/** Save the Roles list as Profile shows it, in order. Facts keep their text and status. */
export async function saveItemRoles(
  deps: Deps,
  { itemId, roles }: { itemId: ItemId } & SaveRolesInput,
): Promise<ProfileDto> {
  await loadRoleItem(deps, itemId);
  await deps.db.transaction(async (tx) => {
    await tx.select({ id: profileItems.id }).from(profileItems).where(eq(profileItems.id, itemId)).for("update");
    await writeRoles(tx, { userId: deps.userId, itemId, list: roles });
  });
  return getProfile(deps);
}

// ---------- CV (section 3.3, step 1) ----------

/**
 * Fill the contact fields the user left empty from the CV's header (decision 49). A field the
 * user filled is never overwritten, so saving a CV again changes nothing they typed.
 */
async function fillContactFromCv(deps: Pick<Deps, "db" | "userId">, text: string): Promise<void> {
  const { contact } = await loadContact(deps);
  const { contact: next, filled } = fillContact(contact, contactFromCv(text));
  if (filled.length === 0) return;
  await deps.db.update(users).set(next).where(eq(users.id, deps.userId));
}

/**
 * What a CV save does to the stored file (decision 69). `store` keeps a PDF of at most 5 MB,
 * replacing any stored one; `drop` deletes it (a DOCX, or a PDF over 5 MB). A paste passes neither:
 * the file stays when the text is the same as before, and goes when the text changed.
 */
type CvFileChange = { kind: "store"; bytes: Uint8Array } | { kind: "drop" };

/**
 * Save CV text into the single `cv` item and start its split. Every save is a new version
 * (`rev + 1`), which is what makes a re-import diff against the facts of the last one.
 */
export async function saveCv(
  deps: Deps,
  {
    text,
    fileName = null,
    file,
    confirmOverCap = false,
  }: {
    text: string;
    fileName?: string | null;
    file?: CvFileChange | undefined;
    confirmOverCap?: boolean | undefined;
  },
): Promise<ProfileDto> {
  const [cv] = await deps.db
    .select({ id: profileItems.id })
    .from(profileItems)
    .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
  const saved = await savedTexts(deps, cv?.id ?? null);
  await checkSplitCap(deps, {
    item: { kindLabel: "CV", title: "CV", body: text, skills: [], saved },
    kind: "cv",
    confirmOverCap,
  });
  const now = deps.clock.now();
  const itemId = await deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: profileItems.id, rev: profileItems.rev, body: profileItems.body, fileName: profileItems.fileName })
      .from(profileItems)
      .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")))
      .for("update");
    // Saving the same text again (to split it again) keeps the file it came from, and its name.
    const sameText = existing?.body === text;
    const change: CvFileChange | null = file ?? (sameText ? null : { kind: "drop" });
    if (change?.kind === "store") {
      const row = {
        fileName: fileName ?? "cv.pdf",
        contentType: "application/pdf" as const,
        size: change.bytes.byteLength,
        data: change.bytes,
        createdAt: now,
      };
      await tx
        .insert(cvFiles)
        .values({ userId: deps.userId, ...row })
        .onConflictDoUpdate({ target: cvFiles.userId, set: row });
    } else if (change !== null) {
      await tx.delete(cvFiles).where(eq(cvFiles.userId, deps.userId));
    }
    if (existing) {
      const name = fileName ?? (sameText ? existing.fileName : null);
      await tx
        .update(profileItems)
        .set({ body: text, fileName: name, rev: existing.rev + 1, updatedAt: now })
        .where(eq(profileItems.id, existing.id));
      return existing.id;
    }
    const [created] = await tx
      .insert(profileItems)
      .values({ userId: deps.userId, kind: "cv", title: "CV", body: text, fileName })
      .returning({ id: profileItems.id });
    if (!created) throw new Error("Could not save the CV.");
    return created.id;
  });
  await fillContactFromCv(deps, text);
  await startSplit(deps, { itemId, confirmOverCap });
  return getProfile(deps);
}

/**
 * Read an uploaded PDF or DOCX, then save its text like a paste. A PDF of at most 5 MB is kept so
 * it can be viewed beside its text; any other upload deletes the kept file (decision 69).
 */
export async function uploadCv(
  deps: Deps,
  { fileName, bytes, confirmOverCap = false }: { fileName: string; bytes: Uint8Array; confirmOverCap?: boolean },
): Promise<ProfileDto> {
  const result = await extractCvText({ bytes });
  if (result.kind === "failed") {
    throw new AppError({
      code: "unreadable_file",
      message: `Could not read "${fileName}". ${result.message}`,
      details: { reason: result.reason },
    });
  }
  const keep = result.format === "pdf" && bytes.byteLength <= MAX_STORED_CV_BYTES;
  const file: CvFileChange = keep ? { kind: "store", bytes } : { kind: "drop" };
  return saveCv(deps, { text: result.text, fileName, file, confirmOverCap });
}

// ---------- Add-ons (decisions 2 to 4) ----------

async function loadItem(deps: Pick<Deps, "db" | "userId">, itemId: ItemId): Promise<ItemRow> {
  const [row] = await deps.db
    .select()
    .from(profileItems)
    .where(and(eq(profileItems.id, itemId), eq(profileItems.userId, deps.userId)));
  if (!row) throw notFound("That profile item");
  return row;
}

async function loadAddon(deps: Pick<Deps, "db" | "userId">, itemId: ItemId): Promise<ItemRow> {
  const row = await loadItem(deps, itemId);
  if (row.kind === "cv") throw notFound("That add-on");
  return row;
}

function addonValues(input: AddonInput) {
  return {
    kind: input.kind,
    title: input.title,
    body: input.body,
    happenedOn: input.happenedOn ?? null,
    link: input.link ?? null,
    skills: input.skills ?? [],
    usage: input.usage ?? "everywhere",
    projectRoleChoice: input.kind === "open_source" ? (input.projectRole ?? null) : null,
  } satisfies Partial<typeof profileItems.$inferInsert>;
}

/** The folder an add-on is read from (decision 81), resolved again here: the form's copy is only a hint. */
async function resolveFolder(deps: Deps, raw: string): Promise<string> {
  try {
    return await deps.folders.resolve(raw);
  } catch (err) {
    throw new AppError({ code: "needs_input", message: err instanceof Error ? err.message : String(err) });
  }
}

/** Save a new add-on and split it into pending facts. */
export async function createAddon(deps: Deps, input: AddonInput): Promise<ProfileDto> {
  await saveAddon(deps, input);
  return getProfile(deps);
}

/**
 * Save one typed add-on and start its split; returns its id. `extraUsd` joins the split's cap
 * check, for a read started with it.
 */
export async function saveAddon(deps: Deps, input: AddonInput, { extraUsd = 0 } = {}): Promise<ItemId> {
  const values = addonValues(input);
  const confirmOverCap = input.confirmOverCap ?? false;
  const folder = input.folder ? await resolveFolder(deps, input.folder) : null;
  await checkSplitCap(deps, { item: splitItem(values, []), kind: values.kind, confirmOverCap, extraUsd });
  const [created] = await deps.db
    .insert(profileItems)
    .values({ userId: deps.userId, ...values, folder, githubPrivate: input.linkPrivate ? true : null })
    .returning({ id: profileItems.id });
  if (!created) throw new Error("Could not save the add-on.");
  await startSplit(deps, { itemId: created.id, confirmOverCap });
  return created.id;
}

/** An add-on created by the app rather than typed (decision 78), with its repo's visibility. */
export type NewAddon = Omit<AddonInput, "confirmOverCap" | "folder"> & {
  githubPrivate: boolean | null;
  /** A resolved folder path, read for facts with git (decision 81). */
  folder?: string | null;
};

/**
 * Save several add-ons at once and split each into pending facts: one cap check for all the
 * splits, then one insert. A private repo is marked private from the start, so exports strip its
 * link before it is ever read (decision 55).
 */
export async function createAddons(
  deps: Deps,
  input: { addons: readonly NewAddon[]; confirmOverCap: boolean },
): Promise<ProfileDto> {
  await saveAddons(deps, input);
  return getProfile(deps);
}

/**
 * The same, returning the new ids in the order given. `extraUsd` joins the one cap check, for
 * reads started with the add-ons.
 */
export async function saveAddons(
  deps: Deps,
  { addons, confirmOverCap, extraUsd = 0 }: { addons: readonly NewAddon[]; confirmOverCap: boolean; extraUsd?: number },
): Promise<ItemId[]> {
  if (addons.length === 0) return [];
  const rows = addons.map((a) => ({ ...addonValues(a), githubPrivate: a.githubPrivate, folder: a.folder ?? null }));
  await checkSplitsCap(deps, {
    splits: rows.map((values) => ({ item: splitItem(values, []), kind: values.kind })),
    confirmOverCap,
    extraUsd,
  });
  const now = Date.now();
  const created = await deps.db
    .insert(profileItems)
    // One millisecond apart, so the add-ons list in the order they were picked; one shared
    // timestamp would leave the order to their random ids.
    .values(rows.map((values, i) => ({ userId: deps.userId, ...values, createdAt: new Date(now + i) })))
    .returning({ id: profileItems.id });
  for (const { id } of created) await startSplit(deps, { itemId: id, confirmOverCap });
  return created.map((c) => c.id);
}

/**
 * Replace an add-on's fields. A change to what the split reads (kind, title, text, skills) makes
 * a new version and re-splits it, the same as a CV re-import. Date, link and usage changes don't.
 */
export async function updateAddon(
  deps: Deps,
  { itemId, ...input }: { itemId: ItemId } & AddonInput,
): Promise<ProfileDto> {
  const row = await loadAddon(deps, itemId);
  const values = addonValues(input);
  const confirmOverCap = input.confirmOverCap ?? false;
  const resplit =
    row.kind !== values.kind ||
    row.title !== values.title ||
    row.body !== values.body ||
    row.skills.join("\n") !== values.skills.join("\n");
  if (resplit) {
    await checkSplitCap(deps, {
      item: splitItem(values, await savedTexts(deps, itemId)),
      kind: values.kind,
      confirmOverCap,
    });
  }
  await deps.db
    .update(profileItems)
    .set({ ...values, updatedAt: deps.clock.now(), ...(resplit ? { rev: row.rev + 1 } : {}) })
    .where(eq(profileItems.id, itemId));
  if (resplit) await startSplit(deps, { itemId, confirmOverCap });
  return getProfile(deps);
}

/** The `other` add-on that keeps answers typed into a draft's blanks (docs/plans/clean-files.md). */
export const DRAFTING_ADDON_TITLE = "Filled in while drafting";

/**
 * Keep answers typed into a draft's blanks: each line goes into the "Filled in while drafting"
 * add-on (created on first use) and becomes one confirmed fact, with no split. The user wrote them,
 * so there is nothing to review. The add-on's `rev` stays, so its earlier facts stay current; a
 * later edit in Profile re-splits it like any add-on. A line the add-on already has is skipped.
 */
export async function saveDraftingFacts(
  tx: Tx,
  deps: Pick<Deps, "userId" | "clock">,
  { lines }: { lines: readonly string[] },
): Promise<void> {
  const [found] = await tx
    .select({ id: profileItems.id, body: profileItems.body, rev: profileItems.rev })
    .from(profileItems)
    .where(
      and(
        eq(profileItems.userId, deps.userId),
        eq(profileItems.kind, "other"),
        eq(profileItems.title, DRAFTING_ADDON_TITLE),
      ),
    )
    .orderBy(asc(profileItems.createdAt))
    .limit(1)
    .for("update");
  const have = new Set(found?.body.split("\n").map((l) => l.trim()) ?? []);
  const fresh = [...new Set(lines.map((l) => l.trim()))].filter((l) => l !== "" && !have.has(l));
  if (fresh.length === 0) return;

  let item: { id: ItemId; rev: number };
  if (found) {
    await tx
      .update(profileItems)
      .set({ body: [found.body.trimEnd(), ...fresh].join("\n"), updatedAt: deps.clock.now() })
      .where(eq(profileItems.id, found.id));
    item = found;
  } else {
    const [created] = await tx
      .insert(profileItems)
      .values({ userId: deps.userId, kind: "other", title: DRAFTING_ADDON_TITLE, body: fresh.join("\n") })
      .returning({ id: profileItems.id, rev: profileItems.rev });
    if (!created) throw new Error("Could not save the add-on.");
    item = created;
  }
  await tx.insert(facts).values(
    fresh.map((text) => ({
      userId: deps.userId,
      itemId: item.id,
      text,
      section: null,
      status: "confirmed" as const,
      seenRev: item.rev,
    })),
  );
}

/** Delete an add-on and its facts. Citations keep their snapshot (FK SET NULL). */
export async function deleteAddon(deps: Deps, { itemId }: { itemId: ItemId }): Promise<ProfileDto> {
  await loadAddon(deps, itemId);
  await deps.db.delete(profileItems).where(eq(profileItems.id, itemId));
  return getProfile(deps);
}

// ---------- Facts (section 3.3, steps 3 and 4) ----------

async function requireFact(deps: Deps, factId: FactId): Promise<{ itemId: ItemId; origin: FactOrigin }> {
  const [row] = await deps.db
    .select({ itemId: facts.itemId, origin: facts.origin })
    .from(facts)
    .where(and(eq(facts.id, factId), eq(facts.userId, deps.userId)));
  if (!row) throw notFound("That fact");
  return row;
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

/** "Keep" on a fact that is not in the latest version of its item: it counts as seen again. */
export async function keepFact(deps: Deps, { factId }: { factId: FactId }): Promise<ProfileDto> {
  const { itemId, origin } = await requireFact(deps, factId);
  const [item] = await deps.db
    .select({ rev: profileItems.rev, githubRev: profileItems.githubRev })
    .from(profileItems)
    .where(eq(profileItems.id, itemId));
  if (!item) throw notFound("That fact's profile item");
  await deps.db
    .update(facts)
    .set({ seenRev: origin === "github" ? item.githubRev : item.rev })
    .where(eq(facts.id, factId));
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
