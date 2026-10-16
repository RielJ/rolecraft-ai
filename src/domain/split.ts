import { checkDraft, factKey } from "./citations";
import { normalize, sentenceSpans } from "./text";

const BULLET = /^\s*(?:[-*•‣◦–]|\d{1,2}[.)])\s+/;

function isHeading(line: string): boolean {
  if (line.endsWith(":")) return true;
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length > 0 && letters === letters.toUpperCase() && !/\d/.test(line);
}

/** Split prose into sentences at ". ", "! ", "? " followed by an uppercase letter. */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=\p{Lu})/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Rule-based fact candidates: one per bullet, one per sentence of prose.
 * Every candidate is a verbatim span of the input, so nothing is invented.
 */
export function splitFacts({ text }: { text: string }): string[] {
  const candidates: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) candidates.push(...sentences(paragraph.join(" ")));
    paragraph = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (BULLET.test(line)) {
      flush();
      const item = line.replace(BULLET, "").trim();
      if (item !== "" && !isHeading(item)) candidates.push(item);
      continue;
    }
    if (isHeading(line)) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = normalize(c);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Checking candidates against the item's own text (section 3.3, step 2) ----------

export type CandidateCheck = {
  kept: string[];
  /** Candidates that say something the item's text does not, with the tokens that gave them away. */
  dropped: { text: string; tokens: string[] }[];
};

const EVIDENCE_KEY = factKey(1);
const NO_CONTACT = { fullName: "", email: "", phone: "", location: "", links: [] };
const NO_POSTING = { company: "", title: "" };

/**
 * Run every candidate through the same `checkDraft` token check drafting uses, with the item's
 * text as the only evidence. Each sentence of a candidate cites that text, so a number, year,
 * proper noun, skill or URL the text lacks fails the check and the candidate is dropped.
 * Candidates that carry markers or placeholders are dropped too. Survivors are trimmed and
 * deduplicated after `normalize`.
 */
export function checkCandidates({
  candidates,
  evidence,
}: {
  candidates: readonly string[];
  evidence: string;
}): CandidateCheck {
  const result: CandidateCheck = { kept: [], dropped: [] };
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = raw.replace(/\s+/g, " ").trim();
    const key = normalize(text);
    if (key === "" || seen.has(key)) continue;
    const markup = text.match(/\[\[|\]\]|\[FACT-\d+\]/g);
    if (markup) {
      result.dropped.push({ text, tokens: [...new Set(markup)] });
      continue;
    }
    const body = sentenceSpans(text)
      .map((s) => `${s.text} [${EVIDENCE_KEY}]`)
      .join("\n");
    const check = checkDraft({
      body,
      facts: [{ key: EVIDENCE_KEY, text: evidence }],
      allowedKeys: [EVIDENCE_KEY],
      posting: NO_POSTING,
      contact: NO_CONTACT,
    });
    if (check.ok) {
      seen.add(key);
      result.kept.push(text);
      continue;
    }
    const tokens = check.violations.flatMap((v) => (v.kind === "unknown_fact" ? [v.factKey] : v.tokens));
    result.dropped.push({ text, tokens: [...new Set(tokens)] });
  }
  return result;
}
