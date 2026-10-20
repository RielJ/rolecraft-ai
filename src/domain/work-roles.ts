/*
 * Resume roles (decision 71, docs/plans/roles.md): a title, an employer, a location and dates read
 * from a CV or an experience add-on. Every field read by AI must appear in the item's text. Drafts
 * never type a header: the model writes `[ROLE-n]` and the server puts the saved role there.
 */

/** A role as saved: title and company always, the rest when the source gives them. */
export type RoleFields = {
  title: string;
  company: string;
  location: string | null;
  start: string | null;
  end: string | null;
};

/** A role as the AI returned it, before `checkRoles`: any field may be missing. */
export type RoleCandidate = {
  title?: string | null | undefined;
  company?: string | null | undefined;
  location?: string | null | undefined;
  start?: string | null | undefined;
  end?: string | null | undefined;
};

/** A role offered to a resume draft, under the key the model writes (`ROLE-1`). */
export type DraftRole = RoleFields & { key: string };

/** Longest field kept from a read; anything longer is not a header field. */
const MAX_FIELD = 200;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const fold = (text: string) => squash(text).toLowerCase();
const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether `text` contains `value` with case and whitespace ignored. A value that starts or ends with
 * a letter or digit must start or end on a word boundary, so "Engineer" is not found in
 * "Engineering".
 */
export function textContains({ text, value }: { text: string; value: string }): boolean {
  const haystack = fold(text);
  const needle = fold(value);
  if (needle === "") return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? " ";
    const after = haystack[at + needle.length] ?? " ";
    const startOk = !WORD.test(needle[0] ?? "") || !WORD.test(before);
    const endOk = !WORD.test(needle.at(-1) ?? "") || !WORD.test(after);
    if (startOk && endOk) return true;
  }
  return false;
}

/** Joining text between header fields: separators and a few small words. */
const HEADER_GLUE = /^(?:[\s,|—–·@()/:;.-]|\b(?:at|in|from|to|since)\b)*$/i;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a split candidate is only one role's header: made of that role's fields (title,
 * company, location, dates) and separators, with nothing else. The role already holds it, so as
 * a fact it would repeat the header (decision 71). Case and whitespace are ignored.
 */
export function isRoleHeader({
  text,
  roles,
}: {
  text: string;
  roles: readonly (RoleCandidate | RoleFields)[];
}): boolean {
  const folded = fold(text);
  return roles.some((role) => {
    const fields = [role.title, role.company, role.location, role.start, role.end]
      .map((f) => fold(f ?? ""))
      .filter((f) => f !== "")
      .sort((a, b) => b.length - a.length);
    let rest = folded;
    let removed = 0;
    for (const field of fields) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(field)}(?![\\p{L}\\p{N}])`, "gu");
      const next = rest.replace(pattern, " ");
      if (next !== rest) removed++;
      rest = next;
    }
    return removed > 0 && HEADER_GLUE.test(rest);
  });
}

/** Lines a header can never be on: bullet text (decision 71). */
const BULLET_MARK = /^[•●▪◦‣∙*-]$/;
const BULLET_LINE = /^[•●▪◦‣∙*-]\s+\S/;
const CONTINUATION = /^[\p{Ll}\p{N}("'“,.;:]/u;
/**
 * A CV section heading, which ends a header block. A name list, not "all capitals", because
 * company lines are often in capitals too ("BANWA, REMOTE").
 */
const SECTION =
  /^(?:(?:professional|work|relevant|career|additional|technical|selected|personal|key|core|other)\s+)?(?:experience|employment(?:\s+history)?|work\s+history|summary|profile|objective|skills|education|projects|certifications?|awards|languages|interests|references|contact)\s*:?$/i;

/** Whether a line is a CV section heading ("WORK EXPERIENCE", "Skills:"). */
export function isSectionHeading(line: string): boolean {
  return SECTION.test(line.trim());
}

/** A line that starts a bullet ("• text"), and a line that is only a bullet mark. */
export function bulletStart(line: string): { text: string } | { mark: true } | null {
  const trimmed = line.trim();
  if (BULLET_MARK.test(trimmed)) return { mark: true };
  return BULLET_LINE.test(trimmed) ? { text: trimmed.slice(1).trim() } : null;
}

/** A line that continues a wrapped bullet: it starts lower case, with a digit or punctuation. */
export function isContinuation(line: string): boolean {
  return CONTINUATION.test(line.trim());
}

/**
 * The text's lines with bullet text and section headings set to null. Bullet text is a line
 * starting with a bullet mark, the line after a lone mark, and a wrapped bullet's next line (one
 * starting lower case, a digit or punctuation). What is left are headers, the name and headline,
 * and plain description lines.
 */
export function headerLines(text: string): (string | null)[] {
  const out: (string | null)[] = [];
  let inBullet = false;
  let afterMark = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (BULLET_MARK.test(line)) {
      out.push(null);
      afterMark = true;
      inBullet = false;
      continue;
    }
    const bullet: boolean = afterMark || BULLET_LINE.test(line) || (inBullet && CONTINUATION.test(line));
    out.push(bullet || SECTION.test(line) ? null : raw);
    inBullet = bullet;
    afterMark = false;
  }
  return out;
}

/** Header blocks: runs of up to four lines with no bullet text in them. */
const BLOCK_LINES = 4;

function headerBlocks(text: string): string[][] {
  const lines = headerLines(text);
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const block: string[] = [];
    for (let j = i; j < Math.min(lines.length, i + BLOCK_LINES); j++) {
      const line = lines[j];
      if (line === null || line === undefined) break;
      block.push(line);
    }
    if (block.length > 0) blocks.push(block);
  }
  return blocks;
}

/** What may come right before a title or company on its line: nothing, a separator, or "at". */
const LEAD = /(?:^|[,|—–·@(/:;]|\bat)\s*$/;

/**
 * Whether `line` has `value` as its own part: found (see `textContains`) and preceded by the line
 * start, a separator or "at", so "Software Engineer" is not read out of "Full-stack Software
 * Engineer".
 */
function leadsPart({ line, value }: { line: string; value: string }): boolean {
  const haystack = fold(line);
  const needle = fold(value);
  // An empty needle is found at every index, and indexOf("", past the end) never advances.
  if (needle === "") return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (!LEAD.test(haystack.slice(0, at))) continue;
    if (textContains({ text: haystack.slice(at), value: needle })) return true;
  }
  return false;
}

/**
 * Whether a block of header lines names this role: its title and its company each lead a part of
 * one of the lines (see `checkRoles`).
 */
export function blockNamesRole({ block, role }: { block: readonly string[]; role: RoleFields }): boolean {
  const has = (value: string) => block.some((line) => leadsPart({ line, value }));
  return has(role.title) && has(role.company);
}

/**
 * Keep only roles whose header the text has (decision 71). The title and the company must each
 * lead a part of a line in one header block (up to four lines with no bullet text), and the
 * location and dates are kept only when that same block has them. So a company named in a bullet
 * ("Stripe"), a title cut short, or one role's dates on another are dropped. Case and whitespace
 * are ignored. Order is kept: the source's order, most recent first. Pure.
 */
export function checkRoles({ text, roles }: { text: string; roles: readonly RoleCandidate[] }): RoleFields[] {
  const blocks = headerBlocks(text);
  const clean = (value: string | null | undefined): string | null => {
    const squashed = squash(value ?? "");
    return squashed === "" || squashed.length > MAX_FIELD ? null : squashed;
  };
  const kept: RoleFields[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const title = clean(role.title);
    const company = clean(role.company);
    if (title === null || company === null) continue;
    const rest = { location: clean(role.location), start: clean(role.start), end: clean(role.end) };
    let best: { location: string | null; start: string | null; end: string | null; score: number } | null = null;
    for (const block of blocks) {
      const has = (value: string) => block.some((line) => leadsPart({ line, value }));
      if (!has(title) || !has(company)) continue;
      const blockText = block.join("\n");
      const keep = (value: string | null) =>
        value !== null && textContains({ text: blockText, value }) ? value : null;
      const found = { location: keep(rest.location), start: keep(rest.start), end: keep(rest.end) };
      const score = Object.values(found).filter((v) => v !== null).length;
      if (best === null || score > best.score) best = { ...found, score };
    }
    if (best === null) continue;
    const checked: RoleFields = { title, company, location: best.location, start: best.start, end: best.end };
    const key = fold(Object.values(checked).join("\u0000"));
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(checked);
  }
  return kept;
}

/** A field as it goes into a header: one line, and no `|`, which separates the header's parts. */
const headerPart = (text: string) => squash(text.replace(/\|/g, "/"));

/** "January 2026 – June 2026", or the one date given, or null. */
export function roleDates(role: Pick<RoleFields, "start" | "end">): string | null {
  const start = role.start ? squash(role.start) : null;
  const end = role.end ? squash(role.end) : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

/**
 * The header line a `[ROLE-n]` becomes: `### Title | Company, Location | Start – End`. Parts the
 * role lacks are left out, so the second part is always the employer and a third is always dates.
 */
export function roleHeader(role: RoleFields): string {
  const org = [role.company, role.location].filter((p): p is string => !!p && p.trim() !== "").map(headerPart);
  const dates = roleDates(role);
  return `### ${[headerPart(role.title), org.join(", "), ...(dates ? [headerPart(dates)] : [])].join(" | ")}`;
}

/** The ROLES block line: `ROLE-1: Title, Company, Location, Start – End`. */
export function rolePromptLine(role: DraftRole): string {
  const parts = [role.title, role.company, role.location, roleDates(role)].filter((p): p is string => !!p);
  return `${role.key}: ${parts.map(squash).join(", ")}`;
}

/** A role header line split into its parts; null when the line is not one. */
export type ParsedRoleHeader = { title: string; org: string; dates: string | null };

const HEADER = /^\s*###\s+(.+?)\s*$/;

export function parseRoleHeader(line: string): ParsedRoleHeader | null {
  const match = HEADER.exec(line);
  if (!match) return null;
  const parts = (match[1] ?? "").split(/\s+\|\s+/).map((p) => p.trim());
  const [title, org, dates, ...rest] = parts;
  if (!title || !org || rest.length > 0) return null;
  return { title, org, dates: dates || null };
}

/** "Title, Company, Location (Start – End)": a header as Copy text and the clean preview show it. */
export function roleHeaderPlain(header: ParsedRoleHeader): string {
  return `${header.title}, ${header.org}${header.dates ? ` (${header.dates})` : ""}`;
}

/** A `[ROLE-n]` line the model wrote, alone or after a heading mark. */
const ROLE_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?\[(ROLE-[1-9]\d*)\][ \t]*$/gm;

/** Any `[ROLE-n]` token, wherever it sits. */
export const ROLE_TOKEN = /\[(ROLE-[1-9]\d*)\]/g;

/**
 * Replace each `[ROLE-n]` line with its role's header. A key that is not in `roles` stays as
 * written, so `checkDraft` reports it as `unknown_role`.
 */
export function expandRoles({ body, roles }: { body: string; roles: readonly DraftRole[] }): string {
  const byKey = new Map(roles.map((r) => [r.key, r]));
  return body.replace(ROLE_LINE, (line, key: string) => {
    const role = byKey.get(key);
    return role ? roleHeader(role) : line;
  });
}

/**
 * The role a fact sits under: the one role whose company equals the fact's section, case and
 * whitespace ignored. None, or two roles at that company, gives null (decision 71).
 */
export function roleForSection<R extends Pick<RoleFields, "company">>({
  section,
  roles,
}: {
  section: string | null;
  roles: readonly R[];
}): R | null {
  if (section === null || fold(section) === "") return null;
  const matches = roles.filter((r) => fold(r.company) === fold(section));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Whether a line has the shape of a role header (`### a | b`), saved or not. */
export function isRoleHeaderLine(line: string): boolean {
  return parseRoleHeader(line) !== null;
}
