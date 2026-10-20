import { z } from "zod";
import type { AiEligibilityAnswer } from "@/domain/eligibility";
import type { GithubProposal } from "@/domain/github-read";
import { cleanModelText, MAX_SUGGESTED_QUESTIONS } from "@/domain/prompts";
import type { RequirementsReply as RequirementsReplyShape } from "@/domain/requirements";
import { MAX_PROJECT_LINES, type TailorOp } from "@/domain/tailor";
import { FactKey } from "@/shared/api";
import { Eligibility, RequirementWeight } from "@/shared/enums";

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

const FeaturesReply = z.object({
  features: z.array(z.object({ name: z.string().max(300), commits: z.array(z.string().max(80)).max(20) })).max(30),
});

/** The features the light model grouped commits into, unvalidated (validateFeatures checks them). Null when unreadable. */
export function parseFeaturesReply(text: string): { name: string; commits: string[] }[] | null {
  return parseReply(text, FeaturesReply)?.features ?? null;
}

const GithubFactsReply = z.object({
  facts: z.array(z.object({ text: z.string().max(2000), evidence: z.string().max(300) })),
});

/** `{ text, evidence }` proposals, unchecked (acceptGithubFacts drops the bad ones). Null when unreadable. */
export function parseGithubFactsReply(text: string): GithubProposal[] | null {
  return parseReply(text, GithubFactsReply)?.facts ?? null;
}

const RequirementsReply = z.object({
  role: z.string().default(""),
  requirements: z.array(
    z.object({ text: z.string(), weight: RequirementWeight.catch("must"), facts: z.array(z.string()).default([]) }),
  ),
  context: z.array(z.object({ role: z.string(), fact: z.string() })).default([]),
});

/**
 * A requirement map reply (decision 73), unvalidated against the facts (`toRequirementMap` does
 * that). An unknown weight reads as "must". Null when the reply is not the JSON asked for.
 */
export function parseRequirementsReply(text: string): RequirementsReplyShape | null {
  return parseReply(text, RequirementsReply);
}

const LineId = z.string().regex(/^L[1-9]\d*$/);
const OpText = z.string().min(1).max(1000);
const OpCommon = {
  reasons: z.array(z.string()).default([]),
  note: z.string().max(300).nullable().default(null),
};
const OpFacts = z.array(FactKey).default([]);
const TailorOpReply = z.discriminatedUnion("op", [
  z.object({ op: z.literal("summary"), text: OpText, facts: OpFacts, ...OpCommon }),
  z.object({ op: z.literal("order"), parent: LineId, lines: z.array(LineId).min(1), ...OpCommon }),
  z.object({ op: z.literal("reword"), line: LineId, text: OpText, facts: OpFacts, ...OpCommon }),
  z.object({ op: z.literal("remove"), line: LineId, ...OpCommon }),
  z.object({ op: z.literal("add"), after: LineId, text: OpText, facts: OpFacts, ...OpCommon }),
  z.object({
    op: z.literal("project"),
    project: z.string().regex(/^PROJECT-[1-9]\d*$/),
    lines: z
      .array(z.object({ text: OpText, facts: OpFacts }))
      .min(1)
      .max(MAX_PROJECT_LINES),
    ...OpCommon,
  }),
]);
const TailorReply = z.object({ ops: z.array(z.unknown()).max(60) });

/**
 * A tailor reply (decision 75): the ops in the shapes asked for, unvalidated against the CV
 * (`validateEdits` does that), and how many were not in any of those shapes. Null when the reply
 * is not `{"ops": [...]}`.
 */
export function parseTailorReply(text: string): { ops: TailorOp[]; unreadable: number } | null {
  const parsed = parseReply(text, TailorReply);
  if (!parsed) return null;
  const ops: TailorOp[] = [];
  for (const raw of parsed.ops) {
    const op = TailorOpReply.safeParse(raw);
    if (op.success) ops.push(op.data);
  }
  return { ops, unreadable: parsed.ops.length - ops.length };
}
