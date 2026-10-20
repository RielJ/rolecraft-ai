import type { StyleHit } from "@/shared/api";
import type { OutputKind } from "@/shared/enums";
import { MAX_SENTENCE_WORDS } from "@/shared/labels";
import { sentenceSpans, wordCount } from "./text";
import { isRoleHeaderLine } from "./work-roles";

/**
 * Phrases that make writing read as machine-made (decision 43). The prompt lists every one of
 * them and `checkStyle` flags them, so the two can never drift apart.
 * Matching is case-insensitive on word boundaries, and a word also matches its common endings
 * ("leverage" catches "leveraging" and "leveraged").
 */
export const BANNED_PHRASES = [
  "I am excited",
  "I'm excited",
  "thrilled",
  "passionate about",
  "leverage",
  "delve",
  "proven track record",
  "results-driven",
  "dynamic",
  "synergy",
  "spearheaded",
  "in today's fast-paced",
  "fast-paced environment",
  "I believe I would be a great fit",
  "look no further",
  "tapestry",
  "testament to",
  "seamless",
  "robust",
  "cutting-edge",
  "game-changer",
  "go-getter",
  "self-starter",
  "team player",
  "hit the ground running",
  "think outside the box",
  "wealth of experience",
  "unwavering",
  "meticulous",
  "elevate",
  "empower",
  "embark",
  "navigate the complexities",
  "ever-evolving",
  "it is worth noting",
  "I am writing to express my interest",
] as const;

/** The voice rules every drafting prompt carries (section 3.4, step 2). */
export const VOICE_RULES: readonly string[] = [
  "Use short, concrete sentences. Keep every sentence under 35 words.",
  "Do not use em dashes or en dashes as punctuation. Use a full stop or a comma instead.",
  "Do not use stacked adjectives or lists of three adjectives.",
  "Do not open by flattering the company.",
  "Match the language and the level of formality of the job posting.",
  `Never use these words or phrases: ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}.`,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One regex per phrase. Apostrophes match both ' and ’. The last word may take an ending.
const PHRASE_PATTERNS = BANNED_PHRASES.map((phrase) => {
  const body = escapeRegExp(phrase).replace(/'/g, "['’]").replace(/ /g, "\\s+");
  const endings = /[a-z]$/i.test(phrase) ? "(?:s|d|ed|ing|ly)?" : "";
  return new RegExp(`(?<![\\p{L}\\d])${body.replace(/e$/, "e?")}${endings}(?![\\p{L}\\d])`, "giu");
});

// A dash used as punctuation: an em dash anywhere, or an en dash between words with spaces.
// "2019–2021" (a range without spaces) is not punctuation.
const DASH = /—|\s–\s|\s--\s/g;

// Adjective-like words (common endings), three in a row: "fast, reliable, and scalable".
const ADJ = "[\\p{L}-]+(?:ive|ous|ful|ble|ent|ant|ic|al|ary|less|ed|ing|ient|ile)";
const TRIPLET = new RegExp(`\\b${ADJ},\\s+${ADJ},?\\s+(?:and|or)\\s+${ADJ}\\b`, "giu");

// A first-person pronoun. "I" only as a capital, so "I/O" and "US" never match.
const PRONOUN =
  /(?<![\p{L}\d'’/-])(?:I(?:['’](?:m|ve|d|ll))?|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e(?:['’](?:re|ve|d|ll))?|[Oo]urs?|us)(?![\p{L}\d'’/-])/gu;

// A bullet that starts with a bold label, "**Languages:** Go" or "**Viem:** Added", is a list
// entry, not a sentence with an opener.
const LABELLED = /^\*\*[^*]+\*\*:?/;

// A trailing ", cutting …" / ", resulting in …" clause. Common endings that name a scope are fine.
const TRAILING_ING = /,\s+(?:\p{L}+ly\s+)?(\p{L}+ing)\b[^,;]*[.!]?$/u;
const SCOPE_WORDS = new Set(["including", "using", "covering", "spanning"]);

/** Lowercased openers the pronoun rule already covers, contractions cut at the apostrophe. */
const PRONOUN_OPENERS = new Set(["i", "me", "my", "mine", "myself", "we", "our", "ours", "us"]);

/** Within one heading's bullets, a second use of an opener is allowed; a third is flagged. */
const OPENER_PER_GROUP = 2;

type Bullet = { sentence: string; group: number; opener: string | null; trailing: string | null };

/** Each `-` bullet's first sentence, its heading group, opening word and trailing -ing clause. */
function bulletsOf(body: string): Bullet[] {
  const lines = body.split("\n");
  const firstSpan = new Map<number, string>();
  for (const span of sentenceSpans(body)) if (!firstSpan.has(span.line)) firstSpan.set(span.line, span.text);
  const bullets: Bullet[] = [];
  let group = 0;
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) {
      group += 1;
      return;
    }
    const sentence = firstSpan.get(index);
    if (!/^\s*[-*•]\s+/.test(line) || sentence === undefined || LABELLED.test(sentence)) return;
    const plain = sentence.replace(/\s*\[FACT-[1-9]\d*\]/g, "").replace(/\*\*/g, "");
    const opener = /^[\p{L}][\p{L}'’-]*/u.exec(plain)?.[0].toLowerCase() ?? null;
    const ing = TRAILING_ING.exec(plain)?.[1]?.toLowerCase() ?? null;
    bullets.push({ sentence, group, opener, trailing: ing && !SCOPE_WORDS.has(ing) ? ing : null });
  });
  return bullets;
}

/**
 * Bullets that start the way too many others do: a third use of one opener under one heading, or
 * any use past a quarter of all bullets (at least three are allowed). Pronoun openers are left to
 * the pronoun rule.
 */
function repeatedOpeners(bullets: readonly Bullet[]): StyleHit[] {
  const allowedOverall = Math.max(3, Math.floor(bullets.length / 4));
  const overall = new Map<string, number>();
  const perGroup = new Map<string, number>();
  const hits: StyleHit[] = [];
  for (const b of bullets) {
    if (b.opener === null || PRONOUN_OPENERS.has(b.opener.replace(/['’].*$/, ""))) continue;
    const seen = (overall.get(b.opener) ?? 0) + 1;
    const key = `${b.group}:${b.opener}`;
    const seenHere = (perGroup.get(key) ?? 0) + 1;
    overall.set(b.opener, seen);
    perGroup.set(key, seenHere);
    if (seen > allowedOverall || seenHere > OPENER_PER_GROUP) {
      hits.push({ sentence: b.sentence, phrase: b.opener, rule: "repeated_opener" });
    }
  }
  return hits;
}

/** When more than half of four or more bullets end in a trailing -ing clause, the ones past half. */
function sameShape(bullets: readonly Bullet[]): StyleHit[] {
  if (bullets.length < 4) return [];
  const shaped = bullets.filter((b) => b.trailing !== null);
  const allowed = Math.floor(bullets.length / 2);
  if (shaped.length <= allowed) return [];
  return shaped.slice(allowed).map((b) => ({ sentence: b.sentence, phrase: b.trailing ?? "", rule: "same_shape" }));
}

/**
 * Style warnings for a body (section 3.4, step 4a). Warnings never block export.
 * Markers and placeholders are skipped so they never count as words or tells. A resume also
 * flags pronouns; bullets in any kind are checked for repeated openers and one repeated shape.
 */
export function checkStyle({ body, kind }: { body: string; kind: OutputKind }): StyleHit[] {
  const hits: StyleHit[] = [];
  const lines = body.split("\n");
  for (const { text, line } of sentenceSpans(body)) {
    // A role header is built from the saved role; its "Jan, 2026 – Jun, 2026" is a range, not a dash.
    if (isRoleHeaderLine(lines[line] ?? "")) continue;
    const plain = text.replace(/\[FACT-[1-9]\d*\]/g, "").replace(/\[\[[^\]]*\]\]/g, "…");
    for (const m of plain.matchAll(DASH)) hits.push({ sentence: text, phrase: m[0].trim(), rule: "dash" });
    for (const re of PHRASE_PATTERNS) {
      for (const m of plain.matchAll(re)) hits.push({ sentence: text, phrase: m[0], rule: "banned_phrase" });
    }
    for (const m of plain.matchAll(TRIPLET)) {
      hits.push({ sentence: text, phrase: m[0], rule: "adjective_triplet" });
    }
    if (wordCount(plain) > MAX_SENTENCE_WORDS) {
      hits.push({ sentence: text, phrase: plain.split(/\s+/).slice(0, 6).join(" "), rule: "long_sentence" });
    }
    if (kind === "resume") {
      const pronoun = plain.match(PRONOUN)?.[0];
      if (pronoun !== undefined) hits.push({ sentence: text, phrase: pronoun, rule: "pronoun" });
    }
  }
  const bullets = bulletsOf(body);
  return [...hits, ...repeatedOpeners(bullets), ...sameShape(bullets)];
}

// The editor and the rewrite prompt share one wording and one limit, so both live in shared.
export { MAX_SENTENCE_WORDS, styleHitLabel } from "@/shared/labels";
