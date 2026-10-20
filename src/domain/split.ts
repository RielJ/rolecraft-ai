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

/** A fact candidate and the part of the text it sits under: a job, a project or a heading. */
export type FactCandidate = { text: string; section: string | null };

/** A line that can name the bullets under it: short, and not a sentence. */
function isLead(line: string): boolean {
  return line.length <= 100 && !/[.!?]$/.test(line);
}

/**
 * Rule-based fact candidates: one per bullet, one per sentence of prose.
 * Every candidate is a verbatim span of the input, so nothing is invented.
 *
 * Each candidate also gets a section, copied from the text: a short line right above a run of
 * bullets (a CV's "Acme Corp, 2019 to 2023" line), and failing that the latest heading.
 */
export function splitSections({ text }: { text: string }): FactCandidate[] {
  const candidates: FactCandidate[] = [];
  let paragraph: string[] = [];
  let heading: string | null = null;
  let lead: string | null = null;
  let inBullets = false;

  const flush = (section: string | null) => {
    if (paragraph.length) {
      for (const s of sentences(paragraph.join(" "))) candidates.push({ text: s, section });
    }
    paragraph = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      flush(heading);
      continue;
    }
    if (BULLET.test(line)) {
      if (!inBullets) {
        // A one-line paragraph just above the bullets names them, and belongs with them.
        const last = paragraph.at(-1);
        if (paragraph.length === 1 && last && isLead(last)) lead = last;
        flush(paragraph.length === 1 && lead === paragraph[0] ? lead : heading);
      }
      inBullets = true;
      const item = line.replace(BULLET, "").trim();
      if (item !== "" && !isHeading(item)) candidates.push({ text: item, section: lead ?? heading });
      continue;
    }
    inBullets = false;
    if (isHeading(line)) {
      flush(heading);
      heading = line.replace(/:$/, "").trim();
      lead = null;
      continue;
    }
    if (paragraph.length === 0 && isLead(line)) {
      // A new name line ends the previous job's bullets.
      lead = null;
    }
    paragraph.push(line);
  }
  flush(heading);

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = normalize(c.text);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Rule-based fact candidates without their sections. */
export function splitFacts({ text }: { text: string }): string[] {
  return splitSections({ text }).map((c) => c.text);
}

/**
 * A section label is kept only when the item's text contains it, words in order, so a label
 * cannot invent an employer. Anything else becomes null and the fact shows ungrouped.
 */
export function sectionIn({
  section,
  evidence,
}: {
  section: string | null | undefined;
  evidence: string;
}): string | null {
  const label = section?.replace(/\s+/g, " ").trim().replace(/:$/, "") ?? "";
  const key = normalize(label);
  if (key === "" || label.length > 120) return null;
  return ` ${normalize(evidence)} `.includes(` ${key} `) ? label : null;
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
    const tokens = check.violations.flatMap((v) =>
      v.kind === "unknown_fact"
        ? [v.factKey]
        : v.kind === "unknown_role"
          ? [v.roleKey]
          : v.kind === "unknown_project"
            ? [v.projectKey]
            : v.kind === "wrong_role" || v.kind === "wrong_project"
              ? v.factKeys
              : v.kind === "claims_contribution"
                ? [v.words]
                : v.tokens,
    );
    result.dropped.push({ text, tokens: [...new Set(tokens)] });
  }
  return result;
}
