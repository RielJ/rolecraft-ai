import { BUILTIN_SKILLS, extractSkills, type SkillDictionary } from "./features";

/**
 * Required and nice-to-have skills (decision 76). A posting's nice-to-have text is a section under
 * a heading such as "Nice to have" or "Bonus points", a line labelled "Preferred: …", or a line or
 * sentence marked "is a plus" or "(preferred)". A skill named only there is nice to have; a skill
 * named anywhere else in the posting, the title included, is required.
 */

/** Words that open a nice-to-have heading or label, after any Markdown decoration. */
const NICE_HEAD =
  /^(?:nice[- ]to[- ]haves?|good[- ]to[- ]haves?|bonus(?: points)?|preferred(?: (?:qualifications|skills|experience|requirements))?|pluses|extra credit|desired (?:qualifications|skills|experience)|what (?:would|will) make you stand out|even better if|(?:it'?d|it would) be (?:great|nice|a plus) if|ideally(?=\s*:))\b/i;

/** "… is a plus", "… would be a big advantage": marks the clause it closes. */
const PLUS_VERB =
  /\b(?:is|are|would be|will be|considered|counts as) (?:a |an )?(?:big |huge |strong |definite |real |nice )?(?:plus|bonus|advantage)\b/i;
/** "(preferred)", "nice to have", "… preferred.": marks the whole line or sentence. */
const PLUS_TAG =
  /\bnice[- ]to[- ]have\b|\((?:preferred|bonus|optional|a plus|plus|nice[- ]to[- ]have)\)|\bpreferred\.?$/i;

/**
 * A line or sentence split into its required and nice-to-have parts. A label ("Preferred: …") or a
 * tag ("(preferred)") makes all of it nice. "… is a plus" covers only its own clause: the text in
 * its brackets, or the text after the last ";" or dash before it ("MySQL; NoSQL is a plus"). Commas
 * do not end the clause, since they usually list what is a plus ("Go, Rust or Zig is a plus").
 */
function niceParts(text: string): { main: string; nice: string } {
  if (NICE_HEAD.test(text) || PLUS_TAG.test(text)) return { main: "", nice: text };
  const verb = PLUS_VERB.exec(text);
  if (!verb) return { main: text, nice: "" };
  const open = text.lastIndexOf("(", verb.index);
  if (open !== -1 && !text.slice(open, verb.index).includes(")")) {
    const shut = text.indexOf(")", verb.index);
    const end = shut === -1 ? text.length : shut + 1;
    return { main: `${text.slice(0, open)}${text.slice(end)}`.trim(), nice: text.slice(open, end) };
  }
  const before = text.slice(0, verb.index);
  // "Excel required, SQL or Python is an advantage": the clause after "required" is the plus.
  const required = before.search(/\b(?:required|a must)\b(?!.*\b(?:required|a must)\b)/);
  const afterRequired = required === -1 ? -1 : before.indexOf(",", required);
  const cut = Math.max(before.lastIndexOf(";"), before.search(/\s[–—-]\s(?!.*\s[–—-]\s)/), afterRequired);
  if (cut <= 0) return { main: "", nice: text };
  return { main: text.slice(0, cut).trim(), nice: text.slice(cut).replace(/^[,;\s–—-]+/, "") };
}

const BULLET = /^\s*(?:[-*•·▪◦‣]|\d+[.)])\s+\S/;
const LONE_MARKER = /^\s*[-*•·▪◦‣]\s*$/;
/** A heading is short, not a list item, and does not end like a sentence or a list. */
const HEADING_MAX = 60;

const strip = (line: string) =>
  line
    .trim()
    .replace(/^[#>*_\s]+/, "")
    .replace(/[*_\s]+$/, "");

/**
 * The posting's description split into its main text and its nice-to-have text, line by line.
 * A nice-to-have section runs from its heading over the list under it (or one paragraph, when it
 * has no list) and ends at the next heading or at prose after the list.
 */
export function splitNiceToHave(description: string): { main: string; nice: string } {
  const main: string[] = [];
  const nice: string[] = [];
  let inNice = false;
  let sawBullet = false;
  let sawProse = false;
  // Some boards write a list item as a lone "-" with its text a few lines below.
  let pendingMarker = false;
  for (const raw of description.split("\n")) {
    const text = strip(raw);
    if (text === "") continue;
    if (LONE_MARKER.test(raw)) {
      pendingMarker = true;
      continue;
    }
    const bullet = pendingMarker || BULLET.test(raw);
    pendingMarker = false;
    const body = bullet ? text.replace(/^(?:[-*•·▪◦‣]|\d+[.)])\s+/, "") : text;
    const heading = !bullet && text.length <= HEADING_MAX && !/[.!?,;]$/.test(text);

    // A nice-to-have heading opens a section; the same words with text after them ("Preferred:
    // Kafka, Go", "- Bonus: Rust", "Preferred experience with Go.") mark only their own line.
    if (NICE_HEAD.test(body) && !bullet && (heading || text.endsWith(":"))) {
      nice.push(raw);
      inNice = true;
      sawBullet = false;
      sawProse = false;
      continue;
    }

    if (inNice) {
      if (heading) {
        inNice = false;
      } else if (bullet) {
        nice.push(raw);
        sawBullet = true;
        continue;
      } else if (!sawBullet && !sawProse) {
        nice.push(raw);
        sawProse = true;
        continue;
      } else {
        inNice = false;
      }
    }

    // A list item is one unit; prose is read sentence by sentence.
    const parts = (bullet || heading ? [body] : text.split(/(?<=[.!?])\s+/)).map(niceParts);
    const mainText = parts.map((p) => p.main).filter(Boolean);
    const niceText = parts.map((p) => p.nice).filter(Boolean);
    if (niceText.length === 0) main.push(raw);
    else if (mainText.length === 0) nice.push(raw);
    else {
      nice.push(niceText.join(" "));
      if (mainText.length > 0) main.push(mainText.join(" "));
    }
  }
  return { main: main.join("\n"), nice: nice.join("\n") };
}

/**
 * Every skill a posting names (the title and the description, in dictionary order, as
 * `extractSkills` reads them), and the ones among them that are nice to have: named in its
 * nice-to-have text and nowhere else.
 */
export function readJobSkills(
  { title, description }: { title: string; description: string },
  dict: SkillDictionary = BUILTIN_SKILLS,
): { skills: string[]; nice: string[] } {
  const skills = extractSkills(`${title}\n${description}`, dict);
  if (skills.length === 0) return { skills, nice: [] };
  const split = splitNiceToHave(description);
  if (split.nice === "") return { skills, nice: [] };
  const inMain = new Set(extractSkills(`${title}\n${split.main}`, dict));
  const inNice = new Set(extractSkills(split.nice, dict));
  return { skills, nice: skills.filter((s) => inNice.has(s) && !inMain.has(s)) };
}
