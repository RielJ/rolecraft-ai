import type { Contact } from "@/shared/api";

/**
 * Contact details read from a CV's header (decision 49). Pure and rule-based: every value is a
 * substring of the CV, nothing is guessed or rewritten. Only the first lines are read, because
 * a phone or email further down belongs to a reference or an employer, not the user.
 */

/** How many non-empty lines from the top count as the header. */
const HEADER_LINES = 8;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** A phone: optional +, then 7 to 15 digits with spaces, dots, dashes or brackets between. */
const PHONE = /(?:\+|\b)\d[\d\s().-]{5,18}\d\b/;
/** A link: a scheme, `www.`, or a known profile host, up to the next space or separator. */
const LINK =
  /\b(?:https?:\/\/|www\.|(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com)\/)[^\s•|,;<>()]+/gi;
/** Separators that split a header line into fields. */
const FIELD_SEPARATOR = /\s*[•·|∙◦‧]\s*|\s{3,}/;
/** Words that make a first line a title or a sentence, not a name. */
const NOT_A_NAME =
  /\b(?:resume|résumé|curriculum|vitae|cv|profile|summary|engineer|developer|designer|manager|years?|experience|with|and)\b/i;

function phoneIn(text: string): string {
  for (const match of text.matchAll(new RegExp(PHONE, "g"))) {
    const digits = match[0].replace(/\D/g, "");
    // A year range such as 2018-2020 has 8 digits too; a phone has no 4-digit run that reads as a year pair.
    if (digits.length < 7 || digits.length > 15) continue;
    if (/^(?:19|20)\d{2}\D+(?:19|20)\d{2}$/.test(match[0].trim())) continue;
    return match[0].trim();
  }
  return "";
}

function linksIn(text: string): string[] {
  const links = (text.match(LINK) ?? []).map((link) => link.replace(/[.,;:!?)\]]+$/, ""));
  return [...new Set(links)];
}

/** A first line reads as a name: 2 to 5 words, letters only, no title words. */
function isName(line: string): boolean {
  const words = line.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (NOT_A_NAME.test(line)) return false;
  return words.every((word) => /^\p{L}[\p{L}'.-]*$/u.test(word));
}

/**
 * A location field: what is left of a contact line once the email, phone and links are taken
 * out, when it reads like a place (letters, spaces, commas; no digits or @).
 */
function locationIn(lines: readonly string[]): string {
  for (const line of lines) {
    if (!EMAIL.test(line) && !phoneIn(line)) continue;
    for (const field of line.split(FIELD_SEPARATOR)) {
      const value = field.trim();
      if (value === "" || EMAIL.test(value) || phoneIn(value) || linksIn(value).length > 0) continue;
      if (/^[\p{L}][\p{L}\s,.'-]{1,60}$/u.test(value)) return value;
    }
  }
  return "";
}

export function contactFromCv(text: string): Contact {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, HEADER_LINES);
  const header = lines.join("\n");
  const first = lines[0] ?? "";
  return {
    fullName: isName(first) ? first : "",
    email: header.match(EMAIL)?.[0] ?? "",
    phone: phoneIn(header),
    location: locationIn(lines),
    links: linksIn(header),
  };
}

const FIELDS = ["fullName", "email", "phone", "location", "links"] as const;
type ContactField = (typeof FIELDS)[number];

/** The location the profile starts with (section 3.3): a user who never typed one keeps the country. */
const DEFAULT_LOCATION = "Philippines";

/**
 * Fill the empty fields of `current` from what the CV header holds. A field the user filled is
 * never overwritten. The default country counts as empty, and is kept after a city.
 */
export function fillContact(current: Contact, found: Contact): { contact: Contact; filled: ContactField[] } {
  const contact: Contact = { ...current, links: [...current.links] };
  const filled: ContactField[] = [];
  for (const field of FIELDS) {
    if (field === "links") {
      if (current.links.length === 0 && found.links.length > 0) {
        contact.links = [...found.links];
        filled.push(field);
      }
      continue;
    }
    const value = found[field];
    if (value === "") continue;
    if (field === "location") {
      const now = current.location.trim();
      if (now !== "" && now !== DEFAULT_LOCATION) continue;
      contact.location =
        now === DEFAULT_LOCATION && !value.toLowerCase().includes(DEFAULT_LOCATION.toLowerCase())
          ? `${value}, ${DEFAULT_LOCATION}`
          : value;
      filled.push(field);
      continue;
    }
    if (current[field].trim() !== "") continue;
    contact[field] = value;
    filled.push(field);
  }
  return { contact, filled };
}
