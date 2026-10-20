import { describe, expect, test } from "bun:test";
import { FactKey } from "@/shared/api";
import {
  allowedFacts,
  buildDraftPrompt,
  buildRetryPrompt,
  buildRolesPrompt,
  buildRolesRetryPrompt,
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

describe("buildDraftPrompt voice and guide (decision 72)", () => {
  test("a resume carries the guide's Resume and shared sections, and no first-person rule", () => {
    const { system } = draft("resume");
    for (const heading of ["Facts and limits", "Tailoring to the posting", "Sounds like a person", "Resume"]) {
      expect(system).toContain(`## ${heading}`);
    }
    expect(system).not.toContain("## Cover letter");
    expect(system).not.toContain("first person");
    expect(system).toContain("Built the payments API in Go [FACT-3].");
    expect(system).not.toContain("I built the payments API");
  });

  test("the resume task never asks for the candidate's name as a heading", () => {
    const text = promptText(draft("resume"));
    expect(text).not.toMatch(/Start with # and the candidate's name/);
    expect(text).toContain("Do not write the candidate's name");
  });

  test("a letter keeps first person and gets the Cover letter section", () => {
    const { system } = draft("letter");
    expect(system).toContain("plain first person");
    expect(system).toContain("## Cover letter");
    expect(system).not.toContain("## Resume");
  });

  test("the style rewrite speaks with the kind's voice", () => {
    const sentences = [{ sentence: "I built it [FACT-1].", hits: [{ rule: "pronoun" as const, phrase: "I" }] }];
    const resume = buildStyleRewritePrompt({ kind: "resume", opportunityType: "job", sentences, facts });
    expect(resume.system).toContain("without pronouns");
    expect(promptText(resume)).toContain('"I" in a resume');
  });
});

describe("buildDraftPrompt with roles (decision 71)", () => {
  const role = {
    key: "ROLE-1",
    title: "Full-stack Software Engineer",
    company: "CASHFLOWY",
    location: "REMOTE",
    start: "January 2026",
    end: "June 2026",
  };
  const withRole = (kind: "resume" | "letter") =>
    promptText(
      buildDraftPrompt({
        kind,
        opportunityType: "job",
        posting,
        candidateName: "Juan",
        facts: [
          {
            key: k(1),
            text: "Built a payments API in Go",
            link: "https://github.com/juan/pay",
            usage: "everywhere",
            roleKey: "ROLE-1",
          },
        ],
        roles: [role],
      }),
    );

  test("a resume lists the roles and marks each fact with its role", () => {
    const text = withRole("resume");
    expect(text).toContain(
      "ROLES\nROLE-1: Full-stack Software Engineer, CASHFLOWY, REMOTE, January 2026 – June 2026\n",
    );
    expect(text).toContain("FACT-1: Built a payments API in Go (https://github.com/juan/pay) (ROLE-1)");
    expect(text).toContain("write [ROLE-n] alone on its own line");
    // Roles may overlap in time, so "most recent first" is ambiguous: keep the list's order.
    expect(text).toContain("in the order of the ROLES list");
    expect(text).not.toContain("most recent role first");
    expect(text).toContain("Facts with no (ROLE-n) go in Summary, Skills, Projects or Education");
  });

  test("a letter gets no roles block and no role marks", () => {
    const text = withRole("letter");
    expect(text).not.toContain("ROLE-1");
    expect(text).not.toContain("[ROLE-n]");
  });
});

describe("buildDraftPrompt with projects (decision 82)", () => {
  const withProjects = (kind: "resume" | "letter") =>
    promptText(
      buildDraftPrompt({
        kind,
        opportunityType: "job",
        posting,
        candidateName: "Juan",
        facts: [
          { key: k(1), text: "Nyx sorts Tailwind classes", link: null, usage: "everywhere", projectKey: "PROJECT-1" },
          { key: k(2), text: "Added value support to Viem", link: null, usage: "everywhere", projectKey: "PROJECT-2" },
        ],
        projects: [
          { key: "PROJECT-1", name: "Nyx", link: "https://github.com/rielj/nyx", stack: ["Go"], role: "own" },
          { key: "PROJECT-2", name: "Viem", link: null, stack: [], role: "contribution" },
        ],
      }),
    );

  test("a resume lists the projects with whose they are, and marks each fact with its project", () => {
    const text = withProjects("resume");
    expect(text).toContain(
      "PROJECTS\nPROJECT-1: Nyx (your own project)\nPROJECT-2: Viem (a contribution to someone else's project)\n",
    );
    expect(text).toContain("FACT-2: Added value support to Viem (PROJECT-2)");
    expect(text).toContain("Write [PROJECT-n] alone on its own line");
    expect(text).toContain("Contributions go under ## Open Source Contributions");
    expect(text).toContain("never write that they built, created, founded or own it");
    // The drafter never sees the head's link to copy: the server writes it.
    expect(text).not.toContain("github.com/rielj/nyx");
  });

  test("a letter gets no projects block and no project marks", () => {
    const text = withProjects("letter");
    expect(text).not.toContain("PROJECT-1");
    expect(text).not.toContain("[PROJECT-n]");
  });
});

describe("buildRolesPrompt", () => {
  test("carries the text and asks for the roles JSON with fields copied exactly", () => {
    const prompt = buildRolesPrompt({
      item: { kindLabel: "CV", title: "CV", body: "Engineer Jan, 2026\nAcme (Remote)" },
    });
    const text = promptText(prompt);
    expect(text).toContain("<<<\nEngineer Jan, 2026\nAcme (Remote)\n>>>");
    expect(text).toContain('{"roles"');
    expect(text).toContain("exactly");
    expect(buildRolesRetryPrompt({ prompt, reply: "no" }).messages).toHaveLength(3);
  });
});

describe("describeViolation for projects", () => {
  test("the retry names the project and the rule", () => {
    const sentence = "- Added value support [FACT-2]";
    const text = (violations: Parameters<typeof buildRetryPrompt>[0]["violations"]) =>
      promptText(buildRetryPrompt({ prompt: draft("resume"), draft: sentence, violations }));
    expect(
      text([{ kind: "wrong_project", projectKey: "PROJECT-1", factKeys: ["FACT-2"], sentence, start: 0, end: 10 }]),
    ).toContain("is under [PROJECT-1] but cites FACT-2, which is not marked (PROJECT-1)");
    expect(
      text([{ kind: "wrong_project", projectKey: null, factKeys: ["FACT-2"], sentence, start: 0, end: 10 }]),
    ).toContain("before any [PROJECT-n] line");
    expect(text([{ kind: "unknown_project", projectKey: "PROJECT-9", sentence, start: 0, end: 10 }])).toContain(
      "Write only a PROJECT-n from the PROJECTS list",
    );
  });
});

describe("describeViolation for an unknown role", () => {
  test("the retry names the key and the rule", () => {
    const retry = buildRetryPrompt({
      prompt: draft("resume"),
      draft: "[ROLE-9]",
      violations: [{ kind: "unknown_role", roleKey: "ROLE-9", sentence: "[ROLE-9]", start: 0, end: 8 }],
    });
    expect(retry.messages[2]?.content).toContain("writes [ROLE-9]");
  });
});

describe("describeViolation for a wrong role", () => {
  test("the retry says where the line belongs", () => {
    const sentence = "- Built the Zapier integration [FACT-2]";
    const under = buildRetryPrompt({
      prompt: draft("resume"),
      draft: sentence,
      violations: [{ kind: "wrong_role", roleKey: "ROLE-1", factKeys: ["FACT-2"], sentence, start: 0, end: 10 }],
    });
    expect(under.messages[2]?.content).toContain("is under [ROLE-1] but cites FACT-2, which is not marked (ROLE-1)");
    const before = buildRetryPrompt({
      prompt: draft("resume"),
      draft: sentence,
      violations: [{ kind: "wrong_role", roleKey: null, factKeys: ["FACT-2"], sentence, start: 0, end: 10 }],
    });
    expect(before.messages[2]?.content).toContain("before any [ROLE-n] line");
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
      kind: "letter",
      opportunityType: "job",
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

  test("skips job header lines, which are read as roles", () => {
    expect(buildSplitPrompt({ item }).system).toContain("Skip job header lines");
  });

  test("sends saved facts only when there are some", () => {
    expect(promptText(buildSplitPrompt({ item }))).not.toContain("SAVED FACTS");
    const again = promptText(buildSplitPrompt({ item: { ...item, saved: ["Built a billing service"] } }));
    expect(again).toContain("SAVED FACTS (from an earlier version of this text)\n- Built a billing service");
  });
});
