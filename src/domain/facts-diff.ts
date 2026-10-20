import type { FactStatus } from "@/shared/enums";
import { coverage } from "./base-cv";
import { normalize } from "./text";

export type ExistingFact<Id> = { id: Id; text: string; status: FactStatus };

/**
 * What a re-split does to an item's facts (section 3.3, step 3). Texts are compared after
 * `normalize`, so case, whitespace and punctuation changes count as the same fact.
 * - `unchanged`: existing facts a candidate matches. They keep id, key, status and citations.
 * - `added`: candidates no existing fact matches. They go in as pending.
 * - `removed`: pending facts no candidate matches. Nothing can cite a pending fact.
 * - `vanished`: confirmed facts no candidate matches. They stay; the user picks Keep or Delete.
 */
export type FactsDiff<Id> = {
  unchanged: Id[];
  added: string[];
  removed: Id[];
  vanished: Id[];
};

export function diffFacts<Id>({
  existing,
  candidates,
}: {
  existing: readonly ExistingFact<Id>[];
  candidates: readonly string[];
}): FactsDiff<Id> {
  const wanted = new Map<string, string>();
  for (const raw of candidates) {
    const text = raw.trim();
    const key = normalize(text);
    if (key !== "" && !wanted.has(key)) wanted.set(key, text);
  }
  const have = new Set(existing.map((f) => normalize(f.text)));

  const diff: FactsDiff<Id> = { unchanged: [], added: [], removed: [], vanished: [] };
  for (const fact of existing) {
    if (wanted.has(normalize(fact.text))) diff.unchanged.push(fact.id);
    else if (fact.status === "pending") diff.removed.push(fact.id);
    else diff.vanished.push(fact.id);
  }
  for (const [key, text] of wanted) if (!have.has(key)) diff.added.push(text);
  return diff;
}

/** A new fact repeats another when this share of its content words is in it (as tailoring's adds). */
export const REPEAT_COVERAGE = 0.8;

/**
 * Drop the candidates that say nothing new: those that one of `others` (the item's facts from its
 * own text) or an earlier kept candidate already covers at `REPEAT_COVERAGE`. A number the other
 * text lacks makes it not a repeat. Order is kept. Pure.
 */
export function dropRepeats({ candidates, others }: { candidates: readonly string[]; others: readonly string[] }): {
  kept: string[];
  repeats: string[];
} {
  const kept: string[] = [];
  const repeats: string[] = [];
  for (const text of candidates) {
    const said = [...others, ...kept].some((line) => coverage({ fact: text, line }) >= REPEAT_COVERAGE);
    (said ? repeats : kept).push(text);
  }
  return { kept, repeats };
}
