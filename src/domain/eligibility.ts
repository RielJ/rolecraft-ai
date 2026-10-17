import type { Eligibility } from "@/shared/enums";
import { sentencesOf } from "./text";

/**
 * Location restrictions a source states as data, not prose: Ashby's remote restriction list,
 * Himalayas' `locationRestrictions`, Jobicy's `jobGeo`, or JSON-LD `applicantLocationRequirements`.
 * An empty list means "no restriction" (Jobicy's "Anywhere" maps to `[]`).
 */
export type StructuredLocation = { restrictions: readonly string[] };

/** A verdict with the phrase that decided it. Only `unclear` has no phrase (decision 7). */
export type EligibilityVerdict =
  | { verdict: Exclude<Eligibility, "unclear">; phrase: string }
  | { verdict: "unclear"; phrase: null };

type Rule = { name: string; verdict: Exclude<Eligibility, "unclear">; patterns: readonly RegExp[] };

// Words that are also ordinary lowercase English ("us", "sea", "est") match only in capitals,
// through `(?-i:...)`; everything else is case-insensitive with word boundaries.
const LOCK_PLACES = String.raw`(?:(?-i:US|USA|UK|EU)|U\.S\.(?:A\.)?|United States|Canada|Europe|(?-i:LATAM|Latam))`;
const LOCK_COUNTRIES = String.raw`(?:(?-i:US|USA|UK|EU)|U\.S\.(?:A\.)?|United States|United Kingdom|Canada|European Union|Europe|Australia|Germany)`;

/** Section 3.6, in order. The first rule with a hit anywhere in the posting decides. */
export const ELIGIBILITY_RULES: readonly Rule[] = [
  {
    name: "Philippines excluded",
    verdict: "excluded",
    patterns: [
      /\b(?:excluding|except(?: for)?|not (?:open to|available in|hiring in)|cannot hire in|can't hire in|unable to hire in)\b[^.\n]{0,80}?\bPhilippines\b/i,
    ],
  },
  {
    name: "Philippines named",
    verdict: "ph",
    patterns: [/\b(?:Philippines|PH-based|Manila|Cebu|Filipinos?)\b/i],
  },
  {
    name: "Locked to a country or region",
    verdict: "excluded",
    patterns: [
      new RegExp(String.raw`\b${LOCK_PLACES}[ -](?:only|based|residents?)\b`, "i"),
      new RegExp(String.raw`\bmust (?:be located|be based|reside|live) in (?:the )?${LOCK_COUNTRIES}\b`, "i"),
      new RegExp(String.raw`\bauthori[sz]ed to work in (?:the )?${LOCK_COUNTRIES}\b`, "i"),
      /\b(?-i:US|U\.S\.) citizens?(?:hip)?\b/i,
      /\bsecurity clearance\b/i,
    ],
  },
  {
    name: "APAC",
    verdict: "apac",
    patterns: [
      /\b(?:APAC|Asia[- ]Pacific|Southeast Asia|(?-i:SEA)|Asia|(?:GMT|UTC) ?\+ ?0?8(?::00)?)(?![\p{L}\p{N}])/iu,
    ],
  },
  {
    name: "Americas",
    verdict: "americas",
    patterns: [
      /\b(?:Americas|North America|(?-i:US) time ?zones?|(?-i:EST|PST|EDT|PDT)|overlap with (?:the )?(?:(?-i:US)|Eastern|Pacific))\b/i,
    ],
  },
  {
    name: "Worldwide",
    verdict: "worldwide",
    patterns: [
      /\b(?:worldwide|anywhere in the world|work from anywhere|global(?:ly)?[- ]remote|remote[- ]global(?:ly)?|all countries)\b/i,
    ],
  },
];

const PHRASE_MAX = 160;

/** The sentence, cut to about 160 characters around the match, with an ellipsis where cut. */
function trimPhrase(sentence: string, index: number, length: number): string {
  if (sentence.length <= PHRASE_MAX) return sentence;
  const room = Math.max(0, PHRASE_MAX - length);
  let start = Math.max(0, index - Math.floor(room / 2));
  const end = Math.min(sentence.length, start + PHRASE_MAX);
  start = Math.max(0, end - PHRASE_MAX);
  // Cut on word boundaries so the phrase never starts or ends mid-word.
  const head = start > 0 ? sentence.indexOf(" ", start) + 1 || start : 0;
  const tailSpace = end < sentence.length ? sentence.lastIndexOf(" ", end) : end;
  const tail = tailSpace > index + length ? tailSpace : end;
  return `${head > 0 ? "…" : ""}${sentence.slice(head, tail).trim()}${tail < sentence.length ? "…" : ""}`;
}

/**
 * Can someone in the Philippines be hired for this job? Rules run in order (section 3.6) over the
 * location text and then every sentence of the description; the first rule with a hit decides,
 * so an exclusion always beats a region. Structured restrictions come after the text rules.
 */
export function classifyEligibility({
  description,
  locationText,
  structured,
}: {
  description: string;
  locationText: string;
  structured: StructuredLocation | null;
}): EligibilityVerdict {
  const sentences = [...sentencesOf(locationText), ...sentencesOf(description)];
  for (const rule of ELIGIBILITY_RULES) {
    for (const sentence of sentences) {
      for (const pattern of rule.patterns) {
        const m = pattern.exec(sentence);
        if (m) return { verdict: rule.verdict, phrase: trimPhrase(sentence, m.index, m[0].length) };
      }
    }
  }
  if (structured) {
    const places = structured.restrictions.map((p) => p.trim()).filter((p) => p !== "");
    if (places.length === 0) return { verdict: "worldwide", phrase: "Location: Anywhere" };
    const listed = `Hiring in: ${places.join(", ")}`;
    const ph = places.some((p) => /\b(?:Philippines|PH|PHL)\b/i.test(p));
    return { verdict: ph ? "ph" : "excluded", phrase: trimPhrase(listed, 0, 0) };
  }
  return { verdict: "unclear", phrase: null };
}

/** What the light model answered for an `unclear` job, after the reply was parsed. */
export type AiEligibilityAnswer = { verdict: Eligibility; phrase: string | null };

/** Shorter than this, a "phrase" is a word fragment that would match almost any posting. */
const MIN_AI_PHRASE = 4;

/**
 * Accept an AI verdict only when its phrase is a verbatim substring of the posting's description
 * (section 3.1 step 8). Anything else, including an `unclear` answer, returns null and the job
 * stays `unclear`.
 */
export function acceptAiVerdict({
  answer,
  description,
}: {
  answer: AiEligibilityAnswer;
  description: string;
}): Exclude<EligibilityVerdict, { verdict: "unclear" }> | null {
  if (answer.verdict === "unclear" || answer.phrase === null) return null;
  const phrase = answer.phrase.trim();
  if (phrase.length < MIN_AI_PHRASE || !/\p{L}/u.test(phrase)) return null;
  if (!description.includes(phrase)) return null;
  return { verdict: answer.verdict, phrase };
}
