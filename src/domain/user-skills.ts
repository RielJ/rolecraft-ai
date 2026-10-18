import type { SkillChipSource, UserSkillKind } from "@/shared/enums";
import { BUILTIN_SKILLS, BUILTIN_SKILLS_VERSION, SKILLS, type SkillDictionary } from "./features";
import { sha256Hex } from "./text";

/**
 * The user's own skill list (decision 66): skills added to matching, and skills found in confirmed
 * facts that the user hid from it. Facts stay the only source of skills a draft may claim; this
 * list only changes what Matches scores against.
 */

/** The longest skill name a user can add. */
export const MAX_SKILL_NAME = 60;
/** How many skills a user can add. Hidden skills do not count. */
export const MAX_ADDED_SKILLS = 100;

/** Built-in names and spellings, lowercased with single spaces, to the built-in name. */
const BUILTIN_BY_SPELLING: ReadonlyMap<string, string> = new Map(
  SKILLS.flatMap((skill) =>
    [skill.name, ...skill.spellings].map((spelling) => [spelling.toLowerCase(), skill.name] as const),
  ),
);

export type SkillName =
  | { kind: "ok"; name: string; key: string; builtin: boolean }
  | { kind: "rejected"; message: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Clean a typed skill name. Spaces are trimmed and collapsed, a built-in name or spelling becomes
 * the built-in name ("golang" is Go), and anything else keeps the user's spelling. The key is
 * the lowercased name, so one skill cannot be stored twice in two cases.
 */
export function normalizeSkillName(raw: string): SkillName {
  if (CONTROL.test(raw.replace(/[\t\n\r]/g, " "))) {
    return { kind: "rejected", message: "A skill name cannot contain control characters." };
  }
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned === "") return { kind: "rejected", message: "Type a skill name." };
  if (cleaned.length > MAX_SKILL_NAME) {
    return { kind: "rejected", message: `A skill name can be at most ${MAX_SKILL_NAME} characters.` };
  }
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    return { kind: "rejected", message: "A skill name needs at least one letter or digit." };
  }
  const builtin = BUILTIN_BY_SPELLING.get(cleaned.toLowerCase());
  const name = builtin ?? cleaned;
  return { kind: "ok", name, key: name.toLowerCase(), builtin: builtin !== undefined };
}

/** True when `name` is a built-in skill name (not a spelling of one). */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_BY_SPELLING.get(name.toLowerCase()) === name;
}

export type SkillChip = { name: string; source: SkillChipSource; builtin: boolean };

const DICTIONARY_ORDER: ReadonlyMap<string, number> = new Map(SKILLS.map((s, i) => [s.name.toLowerCase(), i]));

/**
 * The skills Matches scores against, and the chips Profile shows (decision 66).
 * `matching` is (skills found in facts ∪ added) − hidden: built-ins in dictionary order, then the
 * user's own in the order added. A skill both found and added shows as found in facts. A hidden
 * skill still has a chip, so it can be restored.
 *
 * `rows` must be oldest first, with names already normalized.
 */
export function profileSkills({
  factSkills,
  rows,
}: {
  factSkills: readonly string[];
  rows: readonly { name: string; kind: UserSkillKind }[];
}): { matching: string[]; chips: SkillChip[] } {
  const hidden = new Set(rows.filter((r) => r.kind === "hidden").map((r) => r.name.toLowerCase()));
  const found = new Set(factSkills.map((s) => s.toLowerCase()));
  const chips: SkillChip[] = [];
  const seen = new Set<string>();
  const add = (name: string, source: SkillChipSource) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    chips.push({ name, source, builtin: isBuiltinSkill(name) });
  };
  const added = rows.filter((r) => r.kind === "added").map((r) => r.name);
  const builtins = [...factSkills, ...added.filter(isBuiltinSkill)].sort(
    (a, b) => (DICTIONARY_ORDER.get(a.toLowerCase()) ?? 0) - (DICTIONARY_ORDER.get(b.toLowerCase()) ?? 0),
  );
  for (const name of builtins) {
    if (!hidden.has(name.toLowerCase())) add(name, found.has(name.toLowerCase()) ? "facts" : "added");
  }
  for (const name of added) if (!isBuiltinSkill(name)) add(name, "added");
  const matching = chips.map((c) => c.name);
  for (const row of rows) if (row.kind === "hidden") add(row.name, "hidden");
  return { matching, chips };
}

/** The user's own skills that are not built in, in the order added: what `compileSkills` reads jobs for. */
export function customSkillNames(rows: readonly { name: string; kind: UserSkillKind }[]): string[] {
  return rows.filter((r) => r.kind === "added" && !isBuiltinSkill(r.name)).map((r) => r.name);
}

/**
 * What a job's `skills_stamp` holds (decision 68): the built-in dictionary version and the set of
 * the user's own names it was read with. Order does not count: the same names added in another
 * order give the same stamp, and any added or removed name gives another one.
 */
export function skillsStamp({ version, customNames }: { version: number; customNames: readonly string[] }): string {
  const names = [...new Set(customNames)].sort();
  return `${version}:${sha256Hex(names.join("\u0000")).slice(0, 16)}`;
}

/** The stamp of the dictionary `dict` reads with. */
export function dictionaryStamp(dict: SkillDictionary = BUILTIN_SKILLS): string {
  return skillsStamp({ version: BUILTIN_SKILLS_VERSION, customNames: dict.custom });
}
