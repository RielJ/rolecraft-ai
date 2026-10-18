import { describe, expect, test } from "bun:test";
import { SKILLS } from "./features";
import { customSkillNames, isBuiltinSkill, MAX_SKILL_NAME, normalizeSkillName, profileSkills } from "./user-skills";

describe("normalizeSkillName", () => {
  test("trims and collapses spaces, keeping the user's spelling", () => {
    expect(normalizeSkillName("  Temporal \t  workflows ")).toEqual({
      kind: "ok",
      name: "Temporal workflows",
      key: "temporal workflows",
      builtin: false,
    });
  });
  test("a built-in name or spelling becomes the built-in name", () => {
    expect(normalizeSkillName("golang")).toEqual({ kind: "ok", name: "Go", key: "go", builtin: true });
    expect(normalizeSkillName("POSTGRES")).toEqual({
      kind: "ok",
      name: "PostgreSQL",
      key: "postgresql",
      builtin: true,
    });
    expect(normalizeSkillName("react  native")).toMatchObject({ name: "React Native", builtin: true });
  });
  test.each([
    ["", "Type a skill name."],
    ["   ", "Type a skill name."],
    ["--", "A skill name needs at least one letter or digit."],
    ["a\u0000b", "A skill name cannot contain control characters."],
    ["x".repeat(MAX_SKILL_NAME + 1), `A skill name can be at most ${MAX_SKILL_NAME} characters.`],
  ])("rejects %p", (raw, message) => {
    expect(normalizeSkillName(raw)).toEqual({ kind: "rejected", message });
  });
  test("no two built-in skills share a spelling", () => {
    const owner = new Map<string, string>();
    for (const skill of SKILLS) {
      for (const spelling of [skill.name, ...skill.spellings]) {
        const key = spelling.toLowerCase();
        expect([undefined, skill.name]).toContain(owner.get(key));
        owner.set(key, skill.name);
      }
    }
  });
  test("isBuiltinSkill takes names, not spellings", () => {
    expect(isBuiltinSkill("Go")).toBe(true);
    expect(isBuiltinSkill("golang")).toBe(false);
    expect(isBuiltinSkill("Hasura")).toBe(false);
  });
});

describe("profileSkills", () => {
  test("matching is facts plus added minus hidden; built-ins in dictionary order, then the user's own", () => {
    const { matching, chips } = profileSkills({
      factSkills: ["TypeScript", "Go", "Docker"],
      rows: [
        { name: "Hasura", kind: "added" },
        { name: "Python", kind: "added" },
        { name: "Go", kind: "hidden" },
        { name: "Temporal", kind: "added" },
      ],
    });
    expect(matching).toEqual(["TypeScript", "Python", "Docker", "Hasura", "Temporal"]);
    expect(chips).toEqual([
      { name: "TypeScript", source: "facts", builtin: true },
      { name: "Python", source: "added", builtin: true },
      { name: "Docker", source: "facts", builtin: true },
      { name: "Hasura", source: "added", builtin: false },
      { name: "Temporal", source: "added", builtin: false },
      { name: "Go", source: "hidden", builtin: true },
    ]);
  });
  test("a skill both found in facts and added shows once, as found in facts", () => {
    const { matching, chips } = profileSkills({ factSkills: ["Go"], rows: [{ name: "Go", kind: "added" }] });
    expect(matching).toEqual(["Go"]);
    expect(chips).toEqual([{ name: "Go", source: "facts", builtin: true }]);
  });
  test("a hidden skill no fact names any more still has a chip to restore", () => {
    const { matching, chips } = profileSkills({ factSkills: [], rows: [{ name: "Rust", kind: "hidden" }] });
    expect(matching).toEqual([]);
    expect(chips).toEqual([{ name: "Rust", source: "hidden", builtin: true }]);
  });
  test("customSkillNames keeps added names that are not built in, in the order added", () => {
    expect(
      customSkillNames([
        { name: "Temporal", kind: "added" },
        { name: "Go", kind: "added" },
        { name: "Rust", kind: "hidden" },
        { name: "Hasura", kind: "added" },
      ]),
    ).toEqual(["Temporal", "Hasura"]);
  });
});
