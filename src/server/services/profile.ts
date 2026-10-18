import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { factKey } from "@/domain/citations";
import { contactFromCv, fillContact } from "@/domain/contact";
import { diffFacts } from "@/domain/facts-diff";
import { SKILLS, skillsInFacts } from "@/domain/features";
import { githubLabel, parseGithubLink } from "@/domain/github-link";
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
import {
  type AddonInput,
  type Contact,
  type FactId,
  GithubReadSummary,
  type ItemGithubDto,
  type ItemId,
  type ProfileDto,
  type ProfileItemDto,
  type SetSkillInput,
  SplitTaskInput,
  type StandardAnswers,
  type Targeting,
  type TaskDto,
  type UpdateFactInput,
  type UpdateProfileInput,
  type UserId,
} from "@/shared/api";
import type { FactOrigin } from "@/shared/enums";
import { itemKindLabel } from "@/shared/labels";
import { extractCvText } from "../adapters/extract";
import type { Db } from "../db/client";
import { facts, profileItems, userSkills, users } from "../db/schema";
import { type AiConfig, checkCap, estimateUsd, loadAiConfig, runAi } from "./ai";
import { AppError, type Deps, notFound } from "./context";
import { latestTask, startTask, type TaskContext } from "./tasks";
import { loadUserSkillRows } from "./user-skills";

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

/** The item's GitHub link, its read task and what the last finished read did; null for other links. */
async function githubOf(deps: Deps, row: ItemRow): Promise<ItemGithubDto | null> {
  const link = row.kind !== "cv" && row.link ? parseGithubLink(row.link) : null;
  if (!link) return null;
  const read = await latestTask(deps, { kind: "github_read", inputMatches: { itemId: row.id } });
  const summary = GithubReadSummary.safeParse(read?.result);
  return {
    kind: link.kind,
    label: githubLabel(link),
    private: row.githubPrivate,
    readTask: read?.task ?? null,
    lastRead: summary.success ? summary.data : null,
  };
}

async function toItemDto(deps: Deps, row: ItemRow): Promise<ProfileItemDto> {
  const [split, github] = await Promise.all([
    latestTask(deps, { kind: "split", inputMatches: { itemId: row.id } }),
    githubOf(deps, row),
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
  };
}

export async function getProfile(deps: Deps): Promise<ProfileDto> {
  const [{ contact, standardAnswers, targeting }, items, rows, aiConfig, skillRows] = await Promise.all([
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
  ]);
  const dtos = await Promise.all(items.map((row) => toItemDto(deps, row)));
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
    aiReady: aiConfig !== null,
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
 * so adding a hidden skill un-hides it. Matching changes on the next read; jobs already stored are
 * read for a new skill of the user's own on the next Refresh.
 */
export async function setSkill(deps: Deps, { name, state }: SetSkillInput): Promise<ProfileDto> {
  const clean = normalizeSkillName(name);
  if (clean.kind === "rejected") throw new AppError({ code: "invalid_input", message: clean.message });
  const mine = and(eq(userSkills.userId, deps.userId), eq(userSkills.key, clean.key));
  switch (state) {
    case "none":
      await deps.db.delete(userSkills).where(mine);
      break;
    case "hidden": {
      const confirmed = await deps.db
        .select({ text: facts.text })
        .from(facts)
        .where(and(eq(facts.userId, deps.userId), eq(facts.status, "confirmed")));
      if (!skillsInFacts({ texts: confirmed.map((f) => f.text) }).includes(clean.name)) {
        throw new AppError({
          code: "not_in_facts",
          message: `None of your confirmed facts names ${clean.name}, so there is nothing to hide. Remove it instead.`,
        });
      }
      await upsertSkill(deps, { ...clean, kind: "hidden" });
      break;
    }
    case "added": {
      const [[existing], [total]] = await Promise.all([
        deps.db.select({ kind: userSkills.kind }).from(userSkills).where(mine),
        deps.db
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
      await upsertSkill(deps, { ...clean, kind: "added" });
      break;
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
  return getProfile(deps);
}

async function upsertSkill(
  deps: Pick<Deps, "db" | "userId" | "clock">,
  { key, name, kind }: { key: string; name: string; kind: "added" | "hidden" },
): Promise<void> {
  const now = deps.clock.now();
  await deps.db
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
  { item, confirmOverCap }: { item: SplitItem; confirmOverCap: boolean },
): Promise<void> {
  const config = await loadAiConfig(deps);
  if (!config) return;
  const prompt = buildSplitPrompt({ item });
  await checkCap(deps, {
    capUsd: config.capUsd,
    estimateUsd: estimateUsd({ model: config.models.light, prompt, maxOutputTokens: SPLIT_MAX_TOKENS }),
    confirmOverCap,
  });
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
    }
  | { kind: "skipped"; reason: "item_deleted" | "newer_version" };

/**
 * Apply a split to the facts of one item version. The item row is locked, so a newer save that
 * bumped `rev` meanwhile wins: this older split is skipped and the newer one runs on its own.
 */
async function applySplit(
  deps: Deps,
  { itemId, rev, candidates }: { itemId: ItemId; rev: number; candidates: readonly FactCandidate[] },
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

  await ctx.step("Checking each fact against your text");
  const evidence = evidenceOf(row);
  const { kept, dropped } = checkCandidates({ candidates: candidates.map((c) => c.text), evidence });
  // A section must be in the text too; one that isn't is dropped and the fact shows ungrouped.
  const sectionOf = new Map(candidates.map((c) => [normalize(c.text), sectionIn({ section: c.section, evidence })]));
  const checked = kept.map((text) => ({ text, section: sectionOf.get(normalize(text)) ?? null }));

  await ctx.step("Comparing with your current facts");
  const applied = await applySplit(deps, { itemId, rev: row.rev, candidates: checked });
  if (applied.kind === "skipped") return applied;
  return { ...applied, method: config ? "ai" : "rules", dropped: dropped.map((d) => d.text) };
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
  await checkSplitCap(deps, { item: splitItem(row, await savedTexts(deps, row.id)), confirmOverCap });
  return startSplit(deps, { itemId: row.id, confirmOverCap });
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
 * Save CV text into the single `cv` item and start its split. Every save is a new version
 * (`rev + 1`), which is what makes a re-import diff against the facts of the last one.
 */
export async function saveCv(
  deps: Deps,
  {
    text,
    fileName = null,
    confirmOverCap = false,
  }: { text: string; fileName?: string | null; confirmOverCap?: boolean | undefined },
): Promise<ProfileDto> {
  const [cv] = await deps.db
    .select({ id: profileItems.id })
    .from(profileItems)
    .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")));
  const saved = await savedTexts(deps, cv?.id ?? null);
  await checkSplitCap(deps, { item: { kindLabel: "CV", title: "CV", body: text, skills: [], saved }, confirmOverCap });
  const now = deps.clock.now();
  const itemId = await deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: profileItems.id, rev: profileItems.rev, body: profileItems.body, fileName: profileItems.fileName })
      .from(profileItems)
      .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.kind, "cv")))
      .for("update");
    if (existing) {
      // Saving the same text again (to split it again) keeps the name of the file it came from.
      const name = fileName ?? (existing.body === text ? existing.fileName : null);
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

/** Read an uploaded PDF or DOCX, then save its text like a paste. The file itself is not kept. */
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
  return saveCv(deps, { text: result.text, fileName, confirmOverCap });
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
  } satisfies Partial<typeof profileItems.$inferInsert>;
}

/** Save a new add-on and split it into pending facts. */
export async function createAddon(deps: Deps, input: AddonInput): Promise<ProfileDto> {
  const values = addonValues(input);
  const confirmOverCap = input.confirmOverCap ?? false;
  await checkSplitCap(deps, { item: splitItem(values, []), confirmOverCap });
  const [created] = await deps.db
    .insert(profileItems)
    .values({ userId: deps.userId, ...values })
    .returning({ id: profileItems.id });
  if (!created) throw new Error("Could not save the add-on.");
  await startSplit(deps, { itemId: created.id, confirmOverCap });
  return getProfile(deps);
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
  if (resplit) await checkSplitCap(deps, { item: splitItem(values, await savedTexts(deps, itemId)), confirmOverCap });
  await deps.db
    .update(profileItems)
    .set({ ...values, updatedAt: deps.clock.now(), ...(resplit ? { rev: row.rev + 1 } : {}) })
    .where(eq(profileItems.id, itemId));
  if (resplit) await startSplit(deps, { itemId, confirmOverCap });
  return getProfile(deps);
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
