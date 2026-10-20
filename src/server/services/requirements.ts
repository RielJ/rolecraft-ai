import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Prompt, PromptFact } from "@/domain/prompts";
import { buildRequirementsRetryPrompt, REQUIREMENTS_MAX_TOKENS, toRequirementMap } from "@/domain/requirements";
import type { OpportunityId, RequirementMap, TaskId } from "@/shared/api";
import { opportunities } from "../db/schema";
import { runAi } from "./ai";
import { parseRequirementsReply } from "./ai-replies";
import type { Deps } from "./context";

/** The stored key for a map source (`requirementMapSource`). */
export function requirementMapKey(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Read the posting's requirements with one writing-tier call (decision 73), retry once when the
 * reply can't be read, and store the map with its key. Returns null when both replies are unreadable:
 * the draft then goes ahead from the facts alone, and the next draft tries the map again.
 */
export async function buildRequirementMap(
  deps: Deps,
  {
    opportunityId,
    prompt,
    facts,
    key,
    taskId,
    confirmOverCap,
  }: {
    opportunityId: OpportunityId;
    prompt: Prompt;
    facts: readonly Pick<PromptFact, "key" | "roleKey">[];
    key: string;
    taskId: TaskId;
    confirmOverCap: boolean;
  },
): Promise<RequirementMap | null> {
  const ai = (p: Prompt) =>
    runAi(deps, {
      tier: "writing",
      purpose: "requirements",
      taskId,
      prompt: p,
      maxOutputTokens: REQUIREMENTS_MAX_TOKENS,
      confirmOverCap,
    });
  const first = await ai(prompt);
  let reply = parseRequirementsReply(first.text);
  if (reply === null) {
    const retry = await ai(buildRequirementsRetryPrompt({ prompt, reply: first.text }));
    reply = parseRequirementsReply(retry.text);
  }
  if (reply === null) return null;
  const map = toRequirementMap({ reply, facts });
  await deps.db
    .update(opportunities)
    .set({ requirementMap: map, requirementMapKey: key })
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.userId, deps.userId)));
  return map;
}
