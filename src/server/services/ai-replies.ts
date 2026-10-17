import { z } from "zod";
import type { AiEligibilityAnswer } from "@/domain/eligibility";
import type { GithubProposal } from "@/domain/github-read";
import { cleanModelText, MAX_SUGGESTED_QUESTIONS } from "@/domain/prompts";
import { Eligibility } from "@/shared/enums";

/**
 * Parsers for the light tier's JSON replies. The sync pass, the workspace and `eval/run.ts` all
 * read replies through these, so the eval scores exactly what the app would accept.
 */

/** The reply as `schema`'s type, or null when it is not JSON of that shape. */
function parseReply<T>(text: string, schema: z.ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(cleanModelText(text));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const EligibilityReply = z.object({
  verdict: Eligibility,
  phrase: z.string().max(300).nullable().default(null),
});

/** `{ verdict, phrase }`, or null when the reply is not that JSON. */
export function parseEligibilityReply(text: string): AiEligibilityAnswer | null {
  return parseReply(text, EligibilityReply);
}

const QuestionsReply = z.object({ questions: z.array(z.string()) });

/**
 * The questions, trimmed, deduplicated (case-insensitive), at most 15, each within the 1,000
 * characters a typed question may have. Null when the reply is not the JSON asked for.
 */
export function parseQuestionsReply(text: string): string[] | null {
  const parsed = parseReply(text, QuestionsReply);
  if (!parsed) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parsed.questions) {
    const question = raw.replace(/\s+/g, " ").trim();
    const key = question.toLowerCase();
    if (question === "" || question.length > 1000 || seen.has(key)) continue;
    seen.add(key);
    out.push(question);
    if (out.length === MAX_SUGGESTED_QUESTIONS) break;
  }
  return out;
}

const GithubPicksReply = z.object({ files: z.array(z.string()) });

/** The paths the AI picked, unvalidated (the reader checks them against the tree). Null when unreadable. */
export function parseGithubPicksReply(text: string): string[] | null {
  return parseReply(text, GithubPicksReply)?.files ?? null;
}

const GithubFactsReply = z.object({
  facts: z.array(z.object({ text: z.string().max(2000), evidence: z.string().max(300) })),
});

/** `{ text, evidence }` proposals, unchecked (acceptGithubFacts drops the bad ones). Null when unreadable. */
export function parseGithubFactsReply(text: string): GithubProposal[] | null {
  return parseReply(text, GithubFactsReply)?.facts ?? null;
}
