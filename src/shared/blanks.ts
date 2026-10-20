/**
 * A `[[...]]` blank as the "Needs your input" form shows it. `check` is a sentence the facts did
 * not back (the drafter's `[[Check this: "..." is not backed by your facts]]`); anything else is
 * missing information, labelled by its own text.
 */
export type Blank =
  | { kind: "missing"; blank: string; label: string }
  | { kind: "check"; blank: string; sentence: string };

const CHECK_THIS = /^Check this: "([\s\S]*)" is not backed by your facts$/;

/** Read one blank's inner text (what the gate reports as a placeholder blocker's `text`). */
export function parseBlank(blank: string): Blank {
  const check = CHECK_THIS.exec(blank);
  if (check) return { kind: "check", blank, sentence: check[1] ?? "" };
  return { kind: "missing", blank, label: blank.trim() };
}
