import type { FactKey } from "@/shared/api";
import { sha256Hex } from "./text";
import {
  blockNamesRole,
  bulletStart,
  isContinuation,
  isRoleHeader,
  isSectionHeading,
  type RoleFields,
  roleHeader,
} from "./work-roles";

/*
 * The base CV (decision 75): the imported CV text as numbered lines a resume is tailored from.
 * Wrapped lines are joined and bullet marks dropped; the wording is the user's own.
 */

export type BaseLineKind = "contact" | "heading" | "role" | "bullet" | "text";
export type BaseSection = "summary" | "skills" | "experience" | "projects" | "education" | "other";

/** A CV role with its draft key (`ROLE-n`), or null when no fact the resume may use is in it. */
export type BaseRole = RoleFields & { key: string | null };

export type BaseLine = {
  /** "L1", "L2" in document order. */
  id: string;
  kind: BaseLineKind;
  /** The user's words. A role line holds its server-written header (`### Title | Company | Dates`). */
  text: string;
  /** The section the line sits in; null for contact lines, before the first heading. */
  section: BaseSection | null;
  /** The id of the role line this line sits under, or null. */
  role: string | null;
  /** The role's draft key: of the role line itself, or of the role a line sits under. */
  roleKey: string | null;
  /** Facts this line is the source of (see `mapFactsToLines`). */
  facts: FactKey[];
};

const SECTIONS: readonly [BaseSection, RegExp][] = [
  ["summary", /summary|profile|objective/i],
  ["skills", /skills/i],
  ["experience", /experience|employment|work\s+history/i],
  ["projects", /projects/i],
  ["education", /education/i],
];

function sectionOf(heading: string): BaseSection {
  return SECTIONS.find(([, re]) => re.test(heading))?.[0] ?? "other";
}

/** A role header spans at most this many lines (title, company, dates). */
const ROLE_BLOCK_LINES = 3;
/** A bullet that ends its sentence, perhaps with a closing note: "… merged. (Merged)". */
const SENTENCE_END = /[.!?](?:["')\]]|\s*\([^)]*\))?$/;
const URL_LINE = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * Split CV text into base lines. Lines before the first section heading are contact. In
 * Experience (and unnamed sections), a block of up to three lines that names a role's title and
 * company is that role's header. A bullet's wrapped next line (starting lower case, a digit or
 * punctuation, after a bullet that has not ended its sentence) joins it, as does a skills line
 * after one ending in a comma. Pure.
 */
/** What a tailoring stores to tell later that the CV was imported again (decision 75). */
export function baseHash(cvText: string): string {
  return sha256Hex(cvText);
}

export function parseBaseCv({ text, roles }: { text: string; roles: readonly BaseRole[] }): BaseLine[] {
  const raw = text.split(/\r?\n/).map((l) => l.trim());
  const out: BaseLine[] = [];
  const used = new Set<BaseRole>();
  let section: BaseSection | null = null;
  let role: { id: string; key: string | null } | null = null;
  let afterMark = false;
  /** False after a blank line, so nothing joins across it. */
  let joinable = false;
  const push = (kind: BaseLineKind, lineText: string): BaseLine => {
    const line: BaseLine = {
      id: `L${out.length + 1}`,
      kind,
      text: lineText,
      section,
      role: kind === "bullet" || kind === "text" ? (role?.id ?? null) : null,
      roleKey: kind === "bullet" || kind === "text" ? (role?.key ?? null) : null,
      facts: [],
    };
    out.push(line);
    joinable = true;
    return line;
  };
  const plain = (line: string | undefined) =>
    line !== undefined && line !== "" && !isSectionHeading(line) && bulletStart(line) === null;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? "";
    if (line === "") {
      joinable = false;
      continue;
    }
    if (isSectionHeading(line)) {
      section = sectionOf(line);
      role = null;
      push("heading", line.replace(/:$/, ""));
      continue;
    }
    if (section === null) {
      push("contact", line);
      continue;
    }
    const bullet = bulletStart(line);
    if (bullet !== null && "mark" in bullet) {
      afterMark = true;
      continue;
    }
    if (afterMark || bullet !== null) {
      afterMark = false;
      push("bullet", bullet !== null && "text" in bullet ? bullet.text : line);
      continue;
    }
    const prev = joinable ? out.at(-1) : undefined;
    if (
      prev !== undefined &&
      prev.kind === "bullet" &&
      isContinuation(line) &&
      !URL_LINE.test(line) &&
      !SENTENCE_END.test(prev.text)
    ) {
      prev.text = `${prev.text} ${line}`;
      continue;
    }
    if (prev !== undefined && prev.kind === "text" && section === "skills" && /,$/.test(prev.text)) {
      prev.text = `${prev.text} ${line}`;
      continue;
    }
    if (section === "experience" || section === "other") {
      const found = roleBlockAt({ raw, at: i, roles, used, plain });
      if (found !== null) {
        used.add(found.role);
        role = null;
        const header = push("role", roleHeader(found.role));
        header.roleKey = found.role.key;
        role = { id: header.id, key: found.role.key };
        i += found.length - 1;
        continue;
      }
    }
    push("text", line);
  }
  return out;
}

/** The shortest block from `at` that names an unused role, widened by lines of only its fields. */
function roleBlockAt({
  raw,
  at,
  roles,
  used,
  plain,
}: {
  raw: readonly string[];
  at: number;
  roles: readonly BaseRole[];
  used: ReadonlySet<BaseRole>;
  plain: (line: string | undefined) => boolean;
}): { role: BaseRole; length: number } | null {
  for (let length = 1; length <= ROLE_BLOCK_LINES; length++) {
    const block = raw.slice(at, at + length);
    if (block.length < length || !block.every(plain)) return null;
    const role = roles.find((r) => !used.has(r) && blockNamesRole({ block, role: r }));
    if (role === undefined) continue;
    let end = at + length;
    while (end - at < ROLE_BLOCK_LINES && plain(raw[end]) && isRoleHeader({ text: raw[end] ?? "", roles: [role] })) {
      end++;
    }
    return { role, length: end - at };
  }
  return null;
}

// ---------- Facts to lines ----------

const STOP = new Set(
  "a an and are as at be by for from has have in into is it of on or our the their this to was were with".split(" "),
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])
    .map((w) => w.replace(/[.-]+$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

const NUMBER = /\d[\d,.]*/g;
const numbersOf = (text: string) => (text.match(NUMBER) ?? []).map((n) => n.replace(/[,.]+$/, ""));

/** A fact counts as from a line when this share of its content words is in the line. */
export const FACT_LINE_COVERAGE = 0.6;

/**
 * How much of the fact the line says: the share of its content words in the line, or 0 when the
 * fact has a number the line lacks.
 */
export function coverage({ fact, line }: { fact: string; line: string }): number {
  const lineWords = new Set(contentWords(line));
  const lineNumbers = new Set(numbersOf(line));
  if (numbersOf(fact).some((n) => !lineNumbers.has(n))) return 0;
  const words = contentWords(fact);
  if (words.length === 0) return 0;
  return words.filter((w) => lineWords.has(w)).length / words.length;
}

type LineFact = { key: FactKey; text: string; roleKey?: string | null };

/**
 * Attach each fact to the base line it was split from: the bullet or text line (in its role, when
 * it has one) that covers most of it, at `FACT_LINE_COVERAGE` or more. Facts with no such line are
 * extras, which an `add` may bring in. Pure.
 */
export function mapFactsToLines({ lines, facts }: { lines: readonly BaseLine[]; facts: readonly LineFact[] }): {
  lines: BaseLine[];
  extras: FactKey[];
} {
  const out = lines.map((l) => ({ ...l, facts: [] as FactKey[] }));
  const extras: FactKey[] = [];
  for (const fact of facts) {
    let best: { line: BaseLine; score: number } | null = null;
    for (const line of out) {
      if (line.kind !== "bullet" && line.kind !== "text") continue;
      if ((fact.roleKey ?? null) !== null && line.roleKey !== fact.roleKey) continue;
      const score = coverage({ fact: fact.text, line: line.text });
      if (score >= FACT_LINE_COVERAGE && (best === null || score > best.score)) best = { line, score };
    }
    if (best === null) extras.push(fact.key);
    else best.line.facts.push(fact.key);
  }
  return { lines: out, extras };
}

/** Whether the parse can be tailored: three bullets or more, and every role's header found. */
export function isUsableBase({ lines, roleCount }: { lines: readonly BaseLine[]; roleCount: number }): boolean {
  const bullets = lines.filter((l) => l.kind === "bullet").length;
  const found = lines.filter((l) => l.kind === "role").length;
  return bullets >= 3 && found >= roleCount && lines.some((l) => l.kind === "heading");
}

// ---------- Rendering ----------

const markers = (facts: readonly FactKey[]) => facts.map((k) => ` [${k}]`).join("");

/**
 * The projects in the Projects section: each one's title line (its name), and the bullets that
 * describe it. A project starts at a text line right after the heading or after a bullet, so a
 * title runs on over the lines under it (a link, a stack) until its first bullet. Bullets with no
 * title before them belong to the heading. Pure.
 */
export function projectEntries(base: readonly BaseLine[]): { title: BaseLine; bullets: string[] }[] {
  const out: { title: BaseLine; bullets: string[] }[] = [];
  let previous: BaseLine | undefined;
  for (const line of base) {
    if (line.section === "projects") {
      const opens = line.kind === "heading" || (line.kind === "text" && previous?.kind !== "text");
      if (opens) out.push({ title: line, bullets: [] });
      else if (line.kind === "bullet") out.at(-1)?.bullets.push(line.id);
    }
    previous = line;
  }
  return out.filter((e) => e.bullets.length > 0);
}

/** One line as body Markdown: `## Heading`, `### role header`, `- bullet [FACT-n]`, or text. */
export function renderLine(line: Pick<BaseLine, "kind" | "text" | "facts">): string {
  switch (line.kind) {
    case "contact":
      return "";
    case "heading":
      return `## ${line.text}`;
    case "role":
      return line.text;
    case "bullet":
      return `- ${line.text}${markers(line.facts)}`;
    case "text":
      return `${line.text}${markers(line.facts)}`;
  }
}

/**
 * The body for these lines: contact left out (the PDF header prints it), a blank line before each
 * heading and role header. Bullets carry their facts' markers, so citations and the outdated check
 * follow the CV's own lines.
 */
export function renderLines(lines: readonly Pick<BaseLine, "kind" | "text" | "facts">[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "contact") continue;
    if ((line.kind === "heading" || line.kind === "role") && out.length > 0) out.push("");
    out.push(renderLine(line));
  }
  return out.join("\n");
}
