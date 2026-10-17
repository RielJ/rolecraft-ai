/**
 * Undo the page layout in text pulled from a PDF (decision 49). pdf.js returns one line per
 * printed line, so a sentence the page wrapped arrives broken in two, and a bullet glyph often
 * arrives on a line of its own. This joins wrapped lines and drops lone bullets, without
 * changing any word: the result has the same words in the same order.
 *
 * A line joins the next only when both read as one sentence: the line runs close to the page's
 * full width, does not end a sentence, ends on a lower-case letter, a digit or a joining mark,
 * and the next line does not start a new item (a bullet, a `Label:` line or a short heading).
 */

/** A bullet glyph alone on a line. */
const LONE_BULLET = /^[•‣◦▪●∙·*–-]$/;
/** A line that starts an item of its own. */
const ITEM_START = /^(?:[•‣◦▪●∙*–-]|\d{1,2}[.)])\s+/;
/** A heading: one to four words, the first capitalised, no closing punctuation, such as `Projects`. */
const HEADING = /^\p{Lu}[\p{L}&/'-]*(?:\s+[\p{L}&/'-]+){0,3}$/u;
/** A `Label: values` line, such as a skills group. */
const LABELLED = /^\p{Lu}[^:.]{0,40}:\s/u;
/** Punctuation that ends a sentence or a heading. */
const ENDS = /[.!?:)]$/;
/** A last character that says the sentence goes on. */
const GOES_ON = /[\p{Ll}\d,;&/-]$/u;

/** The shortest line that can count as a full-width, wrapped line. */
const MIN_WRAP_WIDTH = 40;

/** Lines at least this long ran to the right margin: 80% of the 90th-percentile line length. */
function wrapWidth(lines: readonly string[]): number {
  const lengths = lines
    .map((line) => line.length)
    .filter((length) => length > 0)
    .sort((a, b) => a - b);
  const p90 = lengths[Math.floor((lengths.length - 1) * 0.9)] ?? 0;
  return Math.max(MIN_WRAP_WIDTH, Math.floor(p90 * 0.8));
}

function continues(line: string, next: string, width: number): boolean {
  if (line.length < width || ENDS.test(line) || !GOES_ON.test(line)) return false;
  if (next === "" || LONE_BULLET.test(next) || ITEM_START.test(next) || LABELLED.test(next)) return false;
  if (HEADING.test(next)) return false;
  return true;
}

export function reflowPdfText(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const width = wrapWidth(lines);
  const out: string[] = [];
  // The last printed line taken, or null after a lone bullet or a blank line: nothing joins it.
  let previous: string | null = null;

  for (const line of lines) {
    if (LONE_BULLET.test(line)) {
      previous = null;
      continue;
    }
    if (line === "") {
      if (out.length > 0 && out.at(-1) !== "") out.push("");
      previous = null;
      continue;
    }
    const last = out.at(-1);
    if (previous !== null && last !== undefined && continues(previous, line, width)) {
      // pair-\nprogramming keeps its hyphen; every other wrap was a space.
      const glue = /\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(line) ? "" : " ";
      out[out.length - 1] = `${last}${glue}${line}`;
    } else {
      out.push(line);
    }
    previous = line;
  }
  return out.join("\n").trim();
}
