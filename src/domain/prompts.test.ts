import { describe, expect, test } from "bun:test";
import { FactKey } from "@/shared/api";
import {
  allowedFacts,
  buildDraftPrompt,
  buildRetryPrompt,
  buildSplitPrompt,
  buildStyleRewritePrompt,
  cleanModelText,
  type PromptFact,
  promptText,
} from "./prompts";
import { BANNED_PHRASES } from "./style";

const k = (n: number) => FactKey.parse(`FACT-${n}`);
const facts: PromptFact[] = [
  { key: k(1), text: "Built a payments API in Go", link: "https://github.com/juan/pay", usage: "everywhere" },
  { key: k(2), text: "Mentored three students at a local bootcamp", link: null, usage: "letters_only" },
];
const posting = { title: "Backend Engineer", company: "Acme", description: "Build payment APIs." };

function draft(kind: "resume" | "letter" | "message", opportunityType: "job" | "contract" = "job") {
  return buildDraftPrompt({
    kind,
    opportunityType,
    posting,
    candidateName: "Juan Dela Cruz",
    facts: allowedFacts({ kind, facts }),
  });
}

describe("buildDraftPrompt", () => {
  test("lists facts as FACT-n: text (link)", () => {
    expect(promptText(draft("letter"))).toContain("FACT-1: Built a payments API in Go (https://github.com/juan/pay)");
    expect(promptText(draft("letter"))).toContain("FACT-2: Mentored three students at a local bootcamp");
  });

  test("the resume prompt never contains a letters_only fact", () => {
    const text = promptText(draft("resume"));
    expect(text).toContain("FACT-1");
    expect(text).not.toContain("FACT-2");
    expect(text).not.toContain("Mentored three students");
  });

  test("carries the job title, company and description", () => {
    const text = promptText(draft("resume"));
    for (const part of [posting.title, posting.company, posting.description]) expect(text).toContain(part);
  });

  test("contains every phrase from the banned list", () => {
    for (const kind of ["resume", "letter", "message"] as const) {
      const text = promptText(draft(kind));
      for (const phrase of BANNED_PHRASES) expect(text).toContain(phrase);
    }
  });

  test("names the marker, placeholder and no-must-answer rules", () => {
    const text = promptText(draft("letter"));
    expect(text).toContain("[FACT-n]");
    expect(text).toContain("[[what is missing]]");
    expect(text).toMatch(/Never mention salary/);
    expect(text).toMatch(/em dashes/);
  });

  test("the message becomes a proposal for a contract", () => {
    expect(promptText(draft("message", "contract"))).toContain("proposal");
    expect(promptText(draft("message", "job"))).not.toContain("proposal");
  });

  test("an answer prompt carries the question", () => {
    const prompt = buildDraftPrompt({
      kind: "answer",
      opportunityType: "job",
      posting,
      candidateName: "Juan",
      facts,
      question: "Why do you want to work here?",
    });
    expect(promptText(prompt)).toContain("Why do you want to work here?");
  });
});

describe("buildRetryPrompt", () => {
  test("adds the failed draft and each violation", () => {
    const first = draft("resume");
    const retry = buildRetryPrompt({
      prompt: first,
      draft: "I have 8 years of Go [FACT-1].",
      violations: [
        { kind: "unsupported_token", tokens: ["8"], sentence: "I have 8 years of Go [FACT-1].", start: 0, end: 30 },
      ],
    });
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1]).toEqual({ role: "assistant", content: "I have 8 years of Go [FACT-1]." });
    expect(retry.messages[2]?.content).toContain('"8"');
  });
});

describe("buildStyleRewritePrompt", () => {
  test("numbers each flagged sentence and names the problem", () => {
    const prompt = buildStyleRewritePrompt({
      sentences: [{ sentence: "I leverage Go [FACT-1].", hits: [{ rule: "banned_phrase", phrase: "leverage" }] }],
      facts,
    });
    const text = promptText(prompt);
    expect(text).toContain("1. I leverage Go [FACT-1].");
    expect(text).toContain('"leverage"');
    expect(text).toContain("exactly 1 strings");
  });
});

describe("cleanModelText", () => {
  test("unwraps a code fence and trims", () => {
    expect(cleanModelText("```markdown\n# Juan\n- Built it [FACT-1]\n```\n")).toBe("# Juan\n- Built it [FACT-1]");
    expect(cleanModelText("  plain  ")).toBe("plain");
  });
});

describe("buildSplitPrompt", () => {
  const item = { kindLabel: "CV", title: "CV", body: "Databases & Tools: PostgreSQL, Redis", skills: [], saved: [] };

  test("asks for skills lines as facts, since matching reads skills only from facts", () => {
    const { system } = buildSplitPrompt({ item });
    expect(system).toContain("Keep every line that lists skills, tools or technologies as one fact");
  });

  test("sends saved facts only when there are some", () => {
    expect(promptText(buildSplitPrompt({ item }))).not.toContain("SAVED FACTS");
    const again = promptText(buildSplitPrompt({ item: { ...item, saved: ["Built a billing service"] } }));
    expect(again).toContain("SAVED FACTS (from an earlier version of this text)\n- Built a billing service");
  });
});
