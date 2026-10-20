import { describe, expect, test } from "bun:test";
import { type OpportunityType, OUTPUT_KINDS, type OutputKind } from "@/shared/enums";
import { guideFor, guideHeadings, guideSectionsOf, stripSourceRefs, TAILOR_SECTION, tailorGuide } from "./guide";

const KINDS: { kind: OutputKind; opportunityType: OpportunityType }[] = OUTPUT_KINDS.flatMap((kind) =>
  (kind === "message" ? (["job", "contract"] as const) : (["job"] as const)).map((opportunityType) => ({
    kind,
    opportunityType,
  })),
);

describe("guideFor (decision 72)", () => {
  test("the real guide has every section each kind's prompt needs", () => {
    for (const input of KINDS) expect(() => guideFor(input)).not.toThrow();
  });

  test("a resume gets the shared sections and the Resume section, sub-headings included", () => {
    const text = guideFor({ kind: "resume", opportunityType: "job" });
    for (const heading of guideHeadings({ kind: "resume", opportunityType: "job" })) {
      expect(text).toContain(`## ${heading}`);
    }
    expect(text).toContain("### Bullets");
    expect(text).toContain("No pronouns");
    expect(text).not.toContain("## Cover letter");
  });

  test("only the tailor prompt gets the editing rules (decision 75)", () => {
    for (const input of KINDS) expect(guideFor(input)).not.toContain(`## ${TAILOR_SECTION}`);
    const text = tailorGuide();
    expect(text).toContain("## Resume");
    expect(text).toContain(`## ${TAILOR_SECTION}`);
    expect(text).toContain("Never upgrade ownership");
    expect(text).not.toContain("https://");
    expect(text).not.toMatch(/\]\[[a-z0-9]+\]/);
  });

  test("never sends the people-only sections or source references", () => {
    for (const input of KINDS) {
      const text = guideFor(input);
      for (const heading of ["How this guide is used", "Disagreements and our picks", "Sources"]) {
        expect(text).not.toContain(`## ${heading}`);
      }
      expect(text).not.toMatch(/\]\[[a-z0-9]+\]/);
      expect(text).not.toContain("https://");
    }
  });

  test("a contract message gets the proposal section, a job message the short message", () => {
    expect(guideFor({ kind: "message", opportunityType: "contract" })).toContain(
      "## Short message (contract proposal)",
    );
    expect(guideFor({ kind: "message", opportunityType: "job" })).toContain("## Short message (job)");
  });

  test("a renamed or empty section fails loudly instead of sending less", () => {
    const shared =
      "## Facts and limits\nA\n## Tailoring to the posting\nB\n## Shared rules\nC\n## Sounds like a person\nD\n";
    expect(() => guideFor({ kind: "resume", opportunityType: "job" }, `${shared}## Resumes\nE\n`)).toThrow(
      '"## Resume"',
    );
    expect(() => guideFor({ kind: "resume", opportunityType: "job" }, `${shared}## Resume\n\n`)).toThrow('"## Resume"');
    expect(guideFor({ kind: "resume", opportunityType: "job" }, `${shared}## Resume\nE\n`)).toContain("## Resume\n\nE");
  });
});

describe("guideSectionsOf", () => {
  test("splits on ## only, keeping ### inside the section", () => {
    const sections = guideSectionsOf("# Title\nintro\n## A\none\n### A.1\ntwo\n## B\nthree");
    expect([...sections.keys()]).toEqual(["A", "B"]);
    expect(sections.get("A")).toBe("one\n### A.1\ntwo");
  });
});

describe("stripSourceRefs", () => {
  test("removes one or several references and keeps other parentheses", () => {
    expect(stripSourceRefs("Lead with it. ([TIH][tih], [Interview Guys][ig])")).toBe("Lead with it.");
    expect(stripSourceRefs("Keep this (for example) ([TIH][tih]) too")).toBe("Keep this (for example) too");
  });
});
