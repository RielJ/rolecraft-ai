import { normalize } from "./text";

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
