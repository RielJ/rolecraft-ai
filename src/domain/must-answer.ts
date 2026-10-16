import type { MustAnswer } from "@/shared/enums";

/** Ordered: the first matching rule decides. Questions here are never drafted (decision 24). */
const RULES: readonly { category: MustAnswer; pattern: RegExp }[] = [
  {
    category: "salary",
    pattern: /\b(salary|compensation|pay expectations?|expected (rate|pay|salary)|desired (rate|pay))\b/i,
  },
  {
    category: "work_auth",
    pattern: /\b(visa|sponsorship|authori[sz]ed to work|right to work|work permit|work authori[sz]ation)\b/i,
  },
  { category: "notice", pattern: /\bnotice period\b/i },
  { category: "start_date", pattern: /\b(start date|when can you start|earliest start|available to start)\b/i },
  { category: "references", pattern: /\b(references?|referees?)\b/i },
];

export function classifyQuestion(question: string): MustAnswer | null {
  return RULES.find((rule) => rule.pattern.test(question))?.category ?? null;
}
