import { and, eq, inArray, sql } from "drizzle-orm";
import { diffFacts } from "@/domain/facts-diff";
import {
  type GithubLink,
  type GithubRepoRef,
  githubLabel,
  githubProfileUser,
  parseGithubLink,
} from "@/domain/github-link";
import { type AcceptedGithubFact, GITHUB_SECTION_TOKENS, GITHUB_TOKEN_CAP } from "@/domain/github-read";
import { GITHUB_FACTS_MAX_TOKENS, GITHUB_PICK_MAX_TOKENS, type Prompt } from "@/domain/prompts";
import { normalize } from "@/domain/text";
import { type GithubReadSummary, GithubReadTaskInput, type ItemId, type ProfileDto, type TaskDto } from "@/shared/api";
import { GithubError } from "../adapters/github";
import { facts, profileItems } from "../db/schema";
import { checkCap, estimateUsd, loadAiConfig, requireAiConfig, runAi } from "./ai";
import { AppError, type Deps, notFound } from "./context";
import { aiPick, extractGithubFacts, type LightComplete } from "./github-extract";
import { getProfile, loadContact } from "./profile";
import { latestTask, startTask, type TaskContext } from "./tasks";

/**
 * "Read from GitHub" on an add-on (decision 55). The read runs as a `github_read` task: the
 * reader fetches within the token cap, the light tier picks files and proposes facts, the code
 * drops facts whose evidence was not read, and the result is diffed against the item's earlier
 * GitHub facts like a CV re-import (decision 47): new ones pending, missing pending ones removed,
 * missing confirmed ones kept for the user to Keep or Delete.
 */

// ---------- Errors ----------

export function githubAppError(err: GithubError): AppError {
  switch (err.kind) {
    case "rate_limited":
      return new AppError({ code: "github_rate_limited", message: err.message });
    case "account_mismatch":
      return new AppError({ code: "github_account", message: err.message });
    case "not_found":
      return new AppError({ code: "not_found", message: err.message });
    case "unavailable":
    case "too_large":
      return new AppError({ code: "github_unavailable", message: err.message });
    default: {
      const _exhaustive: never = err.kind;
      return _exhaustive;
    }
  }
}

// ---------- Whose commits ----------

export type GithubUser = { user: string; from: GithubReadSummary["userFrom"] };

/**
 * The account whose commits count as the user's: `HB_GITHUB_USER` when set (always with gh, which
 * is pinned to it), else the first `github.com/<name>` profile link in the contact links.
 */
export function githubUserFor({
  configured,
  links,
}: {
  configured: string | null;
  links: readonly string[];
}): GithubUser | null {
  if (configured) return { user: configured, from: "HB_GITHUB_USER" };
  for (const link of links) {
    const user = githubProfileUser(link);
    if (user) return { user, from: "profile link" };
  }
  return null;
}

async function requireGithubUser(deps: Deps): Promise<GithubUser> {
  const { contact } = await loadContact(deps);
  const found = githubUserFor({ configured: deps.github.user, links: contact.links });
  if (!found) {
    throw new AppError({
      code: "needs_input",
      message:
        "Add your GitHub profile link (https://github.com/<you>) to your contact links, or set HB_GITHUB_USER, so the read knows which commits are yours.",
    });
  }
  return found;
}

// ---------- Cap ----------

/** The worst case of one read: a full pick prompt and a facts prompt at the token cap. */
function worstCasePrompts(): { prompt: Prompt; maxOutputTokens: number }[] {
  const sized = (tokens: number): Prompt => ({
    system: "",
    messages: [{ role: "user", content: "x".repeat(tokens * 4) }],
  });
  return [
    { prompt: sized(GITHUB_SECTION_TOKENS.tree + 500), maxOutputTokens: GITHUB_PICK_MAX_TOKENS },
    { prompt: sized(GITHUB_TOKEN_CAP + 1000), maxOutputTokens: GITHUB_FACTS_MAX_TOKENS },
  ];
}

async function checkReadCap(deps: Deps, { confirmOverCap }: { confirmOverCap: boolean }): Promise<void> {
  const config = await loadAiConfig(deps);
  if (!config) return;
  const estimate = worstCasePrompts().reduce((sum, p) => sum + estimateUsd({ model: config.models.light, ...p }), 0);
  await checkCap(deps, { capUsd: config.capUsd, estimateUsd: estimate, confirmOverCap });
}

// ---------- Start ----------

type ItemRow = typeof profileItems.$inferSelect;

async function loadReadable(deps: Deps, itemId: ItemId): Promise<{ row: ItemRow; link: GithubLink }> {
  const [row] = await deps.db
    .select()
    .from(profileItems)
    .where(and(eq(profileItems.id, itemId), eq(profileItems.userId, deps.userId)));
  if (!row || row.kind === "cv") throw notFound("That add-on");
  const link = row.link ? parseGithubLink(row.link) : null;
  if (!link) {
    throw new AppError({
      code: "invalid_input",
      message: "Only a GitHub repo or pull request link can be read. Other links are kept as they are.",
    });
  }
  return { row, link };
}

async function startRead(deps: Deps, { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean }) {
  const { row } = await loadReadable(deps, itemId);
  await requireAiConfig(deps);
  const who = await requireGithubUser(deps);
  const running = await latestTask(deps, { kind: "github_read", inputMatches: { itemId } });
  if (running?.task.status === "running") {
    throw new AppError({
      code: "invalid_input",
      message: `"${row.title}" is being read already. Wait for it to finish.`,
    });
  }
  await checkReadCap(deps, { confirmOverCap });
  const input: GithubReadTaskInput = { itemId };
  return startTask(deps, {
    kind: "github_read",
    input,
    run: (ctx) => runRead(deps, ctx, { itemId, who, confirmOverCap }),
  });
}

/** Start a read (first read or Re-read) of an add-on's GitHub link. */
export async function readGithub(
  deps: Deps,
  { itemId, confirmOverCap = false }: { itemId: ItemId; confirmOverCap?: boolean | undefined },
): Promise<ProfileDto> {
  await startRead(deps, { itemId, confirmOverCap });
  return getProfile(deps);
}

/** Retry handler for `github_read` tasks. */
export async function retryGithubRead(
  deps: Deps,
  input: unknown,
  { confirmOverCap }: { confirmOverCap: boolean },
): Promise<TaskDto> {
  const parsed = GithubReadTaskInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError({ code: "invalid_input", message: "This task's input is unreadable. Read from GitHub again." });
  }
  return startRead(deps, { itemId: parsed.data.itemId, confirmOverCap });
}

// ---------- Run ----------

type ReadOutcome =
  | ({ kind: "applied" } & GithubReadSummary)
  | { kind: "skipped"; reason: "item_deleted" | "link_changed" };

async function runRead(
  deps: Deps,
  ctx: TaskContext,
  { itemId, who, confirmOverCap }: { itemId: ItemId; who: GithubUser; confirmOverCap: boolean },
): Promise<ReadOutcome> {
  const [row] = await deps.db.select().from(profileItems).where(eq(profileItems.id, itemId));
  const link = row?.link ? parseGithubLink(row.link) : null;
  if (!row || !link) return { kind: "skipped", reason: "item_deleted" };
  const config = await requireAiConfig(deps);
  const complete =
    (purpose: "github"): LightComplete =>
    async ({ prompt, maxOutputTokens }) =>
      (await runAi(deps, { tier: "light", purpose, taskId: ctx.taskId, prompt, maxOutputTokens, confirmOverCap })).text;

  await ctx.step(`Reading github.com/${githubLabel(link)} as ${who.user}`);
  let bundle: Awaited<ReturnType<Deps["github"]["read"]>>;
  try {
    bundle = await deps.github.read({ link, user: who.user, pick: aiPick(complete("github")), step: ctx.step });
  } catch (err) {
    if (err instanceof GithubError) throw githubAppError(err);
    throw err;
  }

  await ctx.step("Finding facts with AI");
  const extraction = await extractGithubFacts({
    bundle,
    complete: complete("github"),
    model: config.models.light,
    onRetry: () => ctx.step("Asking the AI again for a readable reply"),
  });

  await ctx.step("Comparing with your current GitHub facts");
  const applied = await applyRead(deps, {
    itemId,
    link: row.link ?? "",
    isPrivate: bundle.private,
    kept: extraction.kept,
  });
  if (applied.kind === "skipped") return applied;
  return {
    kind: "applied",
    user: who.user,
    userFrom: who.from,
    via: deps.github.mode,
    private: bundle.private,
    tokens: bundle.tokens,
    cap: GITHUB_TOKEN_CAP,
    filesRead: bundle.kind === "repo" ? bundle.files.map((f) => f.path) : [],
    commitsRead: bundle.commits.length,
    ...applied.counts,
    dropped: extraction.dropped,
  };
}

/**
 * Diff the kept facts against the item's GitHub facts only, so a re-split of the add-on's text and
 * a GitHub re-read never remove each other's facts. The item row is locked; a link edited during
 * the read wins, and this read is skipped.
 */
async function applyRead(
  deps: Deps,
  { itemId, link, isPrivate, kept }: { itemId: ItemId; link: string; isPrivate: boolean; kept: AcceptedGithubFact[] },
) {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ githubRev: profileItems.githubRev, link: profileItems.link })
      .from(profileItems)
      .where(eq(profileItems.id, itemId))
      .for("update");
    if (!locked) return { kind: "skipped", reason: "item_deleted" } as const;
    if (locked.link !== link) return { kind: "skipped", reason: "link_changed" } as const;
    const rev = locked.githubRev + 1;
    await tx.update(profileItems).set({ githubRev: rev, githubPrivate: isPrivate }).where(eq(profileItems.id, itemId));

    const existing = await tx
      .select({ id: facts.id, text: facts.text, status: facts.status })
      .from(facts)
      .where(and(eq(facts.itemId, itemId), eq(facts.origin, "github")));
    const diff = diffFacts({ existing, candidates: kept.map((k) => k.text) });
    const byText = new Map(kept.map((k) => [normalize(k.text), k.evidence]));
    for (const fact of existing.filter((f) => diff.unchanged.includes(f.id))) {
      // The same fact keeps its id and status; its link follows the latest read.
      const evidence = byText.get(normalize(fact.text));
      await tx
        .update(facts)
        .set({ seenRev: rev, ...(evidence ? { evidence } : {}) })
        .where(eq(facts.id, fact.id));
    }
    if (diff.removed.length) await tx.delete(facts).where(inArray(facts.id, diff.removed));
    const added = kept.filter((k) => diff.added.includes(k.text.trim()));
    if (added.length) {
      await tx.insert(facts).values(
        added.map((k) => ({
          userId: deps.userId,
          itemId,
          text: k.text,
          seenRev: rev,
          origin: "github" as const,
          evidence: k.evidence,
        })),
      );
    }
    return {
      kind: "applied",
      counts: {
        added: added.length,
        unchanged: diff.unchanged.length,
        removed: diff.removed.length,
        vanished: diff.vanished.length,
      },
    } as const;
  });
}

// ---------- Export filter ----------

/**
 * Every private repo the user's facts came from: items whose last read found the repo private,
 * and the repo of every fact whose evidence is private. Exports strip links into these.
 */
export async function privateGithubRepos(deps: Pick<Deps, "db" | "userId">): Promise<GithubRepoRef[]> {
  const [items, evidence] = await Promise.all([
    deps.db
      .select({ link: profileItems.link })
      .from(profileItems)
      .where(and(eq(profileItems.userId, deps.userId), eq(profileItems.githubPrivate, true))),
    deps.db
      .selectDistinct({ repo: sql<string>`${facts.evidence}->>'repo'` })
      .from(facts)
      .where(and(eq(facts.userId, deps.userId), sql`(${facts.evidence}->>'private')::boolean`)),
  ]);
  const repos = new Map<string, GithubRepoRef>();
  for (const { link } of items) {
    const parsed = link ? parseGithubLink(link) : null;
    if (parsed) repos.set(`${parsed.owner}/${parsed.repo}`.toLowerCase(), { owner: parsed.owner, repo: parsed.repo });
  }
  for (const { repo } of evidence) {
    const [owner, name] = repo.split("/");
    if (owner && name) repos.set(repo.toLowerCase(), { owner, repo: name });
  }
  return [...repos.values()];
}
