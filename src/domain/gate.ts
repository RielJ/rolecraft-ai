import type { FactKey, GateBlocker, GateResult, OutputId, StandardAnswers } from "@/shared/api";
import type { MustAnswer, OutputKind } from "@/shared/enums";
import { findPlaceholders } from "./citations";

export type GateOutput = {
  id: OutputId;
  kind: OutputKind;
  included: boolean;
  question: string | null;
  mustAnswer: MustAnswer | null;
  body: string | null;
  citations: readonly { factKey: FactKey; deleted: boolean }[];
};

function isBlank(text: string | null | undefined): boolean {
  return text == null || text.trim() === "";
}

/**
 * The only definition of the "Needs your input" gate (decision 25).
 * Only included outputs count.
 */
export function checkGate({
  outputs,
  standardAnswers,
}: {
  outputs: readonly GateOutput[];
  standardAnswers: StandardAnswers;
}): GateResult {
  const blockers: GateBlocker[] = [];

  for (const output of outputs) {
    if (!output.included) continue;

    if (output.mustAnswer !== null) {
      const answer = output.body ?? standardAnswers[output.mustAnswer];
      if (isBlank(answer)) {
        blockers.push({
          kind: "must_answer",
          outputId: output.id,
          question: output.question ?? "",
          category: output.mustAnswer,
        });
        continue;
      }
    } else if (isBlank(output.body)) {
      blockers.push({ kind: "not_drafted", outputId: output.id, outputKind: output.kind });
      continue;
    }

    for (const text of findPlaceholders(output.body ?? "")) {
      blockers.push({ kind: "placeholder", outputId: output.id, text });
    }
    for (const citation of output.citations) {
      if (citation.deleted) blockers.push({ kind: "deleted_fact", outputId: output.id, factKey: citation.factKey });
    }
  }

  const [first, ...rest] = blockers;
  return first ? { ok: false, blockers: [first, ...rest] } : { ok: true };
}
