import { GITHUB_SECTION_TOKENS, type GithubCommit, type TokenBudget } from "@/domain/github-read";
import {
  type ChooseCommits,
  type CommitPatch,
  type CommitShare,
  type CommitSource,
  capPicks,
  type Feature,
  fitPatches,
  listedCommits,
  PATCH_TOKENS,
} from "@/domain/project-read";
import { estimateTokens } from "@/domain/prompts";

/**
 * The commit half of a read (decision 81), the same for a folder and a GitHub repo: list the
 * user's commits, let `choose` group them into features, list the picked ones first for the facts
 * prompt, and read the picked commits' hunks within what the budget has left.
 */

export type CommitEvidence = {
  commits: GithubCommit[];
  share: CommitShare | null;
  features: Feature[];
  patches: CommitPatch[];
  /** Of the listed commits, those on the remote; null when every one is. */
  pushed: string[] | null;
};

export async function readCommitEvidence({
  source,
  choose,
  name,
  user,
  readme,
  budget,
  step,
}: {
  source: CommitSource;
  choose: ChooseCommits;
  name: string;
  user: string;
  readme: string | null;
  budget: TokenBudget;
  step: (text: string) => Promise<void>;
}): Promise<CommitEvidence> {
  await step(`Reading ${user}'s commits`);
  const { mine, share } = await source.list();

  if (mine.length) await step("Grouping your commits into features");
  const chosen = mine.length ? await choose({ name, user, readme, commits: mine }) : { features: [], shas: [] };
  const choice = capPicks({ choice: chosen, max: source.maxPatchCommits });

  const commits = listedCommits({ commits: mine, picked: choice.shas, maxTokens: GITHUB_SECTION_TOKENS.commits });
  for (const c of commits) budget.take(`${c.sha.slice(0, 12)} ${c.subject}`, GITHUB_SECTION_TOKENS.commits);

  const bySha = new Map(mine.map((c) => [c.sha, c]));
  const picked = choice.shas.flatMap((sha) => bySha.get(sha) ?? []);
  const raw = picked.length ? await source.patches(picked, step) : [];
  const patches = fitPatches({ patches: raw, maxTokens: Math.min(PATCH_TOKENS, budget.left()) });
  for (const p of patches) budget.take(p.text, estimateTokens(p.text) + 1);

  const pushed = source.pushed ? await source.pushed(commits.map((c) => c.sha)) : null;
  return { commits, share, features: choice.features, patches, pushed };
}
