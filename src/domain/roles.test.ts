import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { RoleFamily } from "@/shared/enums";
import { excludeWordIn, headFamily, matchesKeywords, ROLE_RULES, roleDropReason, roleFit } from "./roles";

const fit = (
  title: string,
  families: RoleFamily[],
  {
    tags = [],
    description = "",
    excludeWords = [],
  }: { tags?: string[]; description?: string; excludeWords?: string[] } = {},
) => roleFit({ title, tags, description, families, excludeWords });

describe("role drop reasons (decision 53)", () => {
  test("the exclude word, as typed, else the family that is not picked", () => {
    const excludeWords = [" Intern ", "sales"];
    const intern = fit("Software Engineering Intern", ["engineering"], { excludeWords });
    expect(roleDropReason({ title: "Software Engineering Intern", fit: intern, excludeWords })).toBe("Title: Intern");
    const designer = fit("Product Designer", ["engineering"], { excludeWords });
    expect(roleDropReason({ title: "Product Designer", fit: designer, excludeWords })).toBe("Role: Design");
    expect(excludeWordIn({ title: "International Sales Engineer", excludeWords })).toBe("sales");
    expect(excludeWordIn({ title: "Backend Engineer", excludeWords })).toBeNull();
  });
});

describe("roleFit: one fixture per rule (section 3.7a)", () => {
  test("drop: the title contains an exclude word, whatever the family", () => {
    expect(fit("Software Engineering Intern", ["engineering"], { excludeWords: ["intern"] })).toEqual({
      fit: "drop",
      family: "engineering",
      reason: 'title contains "intern"',
    });
    // Whole words only: "intern" does not drop "International".
    expect(fit("International Sales Engineer", ["sales"], { excludeWords: ["intern"] }).fit).toBe("keep");
  });

  test("drop: exactly one family matched, unpicked, and nothing picked in the title or tags", () => {
    expect(fit("Product Designer", ["engineering"], { tags: ["Design"] })).toEqual({
      fit: "drop",
      family: "design",
      reason: "design is not one of your role families",
    });
  });

  test("unsure: no family matched", () => {
    expect(fit("Technical Wizard", ["engineering"])).toEqual({
      fit: "unsure",
      family: "unknown",
      reason: "no role family in the title",
    });
  });

  test("unsure: the title mixes a picked family with an unpicked one", () => {
    expect(fit("UX Engineer", ["engineering"])).toEqual({
      fit: "unsure",
      family: "engineering",
      reason: "title mixes engineering and design",
    });
    expect(fit("Designer/Developer", ["design"]).fit).toBe("unsure");
    expect(fit("Developer Relations Manager", ["engineering"]).fit).toBe("unsure");
  });

  test("unsure: the title's family is unpicked but a tag names a picked one", () => {
    expect(fit("Product Designer", ["engineering"], { tags: ["Engineering"] })).toEqual({
      fit: "unsure",
      family: "design",
      reason: "title is design but a tag names engineering",
    });
  });

  test("unsure: the title's family is unpicked but the first 300 characters of the description name a picked one", () => {
    const description = "You will pair with our frontend engineers on the React app every day.";
    expect(fit("Product Designer", ["engineering"], { description })).toEqual({
      fit: "unsure",
      family: "design",
      reason: "title is design but the description names engineering",
    });
    // Past 300 characters the description does not count.
    expect(fit("Product Designer", ["engineering"], { description: `${"x ".repeat(160)}${description}` }).fit).toBe(
      "drop",
    );
  });

  test("keep: the head noun's family is picked", () => {
    expect(fit("Senior Frontend Engineer", ["engineering"])).toEqual({
      fit: "keep",
      family: "engineering",
      reason: "engineering is one of your role families",
    });
  });

  test("no families picked: only exclude words drop", () => {
    expect(fit("Account Executive", []).fit).toBe("keep");
    expect(fit("Account Executive", [], { excludeWords: ["executive"] }).fit).toBe("drop");
  });

  test("the head noun, the last role word, decides the family", () => {
    expect(headFamily("Design Systems Engineer")).toBe("engineering");
    expect(headFamily("Frontend Designer")).toBe("design");
    expect(headFamily("Data Engineer")).toBe("data");
    expect(headFamily("Technical Wizard")).toBeNull();
  });

  test("every family has a rule with at least one head noun", () => {
    expect(ROLE_RULES.map((r) => r.family).sort()).toEqual([...RoleFamily.options].sort());
    for (const rule of ROLE_RULES) expect(rule.heads.length).toBeGreaterThan(0);
  });
});

describe("matchesKeywords: the built-in boards' local keyword filter (section 3.1 step 3)", () => {
  test("a keyword in the title or a tag keeps the posting; no keywords keeps everything", () => {
    expect(matchesKeywords({ title: "React Developer", tags: [], keywords: ["react"] })).toBe(true);
    expect(matchesKeywords({ title: "Engineer", tags: ["Programming"], keywords: ["programming"] })).toBe(true);
    expect(matchesKeywords({ title: "Account Executive", tags: ["Sales"], keywords: ["react", "frontend"] })).toBe(
      false,
    );
    expect(matchesKeywords({ title: "Account Executive", tags: [], keywords: [] })).toBe(true);
  });

  test("whole words only, and multi-word keywords match as a phrase", () => {
    expect(matchesKeywords({ title: "Reactor Operator", tags: [], keywords: ["react"] })).toBe(false);
    expect(matchesKeywords({ title: "Senior Front-End Engineer", tags: [], keywords: ["front end"] })).toBe(true);
  });
});

const EvalFile = z.object({
  cases: z.array(
    z.object({
      title: z.string(),
      families: z.array(RoleFamily),
      excludeWords: z.array(z.string()).optional(),
      fit: z.enum(["keep", "unsure", "drop"]),
      family: z.union([RoleFamily, z.literal("unknown")]),
    }),
  ),
});

describe("roleFit: real titles (eval/roles/titles.json)", async () => {
  const file = EvalFile.parse(await Bun.file(join(import.meta.dir, "../../eval/roles/titles.json")).json());

  test("covers keep, unsure and drop", () => {
    expect(new Set(file.cases.map((c) => c.fit))).toEqual(new Set(["keep", "unsure", "drop"]));
  });

  test.each(file.cases.map((c) => [`${c.title} [${c.families.join(",")}]`, c] as const))("%s", (_name, c) => {
    const got = fit(c.title, c.families, { excludeWords: c.excludeWords ?? [] });
    expect({ fit: got.fit, family: got.family }).toEqual({ fit: c.fit, family: c.family });
  });
});
