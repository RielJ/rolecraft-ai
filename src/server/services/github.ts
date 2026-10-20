import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { diffFacts, dropRepeats } from "@/domain/facts-diff";
import {
  type AcceptedGithubFact,
  GITHUB_SECTION_TOKENS,
  GITHUB_TOKEN_CAP,
  type ProjectBundle,
} from "@/domain/github-read";
import { isOwnEmail } from "@/domain/local-scan";
import { API_PATCH_COMMITS, type CommitSource, FEATURE_LIST_TOKENS } from "@/domain/project-read";
import { type GithubUser, githubUserFor } from "@/domain/project-role";
import { parseProjectSource } from "@/domain/project-source";
import { FEATURE_MAX_TOKENS, GITHUB_FACTS_MAX_TOKENS, GITHUB_PICK_MAX_TOKENS, type Prompt } from "@/domain/prompts";
import type { OwnedRepo } from "@/domain/repo-scan";
import { normalize } from "@/domain/text";
import {
  type AddonInput,
  type GithubReadSummary,
  GithubReadTaskInput,
  type ItemId,
  type ProfileDto,
  type TaskDto,
} from "@/shared/api";
import type { ProjectRole } from "@/shared/enums";
import { type GithubLink, type GithubRepoRef, githubLabel, parseGithubLink } from "@/shared/github-link";
import { FolderReadError, type PublicRemote } from "../adapters/folder-read";
import { GithubError, type OpenCommitSource } from "../adapters/github";
import { CLONE_SHOW_TIMEOUT_MS, CloneError, MAX_CLONE_KB } from "../adapters/temp-clone";
import { facts, profileItems } from "../db/schema";
import { type AiConfig, checkCap, estimateUsd, loadAiConfig, requireAiConfig, runAi } from "./ai";
import { AppError, type Deps, notFound } from "./context";
import { aiChoose, aiPick, extractGithubFacts, type LightComplete } from "./github-extract";
import { createAddon, getProfile, loadContact, saveAddon } from "./profile";
import { latestTask, startTask, type TaskContext } from "./tasks";

/**
 * "Read from GitHub" on an add-on (decision 55), and "Read for facts" on an add-on added from a
 * folder (decision 81). Either runs as a `github_read` task: the reader fetches within the token
 * cap, the light tier groups the user's commits into features (folders), picks files and proposes
 * facts, the code drops facts whose evidence was not read, and the result is diffed against the
 * item's earlier read facts like a CV re-import (decision 47): new ones pending, missing pending
 * ones removed, missing confirmed ones kept for the user to Keep or Delete. A folder wins over a
 * GitHub link on the same add-on: it is the same repo, read locally.
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

/** Whose commits a folder read counts: emails from git and HB_GIT_EMAILS, and the GitHub noreply. */
type FolderUser = { user: string; from: GithubReadSummary["userFrom"]; emails: string[]; githubUser: string | null };

async function requireFolderUser(deps: Deps): Promise<FolderUser> {
  const { contact } = await loadContact(deps);
  const github = githubUserFor({ configured: deps.github.user, links: contact.links });
  const emails = await deps.folders.emails();
  if (!github && emails.length === 0) {
    throw new AppError({
      code: "needs_input",
      message:
        "Set your email with git config --global user.email, or list your commit emails in HB_GIT_EMAILS, so the read knows which commits are yours.",
    });
  }
  return {
    user: github?.user ?? emails[0] ?? "you",
    from: github && emails.length === 0 ? github.from : "git emails",
    emails,
    githubUser: github?.user ?? null,
  };
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

/** The worst case of one read: a feature grouping, a full pick prompt and a facts prompt at the token cap. */
export function worstCasePrompts(): { prompt: Prompt; maxOutputTokens: number }[] {
  const sized = (tokens: number): Prompt => ({
    system: "",
    messages: [{ role: "user", content: "x".repeat(tokens * 4) }],
  });
  return [
    { prompt: sized(FEATURE_LIST_TOKENS + 2_000), maxOutputTokens: FEATURE_MAX_TOKENS },
    { prompt: sized(GITHUB_SECTION_TOKENS.tree + 500), maxOutputTokens: GITHUB_PICK_MAX_TOKENS },
    { prompt: sized(GITHUB_TOKEN_CAP + 1000), maxOutputTokens: GITHUB_FACTS_MAX_TOKENS },
  ];
}

function oneReadUsd(config: AiConfig): number {
  return worstCasePrompts().reduce((sum, p) => sum + estimateUsd({ model: config.models.light, ...p }), 0);
}

/** One read's worst-case cost with the user's light model; null without an AI key. */
export async function readEstimateUsd(deps: Deps): Promise<number | null> {
  const config = await loadAiConfig(deps);
  return config ? oneReadUsd(config) : null;
}

async function checkReadCap(deps: Deps, { confirmOverCap }: { confirmOverCap: boolean }): Promise<void> {
  const config = await loadAiConfig(deps);
  if (!config) return;
  await checkCap(deps, { capUsd: config.capUsd, estimateUsd: oneReadUsd(config), confirmOverCap });
}

// ---------- Start ----------

type ItemRow = typeof profileItems.$inferSelect;

/** What an add-on is read from: its folder when it has one, else its GitHub link. */
type ReadSource = { kind: "folder"; path: string } | { kind: "github"; link: GithubLink };

function readSourceOf(row: Pick<ItemRow, "link" | "folder">): ReadSource | null {
  if (row.folder) return { kind: "folder", path: row.folder };
  const link = row.link ? parseGithubLink(row.link) : null;
  return link ? { kind: "github", link } : null;
}

async function loadReadable(deps: Deps, itemId: ItemId): Promise<{ row: ItemRow; source: ReadSource }> {
  const [row] = await deps.db
    .select()
    .from(profileItems)
    .where(and(eq(profileItems.id, itemId), eq(profileItems.userId, deps.userId)));
  if (!row || row.kind === "cv") throw notFound("That add-on");
  const source = readSourceOf(row);
  if (!source) {
    throw new AppError({
      code: "invalid_input",
      message:
        "Only a GitHub repo or pull request link, or a folder added from this machine, can be read. Other links are kept as they are.",
    });
  }
  return { row, source };
}

async function startRead(deps: Deps, { itemId, confirmOverCap }: { itemId: ItemId; confirmOverCap: boolean }) {
  const { row, source } = await loadReadable(deps, itemId);
  await requireAiConfig(deps);
  const who = source.kind === "folder" ? await requireFolderUser(deps) : await requireGithubUser(deps);
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

// ---------- Reads started with new add-ons ----------

/** What reads started with new add-ons need, found before anything is saved. */
export type ReadPlan = { estimateUsd: number; who: { github: GithubUser | null; folder: FolderUser | null } };

export const NO_READS: ReadPlan = { estimateUsd: 0, who: { github: null, folder: null } };

/**
 * Check what `github` repo reads and `folder` reads need (an AI key, and who the user is) and
 * estimate their worst-case cost, which joins the add-ons' own cap check: one check for the batch.
 */
export async function planReads(deps: Deps, { github, folder }: { github: number; folder: number }): Promise<ReadPlan> {
  if (github + folder === 0) return NO_READS;
  const config = await requireAiConfig(deps);
  return {
    estimateUsd: (github + folder) * oneReadUsd(config),
    who: {
      github: github > 0 ? await requireGithubUser(deps) : null,
      folder: folder > 0 ? await requireFolderUser(deps) : null,
    },
  };
}

/**
 * Read new add-ons for facts one at a time, in the order given (decision 81). Each gets its own
 * task at once, so each add-on shows its progress; a task waits for the one before it to finish,
 * however that ends. The cap was checked for the batch, so the reads don't stop at it.
 */
export async function queueReads(
  deps: Deps,
  { items, plan }: { items: readonly { itemId: ItemId; source: "github" | "folder" }[]; plan: ReadPlan },
): Promise<void> {
  let previous: Promise<void> = Promise.resolve();
  for (const [i, { itemId, source }] of items.entries()) {
    const who = plan.who[source];
    if (!who) throw new Error(`No ${source} user planned for this read.`);
    const before = previous;
    let release = () => {};
    previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input: GithubReadTaskInput = { itemId };
    try {
      await startTask(deps, {
        kind: "github_read",
        input,
        run: async (ctx) => {
          try {
            if (i > 0) {
              await ctx.step(i === 1 ? "Waiting for the read before it" : `Waiting for the ${i} reads before it`);
              await before;
            }
            return await runRead(deps, ctx, { itemId, who, confirmOverCap: true });
          } finally {
            release();
          }
        },
      });
    } catch (err) {
      release();
      throw err;
    }
  }
}

/** Save a typed add-on; with `read`, also read it for facts once saved (decision 81). */
export async function addAddon(deps: Deps, input: AddonInput): Promise<ProfileDto> {
  if (!input.read) return createAddon(deps, input);
  const source = input.folder ? "folder" : input.link && parseGithubLink(input.link) ? "github" : null;
  if (!source) {
    throw new AppError({
      code: "invalid_input",
      message: "Only a GitHub repo or pull request link, or a folder on this machine, can be read for facts.",
    });
  }
  const plan = await planReads(deps, { github: source === "github" ? 1 : 0, folder: source === "folder" ? 1 : 0 });
  const itemId = await saveAddon(deps, input, { extraUsd: plan.estimateUsd });
  await queueReads(deps, { items: [{ itemId, source }], plan });
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
  { itemId, who, confirmOverCap }: { itemId: ItemId; who: GithubUser | FolderUser; confirmOverCap: boolean },
): Promise<ReadOutcome> {
  const [row] = await deps.db.select().from(profileItems).where(eq(profileItems.id, itemId));
  const source = row ? readSourceOf(row) : null;
  if (!row || !source) return { kind: "skipped", reason: "item_deleted" };
  const config = await requireAiConfig(deps);
  const complete =
    (purpose: "github"): LightComplete =>
    async ({ prompt, maxOutputTokens }) =>
      (await runAi(deps, { tier: "light", purpose, taskId: ctx.taskId, prompt, maxOutputTokens, confirmOverCap })).text;

  let bundle: ProjectBundle;
  if (source.kind === "folder") {
    const folderUser = "emails" in who ? who : await requireFolderUser(deps);
    bundle = await readFolder(deps, ctx, { path: source.path, who: folderUser, complete: complete("github") });
  } else {
    await ctx.step(`Reading github.com/${githubLabel(source.link)} as ${who.user}`);
    const emails = new Set(await deps.folders.emails());
    const isMine = (email: string) => isOwnEmail({ email, emails, githubUser: who.user });
    try {
      bundle = await deps.github.read({
        link: source.link,
        user: who.user,
        pick: aiPick(complete("github")),
        choose: aiChoose(complete("github")),
        isMine,
        source: openCommitSource(deps, ctx, isMine),
        step: ctx.step,
      });
    } catch (err) {
      if (err instanceof GithubError) throw githubAppError(err);
      throw err;
    }
  }

  await ctx.step("Finding facts with AI");
  const extraction = await extractGithubFacts({
    bundle,
    complete: complete("github"),
    model: config.models.light,
    onRetry: () => ctx.step("Asking the AI again for a readable reply"),
  });

  await ctx.step("Comparing with your current facts from this project");
  const applied = await applyRead(deps, {
    itemId,
    source: { link: row.link, folder: row.folder },
    isPrivate: bundle.private,
    role: bundle.framing,
    kept: extraction.kept,
  });
  if (applied.kind === "skipped") return applied;
  return {
    kind: "applied",
    user: who.user,
    userFrom: who.from,
    via: bundle.kind === "folder" ? "folder" : deps.github.mode,
    private: bundle.private,
    tokens: bundle.tokens,
    cap: GITHUB_TOKEN_CAP,
    filesRead: bundle.kind === "pull" ? [] : bundle.files.map((f) => f.path),
    commitsRead: bundle.commits.length,
    features: bundle.features.map((f) => f.name),
    share: bundle.share,
    commitsFrom: bundle.kind === "folder" ? "folder" : bundle.kind === "repo" ? bundle.commitsFrom : null,
    ...applied.counts,
    dropped: extraction.dropped,
  };
}

/**
 * Where a GitHub repo read's commits and hunks come from (decision 81): a clone in the projects
 * folder (free, and has unpushed work); else, with gh or fixtures, the API; else a blob-less temp
 * clone of a repo up to 500 MB; else, or when the clone fails, the API for 10 commits.
 */
function openCommitSource(deps: Deps, ctx: TaskContext, isMine: (email: string) => boolean): OpenCommitSource {
  return async ({ owner, repo, branch, sizeKb, api }): Promise<CommitSource> => {
    const local = deps.projects ? await deps.projects.findClone({ owner, repo }).catch(() => null) : null;
    if (local) {
      await ctx.step(`Reading your commits from your clone in ${local}`);
      return deps.folders.commits({ path: local, isMine, from: "local clone" });
    }
    if (deps.github.mode !== "public") return api({ maxPatchCommits: Number.POSITIVE_INFINITY });
    if (deps.cloner && sizeKb <= MAX_CLONE_KB) {
      await ctx.step(`Cloning ${owner}/${repo} without file contents, to read your changes`);
      try {
        const clone = await deps.cloner.clone({ owner, repo, branch });
        return deps.folders.commits({
          path: clone.path,
          isMine,
          from: "temp clone",
          sized: false,
          showLimits: { timeoutMs: CLONE_SHOW_TIMEOUT_MS },
          close: clone.close,
        });
      } catch (err) {
        if (!(err instanceof CloneError)) throw err;
        await ctx.step(`${err.message} Reading ${API_PATCH_COMMITS} commits through the API instead`);
      }
    }
    return api({ maxPatchCommits: API_PATCH_COMMITS });
  };
}

/** Read an add-on's folder with git (decision 81); a folder that can't be read fails the task. */
async function readFolder(
  deps: Deps,
  ctx: TaskContext,
  { path, who, complete }: { path: string; who: FolderUser; complete: LightComplete },
): Promise<ProjectBundle> {
  const emails = new Set(who.emails);
  await ctx.step(`Reading ${path} with git`);
  try {
    const resolved = await deps.folders.resolve(path);
    return await deps.folders.deep({
      path: resolved,
      user: who.user,
      isMine: (email) => isOwnEmail({ email, emails, githubUser: who.githubUser }),
      choose: aiChoose(complete),
      pick: aiPick(complete),
      publicRemote: publicRemote(deps),
      step: ctx.step,
    });
  } catch (err) {
    if (err instanceof FolderReadError) throw new AppError({ code: "needs_input", message: err.message });
    if (err instanceof Error && /is not (a folder|an absolute path)/.test(err.message)) {
      throw new AppError({
        code: "needs_input",
        message: `${err.message} Was it moved? Edit the add-on or add it again.`,
      });
    }
    throw err;
  }
}

const PublicRepo = z.object({ private: z.boolean(), full_name: z.string(), html_url: z.string() });

/**
 * Whether a folder's remote is public (decision 81): GitHub's API or an allowed GitLab answers
 * for it without login. Anything else, an error included, is private.
 */
export function publicRemote(deps: Pick<Deps, "http" | "gitlab">): PublicRemote {
  return async (remote) => {
    const parsed = parseProjectSource({ raw: remote, gitlabHosts: deps.gitlab.hosts });
    if (parsed.kind === "github" && parsed.link.kind === "repo") {
      const { owner, repo } = parsed.link;
      const res = await deps.http.getText(`https://api.github.com/repos/${owner}/${repo}`, {
        accept: "application/vnd.github+json",
      });
      const info = PublicRepo.safeParse(JSON.parse(res.body));
      if (!info.success || info.data.private) return null;
      return { host: "github", web: info.data.html_url, name: info.data.full_name };
    }
    if (parsed.kind === "gitlab") {
      const about = await deps.gitlab.about(parsed);
      return { host: "gitlab", web: about.webUrl, name: parsed.path };
    }
    return null;
  };
}

/**
 * Diff the kept facts against the item's read facts only, so a re-split of the add-on's text and
 * a re-read never remove each other's facts. The item row is locked; a link or folder edited
 * during the read wins, and this read is skipped.
 */
async function applyRead(
  deps: Deps,
  {
    itemId,
    source,
    isPrivate,
    role,
    kept,
  }: {
    itemId: ItemId;
    source: { link: string | null; folder: string | null };
    isPrivate: boolean;
    /** Own project or contribution, from the commit share (decision 82). The user's choice still wins. */
    role: ProjectRole;
    kept: AcceptedGithubFact[];
  },
) {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ githubRev: profileItems.githubRev, link: profileItems.link, folder: profileItems.folder })
      .from(profileItems)
      .where(eq(profileItems.id, itemId))
      .for("update");
    if (!locked) return { kind: "skipped", reason: "item_deleted" } as const;
    if (locked.link !== source.link || locked.folder !== source.folder) {
      return { kind: "skipped", reason: "link_changed" } as const;
    }
    const rev = locked.githubRev + 1;
    await tx
      .update(profileItems)
      .set({ githubRev: rev, githubPrivate: isPrivate, projectRoleRead: role })
      .where(eq(profileItems.id, itemId));

    const rows = await tx
      .select({ id: facts.id, text: facts.text, status: facts.status, origin: facts.origin })
      .from(facts)
      .where(eq(facts.itemId, itemId));
    const existing = rows.filter((f) => f.origin === "github");
    const diff = diffFacts({ existing, candidates: kept.map((k) => k.text) });
    // A new fact that a staying fact (from the add-on's own text or an earlier read) or an earlier
    // new fact already says is left out.
    const fresh = dropRepeats({
      candidates: diff.added,
      others: rows.filter((f) => !diff.removed.includes(f.id)).map((f) => f.text),
    });
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
    const added = kept.filter((k) => fresh.kept.includes(k.text.trim()));
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

// ---------- Finding the user's repos (decision 78) ----------

/** The reader's listing, or 409 when it can't list (anything but gh, or the fixture in tests). */
export async function listOwned(deps: Deps): Promise<{ user: string; repos: OwnedRepo[] }> {
  const list = deps.github.list;
  if (!list) {
    throw new AppError({
      code: "needs_input",
      message: "Finding your repos needs the gh CLI. Set HB_GITHUB=gh and HB_GITHUB_USER, then restart the app.",
    });
  }
  const { user } = await requireGithubUser(deps);
  try {
    return { user, repos: await list({ user }) };
  } catch (err) {
    if (err instanceof GithubError) throw githubAppError(err);
    throw err;
  }
}

/** Repos the user's add-ons already link (repo links only; a pull request link is a contribution). */
export async function linkedRepos(deps: Pick<Deps, "db" | "userId">): Promise<GithubRepoRef[]> {
  const rows = await deps.db
    .select({ link: profileItems.link })
    .from(profileItems)
    .where(eq(profileItems.userId, deps.userId));
  return rows.flatMap(({ link }) => {
    const parsed = link ? parseGithubLink(link) : null;
    return parsed?.kind === "repo" ? [{ owner: parsed.owner, repo: parsed.repo }] : [];
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
