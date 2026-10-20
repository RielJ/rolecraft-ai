import { describe, expect, test } from "bun:test";
import type { FactKey, RequirementMap } from "@/shared/api";
import { buildDraftPrompt, type PromptFact, promptText } from "./prompts";
import {
  buildRequirementsPrompt,
  MAX_REQUIREMENTS,
  type RequirementsReply,
  requiredResumeFacts,
  requirementGaps,
  requirementMapSource,
  restrictRequirementMap,
  selectResumeFacts,
  toRequirementMap,
} from "./requirements";
import type { DraftRole } from "./work-roles";

const key = (n: number) => `FACT-${n}` as FactKey;
type Fact = PromptFact & { roleKey: string | null };
const fact = (n: number, text: string, roleKey: string | null = null): Fact => ({
  key: key(n),
  text,
  roleKey,
  link: null,
  usage: "everywhere",
});

const FACTS = [
  fact(1, "Skills: TypeScript, Go, Postgres"),
  fact(2, "Built a payments API in Go", "ROLE-1"),
  fact(3, "Cut Docker builds from 28 to 2.5 minutes", "ROLE-1"),
  fact(4, "Built frontend and backend systems for a Web3 streaming platform", "ROLE-2"),
  fact(5, "Led 3 engineers through dependency upgrades", "ROLE-2"),
  fact(6, "B.S. Computer Engineering (2022)"),
];

const reply = (over: Partial<RequirementsReply> = {}): RequirementsReply => ({
  role: "Backend engineer",
  requirements: [
    { text: "Go in production", weight: "must", facts: ["FACT-2", "FACT-1"] },
    { text: "MongoDB", weight: "must", facts: [] },
  ],
  context: [{ role: "ROLE-2", fact: "FACT-4" }],
  ...over,
});

describe("toRequirementMap", () => {
  test("numbers requirements and keeps the known facts", () => {
    const map = toRequirementMap({ reply: reply(), facts: FACTS });
    expect(map).toEqual({
      role: "Backend engineer",
      requirements: [
        { id: "R1", text: "Go in production", weight: "must", facts: [key(2), key(1)] },
        { id: "R2", text: "MongoDB", weight: "must", facts: [] },
      ],
      context: [key(4)],
    });
  });

  test("unknown fact keys are dropped, so a requirement backed only by them is a gap", () => {
    const map = toRequirementMap({
      reply: reply({ requirements: [{ text: "Kubernetes", weight: "must", facts: ["FACT-99", "nonsense"] }] }),
      facts: FACTS,
    });
    expect(map.requirements[0]?.facts).toEqual([]);
    expect(requirementGaps(map).map((r) => r.text)).toEqual(["Kubernetes"]);
  });

  test("a context fact counts only under its own role; blanks, repeats and extras are dropped", () => {
    const map = toRequirementMap({
      reply: reply({
        requirements: [
          { text: "  ", weight: "nice", facts: [] },
          ...Array.from({ length: MAX_REQUIREMENTS + 3 }, (_, i) => ({
            text: `Req ${i}`,
            weight: "duty" as const,
            facts: ["FACT-3", "FACT-3"],
          })),
        ],
        context: [
          { role: "ROLE-1", fact: "FACT-4" },
          { role: "ROLE-2", fact: "FACT-5" },
        ],
      }),
      facts: FACTS,
    });
    expect(map.requirements).toHaveLength(MAX_REQUIREMENTS);
    expect(map.requirements[0]).toEqual({ id: "R1", text: "Req 0", weight: "duty", facts: [key(3)] });
    expect(map.context).toEqual([key(5)]);
  });
});

describe("requirementMapSource", () => {
  const posting = { title: "Backend Engineer", company: "Owner", description: "Go and Postgres." };
  const source = requirementMapSource({ posting, facts: FACTS });

  test("is stable for the same posting and facts", () => {
    expect(requirementMapSource({ posting: { ...posting }, facts: [...FACTS] })).toBe(source);
  });

  test("changes when the posting, a fact's text, a fact's role or the fact set changes", () => {
    expect(requirementMapSource({ posting: { ...posting, description: "Go." }, facts: FACTS })).not.toBe(source);
    const edited = FACTS.map((f) => (f.key === key(2) ? { ...f, text: "Built a billing API in Go" } : f));
    expect(requirementMapSource({ posting, facts: edited })).not.toBe(source);
    const moved = FACTS.map((f) => (f.key === key(2) ? { ...f, roleKey: "ROLE-2" } : f));
    expect(requirementMapSource({ posting, facts: moved })).not.toBe(source);
    expect(requirementMapSource({ posting, facts: FACTS.slice(1) })).not.toBe(source);
  });
});

describe("restrictRequirementMap", () => {
  test("drops fact keys the kind may not cite, from requirements and context", () => {
    const map = toRequirementMap({ reply: reply(), facts: FACTS });
    const restricted = restrictRequirementMap({ map, allowedKeys: new Set([key(1), key(3)]) });
    expect(restricted.requirements.map((r) => r.facts)).toEqual([[key(1)], []]);
    expect(restricted.context).toEqual([]);
    expect(restricted.role).toBe(map.role);
  });
});

describe("selectResumeFacts (decision 74)", () => {
  const map = (requirements: RequirementMap["requirements"], context: FactKey[] = []): RequirementMap => ({
    role: "",
    requirements,
    context,
  });

  test("a role that proves anything keeps all its facts; a role that proves nothing keeps its context fact", () => {
    // ROLE-1's Docker fact (3) proves nothing the map listed, but it stays: the map can miss evidence.
    const picked = selectResumeFacts({
      map: map([{ id: "R1", text: "Go", weight: "must", facts: [key(2)] }], [key(5)]),
      facts: FACTS,
    });
    expect(picked.map((f) => f.key)).toEqual([key(1), key(2), key(3), key(5), key(6)]);
  });

  test("a role with no context fact keeps its first fact", () => {
    const picked = selectResumeFacts({
      map: map([{ id: "R1", text: "Go", weight: "must", facts: [key(3)] }]),
      facts: FACTS,
    });
    expect(picked.map((f) => f.key)).toEqual([key(1), key(2), key(3), key(4), key(6)]);
  });
});

describe("requiredResumeFacts (decision 74)", () => {
  test("requires proving facts and measured facts in matching roles, nothing from other roles or without a role", () => {
    const required = requiredResumeFacts({
      map: { role: "", requirements: [{ id: "R1", text: "Go", weight: "must", facts: [key(1), key(2)] }], context: [] },
      facts: FACTS,
    });
    // 2 proves R1; 3 has numbers; 5 has a number but ROLE-2 proves nothing; 1 and 6 have no role.
    expect(required).toEqual([key(2), key(3)]);
  });

  test("an empty map requires nothing", () => {
    expect(requiredResumeFacts({ map: { role: "", requirements: [], context: [] }, facts: FACTS })).toEqual([]);
  });
});

describe("prompts with a map", () => {
  const posting = { title: "Backend Engineer", company: "Owner", description: "We need Go." };
  const roles: DraftRole[] = [
    { key: "ROLE-1", title: "Engineer", company: "Cashflowy", location: null, start: null, end: null },
    { key: "ROLE-2", title: "Engineer", company: "Soulbound", location: null, start: null, end: null },
  ];

  test("the map prompt lists the posting, the roles and the facts with their role keys", () => {
    const text = promptText(buildRequirementsPrompt({ posting, facts: FACTS, roles }));
    expect(text).toContain("We need Go.");
    expect(text).toContain("ROLE-1: Engineer, Cashflowy");
    expect(text).toContain("FACT-2: Built a payments API in Go (ROLE-1)");
    expect(text).toContain('{"role": "...", "requirements"');
  });

  test("the draft prompt shows the requirements, gaps named, and marks each fact with what it proves", () => {
    const m = toRequirementMap({ reply: reply(), facts: FACTS });
    const text = promptText(
      buildDraftPrompt({
        kind: "resume",
        opportunityType: "job",
        posting,
        candidateName: "Ana",
        facts: FACTS,
        roles,
        map: m,
        required: [key(2), key(3)],
      }),
    );
    expect(text).toContain("REQUIRED: cite every one of these facts: FACT-2, FACT-3.");
    expect(text).toContain('Open the Summary with the role noun for "Backend engineer"');
    expect(text).toContain("REQUIREMENTS\nRole: Backend engineer\nR1 (must): Go in production <- FACT-2, FACT-1");
    expect(text).toContain("R2 (must): MongoDB <- no fact (a gap: never mention it)");
    expect(text).toContain("FACT-2: Built a payments API in Go (ROLE-1) [R1]");
    expect(text).toContain("FACT-3: Cut Docker builds from 28 to 2.5 minutes (ROLE-1)\n");
    expect(text).toContain("Build the resume from the REQUIREMENTS");
  });

  test("a letter keeps the plain map task, with no REQUIRED list", () => {
    const m = toRequirementMap({ reply: reply(), facts: FACTS });
    const text = promptText(
      buildDraftPrompt({ kind: "letter", opportunityType: "job", posting, candidateName: "Ana", facts: FACTS, map: m }),
    );
    expect(text).toContain("Build the text from the REQUIREMENTS");
    expect(text).not.toContain("REQUIRED:");
  });

  test("without a map the draft prompt has no requirements block", () => {
    const text = promptText(
      buildDraftPrompt({ kind: "letter", opportunityType: "job", posting, candidateName: "Ana", facts: FACTS }),
    );
    expect(text).not.toContain("REQUIREMENTS");
    expect(text).not.toContain("[R1]");
  });
});
