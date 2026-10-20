import { parseCitations, stripMarkers } from "./citations";
import { sentenceSpans } from "./text";
import { parseRoleHeader, roleHeaderPlain } from "./work-roles";

/*
 * How a stored body (Markdown subset with `[FACT-n]` markers and `[[...]]` blanks) becomes what the
 * user reads, copies and edits (docs/plans/clean-files.md, slice A).
 */

const HEADING = /^\s*#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*•]\s+(.*)$/;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * "Content only" text for Copy and the inline letter view: no markers, headings as their own line
 * with a blank line before them, `- ` and `* ` bullets as `• `, and no `**`. A role header
 * (`### Title | Company, Location | Dates`) reads "Title, Company, Location (Dates)". Blanks stay as
 * written; callers decide whether a body with blanks may leave the app.
 */
export function toPlainText(body: string): string {
  const out: string[] = [];
  let gap = false;
  for (const raw of stripMarkers(body).split(/\r?\n/)) {
    const line = raw.replace(/\*\*/g, "").trimEnd();
    if (line.trim() === "") {
      gap = out.length > 0;
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    let text = line;
    const role = parseRoleHeader(line);
    if (heading) {
      text = role ? roleHeaderPlain(role) : (heading[1] ?? "").trim();
      gap = gap || out.length > 0;
    } else if (bullet) {
      text = `${bullet[1] ?? ""}• ${bullet[2] ?? ""}`;
    }
    if (gap) out.push("");
    out.push(text);
    gap = false;
  }
  return out.join("\n");
}

/**
 * Drop a first `# ` line that is the contact's name (old drafts start with one, and the PDF header
 * already prints it), with the blank lines around it. Case and spacing don't matter.
 */
export function stripLeadingName({ body, name }: { body: string; name: string }): string {
  const want = collapse(name).toLowerCase();
  if (want === "") return body;
  const lines = body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const match = /^#\s+(.*)$/.exec(lines[first] ?? "");
  if (!match) return body;
  const heading = collapse(stripMarkers(match[1] ?? "").replace(/\*\*/g, "")).toLowerCase();
  if (heading !== want) return body;
  let next = first + 1;
  while (next < lines.length && lines[next]?.trim() === "") next += 1;
  return lines.slice(next).join("\n");
}

/** The text the user edits: no markers, blanks kept as `[[...]]` so they can still be typed. */
export function cleanForEdit(body: string): string {
  return stripMarkers(body);
}

/**
 * Put markers back after a clean edit. A sentence that reads the same without markers as one in
 * `before` gets that sentence back, markers where they were. A changed or new sentence is the
 * user's own words and gets none. Repeated sentences take the originals in order.
 */
export function restoreMarkers({ before, edited }: { before: string; edited: string }): string {
  const originals = new Map<string, string[]>();
  for (const span of sentenceSpans(before)) {
    const key = collapse(stripMarkers(span.text));
    originals.set(key, [...(originals.get(key) ?? []), span.text]);
  }
  const swaps: { start: number; end: number; text: string }[] = [];
  for (const span of sentenceSpans(edited)) {
    // Markers the user typed themselves stay as typed.
    if (parseCitations(span.text).length > 0) continue;
    const queue = originals.get(collapse(span.text));
    const original = queue?.shift();
    if (original !== undefined) swaps.push({ start: span.start, end: span.end, text: original });
  }
  let out = edited;
  for (const s of swaps.reverse()) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Apply the "Needs your input" form. Each answer replaces every `[[blank]]` with its value, which
 * for a Check this blank is the user's own sentence in place of the whole placeholder. Each
 * `remove` drops the placeholder and the space after it (or before it, at the end of a line).
 * Values are one line with no markers: the user's words cite nothing.
 */
export function fillBlanks({
  body,
  answers,
  remove,
}: {
  body: string;
  answers: readonly { blank: string; value: string }[];
  remove: readonly string[];
}): string {
  let out = body;
  for (const { blank, value } of answers) {
    const text = collapse(stripMarkers(value));
    if (text === "") continue;
    out = out.split(`[[${blank}]]`).join(text);
  }
  for (const blank of remove) {
    const placeholder = escapeRegExp(`[[${blank}]]`);
    out = out
      .replace(new RegExp(`${placeholder}[ \\t]+`, "g"), "")
      .replace(new RegExp(`[ \\t]*${placeholder}`, "g"), "");
  }
  return out;
}
