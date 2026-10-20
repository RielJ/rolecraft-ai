import { describe, expect, test } from "bun:test";
import { FactKey, type RequirementMap } from "@/shared/api";
import { mapFactsToLines, parseBaseCv } from "./base-cv";
import { CV, ROLES } from "./base-cv.fixture";
import { buildTailorPrompt, buildTailorRetryPrompt, type PromptFact, promptText } from "./prompts";
import { MAX_REWORDS } from "./tailor";

const k = (n: number) => FactKey.parse(`FACT-${n}`);
const fact = (n: number, text: string, roleKey: string | null): PromptFact => ({
  key: k(n),
  text,
  link: null,
  usage: "everywhere",
  roleKey,
});
const FACTS = [
  fact(1, "Cut p95 checkout latency by 40% with Postgres query plans.", "ROLE-1"),
  fact(2, "Used Redis caching for checkout.", "ROLE-1"),
  fact(4, "Ran the ledger service on Docker with GitHub Actions deploys.", "ROLE-1"),
];
const { lines: base } = mapFactsToLines({ lines: parseBaseCv({ text: CV, roles: ROLES }), facts: FACTS });
const map: RequirementMap = {
  role: "Backend Engineer",
  requirements: [
    { id: "R1", text: "Performance tuning", weight: "must", facts: [k(1)] },
    { id: "R2", text: "Kubernetes", weight: "nice", facts: [] },
  ],
  context: [],
};
const posting = { title: "Backend Engineer", company: "Acme", description: "Tune Postgres." };
const prompt = buildTailorPrompt({ posting, base, facts: FACTS, map, protectedKeys: new Set([k(1)]) });
const user = prompt.messages[0].content;
const lineOf = (start: string) => base.find((l) => l.text.startsWith(start));

describe("buildTailorPrompt (decision 75)", () => {
  test("lists the CV as numbered lines, without the contact block", () => {
    const bullet = lineOf("Cut p95");
    expect(user).toContain(`${bullet?.id} bullet (ROLE-1) (keep) [R1]: ${bullet?.text}`);
    expect(user).not.toContain("alex@example.com");
    expect(user).toMatch(/L\d+ role \(ROLE-1\): ### Senior Backend Engineer/);
  });

  test("a project's only description is marked (keep) (decision 77)", () => {
    const only = lineOf("A CLI that diffs");
    expect(user).toContain(`${only?.id} bullet (keep): ${only?.text}`);
    expect(user).toMatch(new RegExp(`${lineOf("pg-tools")?.id} text: pg-tools`));
  });

  test("says where each fact is, and which are free to add", () => {
    expect(user).toContain(`FACT-1 (ROLE-1) (on ${lineOf("Cut p95")?.id}) [R1]:`);
    expect(user).toContain("FACT-4 (ROLE-1) (not in the CV):");
  });

  test("carries the requirements, gaps, limits and reply shape", () => {
    expect(user).toContain("R2 (nice): Kubernetes <- no fact");
    expect(user).toContain(`At most ${MAX_REWORDS}`);
    expect(user).toContain('{"ops": [...]}');
    expect(user).toContain('the role noun for "Backend Engineer"');
  });

  test("the system prompt has the editing rules and no draft marker rules", () => {
    expect(prompt.system).toContain("## Editing a base resume");
    expect(prompt.system).toContain("No pronouns");
    expect(prompt.system).not.toContain("[FACT-3]");
  });

  test("projects the CV lacks are listed, their facts marked, and the project op offered (decision 82)", () => {
    const text = promptText(
      buildTailorPrompt({
        posting,
        base,
        facts: [
          { key: k(9), text: "Nyx schedules Go jobs.", link: null, usage: "everywhere", projectKey: "PROJECT-1" },
        ],
        map: null,
        protectedKeys: new Set(),
        projects: [{ key: "PROJECT-1", name: "Nyx", link: null, stack: [], role: "own" }],
      }),
    );
    expect(text).toContain("PROJECTS\nPROJECT-1: Nyx (your own project)\n");
    expect(text).toContain("FACT-9 (PROJECT-1) (not in the CV): Nyx schedules Go jobs.");
    expect(text).toContain("project: add one project from the PROJECTS list");
    expect(text).toContain('{"op": "project", "project": "PROJECT-n"');
  });

  test("without projects there is no PROJECTS list and no project op", () => {
    const text = promptText(buildTailorPrompt({ posting, base, facts: [], map: null, protectedKeys: new Set() }));
    expect(text).not.toContain("PROJECTS\nPROJECT-");
    expect(text).not.toContain("project: add one project");
    expect(text).not.toContain('"op": "project"');
  });

  test("without a map the prompt still builds", () => {
    const text = promptText(buildTailorPrompt({ posting, base, facts: [], map: null, protectedKeys: new Set() }));
    expect(text).not.toContain("REQUIREMENTS\nRole:");
    expect(text).toContain("FACTS\n(none)");
  });
});

describe("buildTailorRetryPrompt", () => {
  test("names each dropped edit and why", () => {
    const line = lineOf("Cut p95")?.id ?? "";
    const retry = buildTailorRetryPrompt({
      prompt,
      reply: '{"ops": []}',
      dropped: [
        {
          op: { op: "reword", line, text: "x", facts: [], reasons: [], note: null },
          reason: "unsupported",
          detail: "Kubernetes",
        },
        { op: { op: "remove", line, reasons: [], note: null }, reason: "protected", detail: "FACT-1" },
      ],
    });
    expect(retry.messages).toHaveLength(3);
    const fix = retry.messages[2]?.content ?? "";
    expect(fix).toContain(`reword ${line}: says Kubernetes`);
    expect(fix).toContain(`remove ${line}: the line is marked (keep).`);
    expect(fix).toContain("Reply with JSON only");
  });

  test("counts edits in no known shape", () => {
    const retry = buildTailorRetryPrompt({ prompt, reply: "{}", dropped: [], unreadable: 2 });
    expect(retry.messages[2]?.content).toContain("2 edits were in none of the shapes asked for.");
  });

  test("an unreadable reply asks for the JSON again", () => {
    const retry = buildTailorRetryPrompt({ prompt, reply: "Sure! Here are edits", dropped: [] });
    expect(retry.messages[2]?.content).toContain("not the JSON asked for");
  });
});
