import {
  type AcceptedGithubFact,
  acceptGithubFacts,
  type DroppedGithubFact,
  type GithubProposal,
  MAX_GITHUB_PICKS,
  type ProjectBundle,
  truncateTokens,
} from "@/domain/github-read";
import {
  biggestCommits,
  type ChooseCommits,
  commitList,
  FEATURE_LIST_TOKENS,
  MIN_GROUPING_COMMITS,
  validateFeatures,
} from "@/domain/project-read";
import {
  buildFeaturePrompt,
  buildGithubFactsPrompt,
  buildGithubFactsRetryPrompt,
  buildGithubPickPrompt,
  FEATURE_MAX_TOKENS,
  GITHUB_FACTS_MAX_TOKENS,
  GITHUB_PICK_MAX_TOKENS,
  type Prompt,
} from "@/domain/prompts";
import type { GithubPick } from "../adapters/github";
import { parseFeaturesReply, parseGithubFactsReply, parseGithubPicksReply } from "./ai-replies";
import { AppError } from "./context";

/**
 * The two light-tier steps of a GitHub read (decision 55): pick files, then propose facts and keep
 * only those whose evidence was read. The service passes `runAi`; `eval/run.ts` passes the model
 * directly, so the eval scores exactly this code. Nothing here touches the database.
 */

export type LightComplete = (input: { prompt: Prompt; maxOutputTokens: number }) => Promise<string>;

/** The pick callback for the reader. An unreadable reply picks nothing rather than failing the read. */
export function aiPick(complete: LightComplete): GithubPick {
  return async ({ repo, description, tree, already }) => {
    if (tree.length === 0) return [];
    const prompt = buildGithubPickPrompt({ repo, description, tree, already, max: MAX_GITHUB_PICKS });
    const reply = await complete({ prompt, maxOutputTokens: GITHUB_PICK_MAX_TOKENS });
    return parseGithubPicksReply(reply) ?? [];
  };
}

/** README tokens shown to the grouping call. */
const FEATURE_README_TOKENS = 1_500;

/**
 * The commit choice for a read (decision 81): the light model groups the user's commits into
 * features and picks 2 or 3 per feature. Fewer than 5 commits, or a reply with no usable feature,
 * reads the biggest commits instead.
 */
export function aiChoose(complete: LightComplete): ChooseCommits {
  return async ({ name, user, readme, commits }) => {
    const fallback = { features: [], shas: biggestCommits({ commits }) };
    if (commits.length < MIN_GROUPING_COMMITS) return fallback;
    const { lines, more } = commitList({ commits, maxTokens: FEATURE_LIST_TOKENS });
    const prompt = buildFeaturePrompt({
      name,
      user,
      readme: readme ? truncateTokens(readme, FEATURE_README_TOKENS).text : null,
      lines,
      more,
    });
    const parsed = parseFeaturesReply(await complete({ prompt, maxOutputTokens: FEATURE_MAX_TOKENS }));
    const features = parsed ? validateFeatures({ features: parsed, commits }) : [];
    return features.length ? { features, shas: features.flatMap((f) => f.shas) } : fallback;
  };
}

export type GithubExtraction = {
  /** Everything the model proposed, before the code checks. */
  proposals: GithubProposal[];
  kept: AcceptedGithubFact[];
  dropped: DroppedGithubFact[];
};

/** Propose facts, with one retry on an unreadable reply, then drop any whose evidence was not read. */
export async function extractGithubFacts({
  bundle,
  complete,
  model,
  onRetry = async () => {},
}: {
  bundle: ProjectBundle;
  complete: LightComplete;
  /** For the error message. */
  model: string;
  onRetry?: () => Promise<void>;
}): Promise<GithubExtraction> {
  const prompt = buildGithubFactsPrompt({ bundle });
  const first = await complete({ prompt, maxOutputTokens: GITHUB_FACTS_MAX_TOKENS });
  let proposals = parseGithubFactsReply(first);
  if (proposals === null) {
    await onRetry();
    const retry = await complete({
      prompt: buildGithubFactsRetryPrompt({ prompt, reply: first }),
      maxOutputTokens: GITHUB_FACTS_MAX_TOKENS,
    });
    proposals = parseGithubFactsReply(retry);
  }
  if (proposals === null) {
    throw new AppError({
      code: "ai_unavailable",
      message: `The ${model} reply could not be read twice. Read the project again to retry.`,
    });
  }
  return { proposals, ...acceptGithubFacts({ bundle, proposals }) };
}
