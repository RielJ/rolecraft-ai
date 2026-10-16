import type { StyleHit } from "@/shared/api";
import { MAX_SENTENCE_WORDS } from "@/shared/labels";
import { sentenceSpans, wordCount } from "./text";

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
  "Write as the candidate, in plain first person.",
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

/**
 * Style warnings for a body (section 3.4, step 4a). Warnings never block export.
 * Markers and placeholders are skipped so they never count as words or tells.
 */
export function checkStyle(body: string): StyleHit[] {
  const hits: StyleHit[] = [];
  for (const { text } of sentenceSpans(body)) {
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
  }
  return hits;
}

// The editor and the rewrite prompt share one wording and one limit, so both live in shared.
export { MAX_SENTENCE_WORDS, styleHitLabel } from "@/shared/labels";
