import {
  type AcceptedGithubFact,
  acceptGithubFacts,
  type DroppedGithubFact,
  type GithubBundle,
  type GithubProposal,
  MAX_GITHUB_PICKS,
} from "@/domain/github-read";
import {
  buildGithubFactsPrompt,
  buildGithubFactsRetryPrompt,
  buildGithubPickPrompt,
  GITHUB_FACTS_MAX_TOKENS,
  GITHUB_PICK_MAX_TOKENS,
  type Prompt,
} from "@/domain/prompts";
import type { GithubPick } from "../adapters/github";
import { parseGithubFactsReply, parseGithubPicksReply } from "./ai-replies";
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
  bundle: GithubBundle;
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
      message: `The ${model} reply could not be read twice. Read from GitHub again to retry.`,
    });
  }
  return { proposals, ...acceptGithubFacts({ bundle, proposals }) };
}
