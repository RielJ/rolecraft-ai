import { type Contact, FactKey } from "@/shared/api";
import { sentenceSpans } from "./text";

// [FACT-n] with n >= 1, not part of a [[...]] placeholder.
const MARKER = /(?<!\[)\[FACT-([1-9]\d*)\](?!\])/g;
const PLACEHOLDER = /\[\[([^\]]*)\]\]/g;

export function factKey(no: number): FactKey {
  // The only place a FactKey is built from a number; the schema checks the format.
  return FactKey.parse(`FACT-${no}`);
}

/** Distinct cited keys, in order of first use. */
export function parseCitations(body: string): FactKey[] {
  const seen = new Set<string>();
  const keys: FactKey[] = [];
  for (const match of body.matchAll(MARKER)) {
    const no = Number(match[1]);
    const key = factKey(no);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** The inner text of every `[[...]]` placeholder. */
export function findPlaceholders(body: string): string[] {
  return Array.from(body.matchAll(PLACEHOLDER), (m) => m[1] ?? "");
}

/** Remove `[FACT-n]` markers (and the spaces before them) for PDF and Copy as text. */
export function stripMarkers(body: string): string {
  return body.replace(/[ \t]*(?<!\[)\[FACT-[1-9]\d*\](?!\])/g, "");
}

// ---------- Anti-invention check (section 3.4, step 3) ----------

export type DraftFact = { key: FactKey; text: string };

type Span = { sentence: string; start: number; end: number };
export type DraftViolation =
  | (Span & { kind: "unknown_fact"; factKey: string })
  | (Span & { kind: "unsupported_token"; tokens: string[] })
  | (Span & { kind: "uncited_claim"; tokens: string[] });

export type DraftCheck = { ok: true } | { ok: false; violations: [DraftViolation, ...DraftViolation[]] };

/**
 * Skills that count as claims. All-lowercase entries match in any case; entries with capitals
 * are also ordinary English words ("go", "rust"), so they count only when written that way.
 * Slice 5's skills dictionary in features.ts can replace this list.
 */
export const CLAIM_SKILLS: readonly string[] = [
  "typescript",
  "javascript",
  "python",
  "java",
  "kotlin",
  "golang",
  "ruby",
  "php",
  "scala",
  "elixir",
  "haskell",
  "c#",
  "c++",
  "node.js",
  "nodejs",
  "deno",
  "vue",
  "angular",
  "svelte",
  "next.js",
  "nuxt",
  "django",
  "laravel",
  "fastapi",
  "graphql",
  "grpc",
  "postgres",
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "kafka",
  "rabbitmq",
  "elasticsearch",
  "docker",
  "kubernetes",
  "k8s",
  "terraform",
  "ansible",
  "aws",
  "gcp",
  "azure",
  "linux",
  "jenkins",
  "figma",
  "tailwind",
  "html",
  "css",
  "sql",
  "nosql",
  "Go",
  "Rust",
  "Swift",
  "React",
  "Express",
  "Spring",
  "Flask",
  "Rails",
  "REST",
  "Bun",
  "Git",
];

const NUMBER_WORDS: Record<string, string> = {
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  fifteen: "15",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  hundred: "100",
  dozen: "12",
};

// Capitalized words that are structure, greetings or pronouns, not names.
const PLAIN_CAPITALS = new Set([
  "i",
  "i'm",
  "i've",
  "i'd",
  "i'll",
  "experience",
  "education",
  "skills",
  "summary",
  "projects",
  "project",
  "profile",
  "work",
  "employment",
  "history",
  "certifications",
  "languages",
  "contact",
  "about",
  "me",
  "highlights",
  "achievements",
  "selected",
  "key",
  "technical",
  "professional",
  "open",
  "source",
  "dear",
  "hiring",
  "team",
  "manager",
  "regards",
  "sincerely",
  "best",
  "thanks",
  "thank",
  "you",
  "hello",
  "hi",
  "kind",
  "warm",
  "yours",
]);

const URL_RE =
  /\bhttps?:\/\/[^\s)\]]+|\bwww\.[^\s)\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|dev|org|net|ph|co|app|me)\b(?:\/[^\s)\]]*)?/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const NUMBER_RE = /(?<![\p{L}\d])[$€£₱¥]?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB](?![\p{L}])|%|\+)?/gu;
const MARKERS_RE = /\[FACT-[1-9]\d*\]/g;
const PLACEHOLDERS_RE = /\[\[[^\]]*\]\]/g;

function canonicalNumber(raw: string): string[] {
  const n = raw.replace(/[$€£₱¥,\s+%]/g, "").toLowerCase();
  const bare = n.replace(/[kmb]$/, "");
  return bare === n ? [n] : [n, bare];
}

function canonicalUrl(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?/]+$/, "");
}

function words(text: string): string[] {
  return text
    .split(/[\s/–—-]+/)
    .map((w) =>
      w
        .replace(/^[("“'‘[*_]+/, "")
        .replace(/[)"”'’\]*_.,;:!?]+$/, "")
        .replace(/['’]s$/, ""),
    )
    .filter((w) => w !== "");
}

/** Singular and plural count as the same word: "APIs" is backed by "API". */
function hasWord(set: ReadonlySet<string>, lower: string): boolean {
  return set.has(lower) || set.has(`${lower}s`) || (lower.endsWith("s") && set.has(lower.slice(0, -1)));
}

/** What the evidence for a sentence contains, in comparable form. */
type Evidence = { numbers: Set<string>; words: Set<string>; urls: string[]; emails: Set<string> };

function evidenceOf(texts: readonly string[]): Evidence {
  const all = texts.join("\n");
  const emails = new Set(Array.from(all.matchAll(EMAIL_RE), (m) => m[0].toLowerCase()));
  const noEmails = all.replace(EMAIL_RE, " ");
  const urls = Array.from(noEmails.matchAll(URL_RE), (m) => canonicalUrl(m[0]));
  const rest = noEmails.replace(URL_RE, " ");
  const numbers = new Set(Array.from(rest.matchAll(NUMBER_RE), (m) => canonicalNumber(m[0])).flat());
  const lower = new Set(words(rest).map((w) => w.toLowerCase()));
  for (const w of lower) {
    const digit = NUMBER_WORDS[w];
    if (digit) numbers.add(digit);
  }
  return { numbers, words: lower, urls, emails };
}

/** The claim tokens of one sentence (numbers, URLs, emails, skills, proper nouns) the evidence lacks. */
function unsupportedTokens(text: string, facts: Evidence, names: Evidence): string[] {
  const missing: string[] = [];
  const add = (token: string) => {
    if (!missing.includes(token)) missing.push(token);
  };

  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase();
    if (!facts.emails.has(email) && !names.emails.has(email)) add(m[0]);
  }
  const noEmails = text.replace(EMAIL_RE, " ");
  for (const m of noEmails.matchAll(URL_RE)) {
    const url = canonicalUrl(m[0]);
    const known = [...facts.urls, ...names.urls].some((u) => u === url || u.startsWith(`${url}/`));
    if (!known) add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  const rest = noEmails.replace(URL_RE, " ");
  for (const m of rest.matchAll(NUMBER_RE)) {
    const [canon] = canonicalNumber(m[0]);
    if (canon !== undefined && !facts.numbers.has(canon)) add(m[0].trim());
  }

  const list = words(rest);
  list.forEach((word, index) => {
    const lower = word.toLowerCase();
    const digit = NUMBER_WORDS[lower];
    if (digit !== undefined) {
      if (!facts.numbers.has(digit)) add(word);
      return;
    }
    const skill = CLAIM_SKILLS.some((s) => (s === s.toLowerCase() ? s === lower : s === word));
    if (skill) {
      if (!hasWord(facts.words, lower)) add(word);
      return;
    }
    const capitalized = /^\p{Lu}/u.test(word);
    if (!capitalized || index === 0 || PLAIN_CAPITALS.has(lower)) return;
    if (!hasWord(facts.words, lower) && !hasWord(names.words, lower)) add(word);
  });
  return missing;
}

/** Sentence text without markers, placeholders or bold markup: what the check reads. */
function claimText(sentence: string): string {
  return sentence.replace(PLACEHOLDERS_RE, " ").replace(MARKERS_RE, " ").replace(/\*\*/g, "");
}

/**
 * Check a generated draft against the facts it cites (section 3.4, step 3).
 * - `unknown_fact`: a marker cites a key that is not confirmed or not allowed for this kind.
 * - `unsupported_token`: a number, URL, email, skill or proper noun that the cited facts lack.
 *   Proper nouns may also come from the posting's company and title and the contact fields.
 * - `uncited_claim`: a sentence with no markers contains one of those tokens.
 */
export function checkDraft({
  body,
  facts,
  allowedKeys,
  posting,
  contact,
}: {
  body: string;
  facts: readonly DraftFact[];
  allowedKeys: readonly FactKey[];
  posting: { company: string; title: string };
  contact: Contact;
}): DraftCheck {
  const allowed = new Set<string>(allowedKeys);
  const byKey = new Map<string, string>(facts.map((f) => [f.key, f.text]));
  const names = evidenceOf([
    posting.company,
    posting.title,
    contact.fullName,
    contact.location,
    contact.email,
    ...contact.links,
  ]);
  const violations: DraftViolation[] = [];

  for (const span of sentenceSpans(body)) {
    const base: Span = { sentence: span.text, start: span.start, end: span.end };
    const keys = parseCitations(span.text);
    const cited: string[] = [];
    for (const key of keys) {
      const text = byKey.get(key);
      if (text === undefined || !allowed.has(key)) violations.push({ ...base, kind: "unknown_fact", factKey: key });
      else cited.push(text);
    }
    const text = claimText(span.text);
    const tokens = unsupportedTokens(text, evidenceOf(cited), names);
    if (tokens.length === 0) continue;
    violations.push(
      keys.length === 0 ? { ...base, kind: "uncited_claim", tokens } : { ...base, kind: "unsupported_token", tokens },
    );
  }

  const [first, ...rest] = violations;
  return first ? { ok: false, violations: [first, ...rest] } : { ok: true };
}

/** The placeholder that replaces a sentence that failed the check twice. */
export function checkThisPlaceholder(sentence: string): string {
  const plain = stripMarkers(sentence).replace(/[[\]]/g, "").trim();
  return `[[Check this: "${plain}" is not backed by your facts]]`;
}

/** Replace every sentence named in `violations` with a `[[Check this: ...]]` placeholder. */
export function quarantineViolations({
  body,
  violations,
}: {
  body: string;
  violations: readonly DraftViolation[];
}): string {
  const spans = new Map<number, Span>();
  for (const v of violations) spans.set(v.start, v);
  let out = body;
  for (const span of [...spans.values()].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + checkThisPlaceholder(span.sentence) + out.slice(span.end);
  }
  return out;
}

/**
 * Skills from the claim list that appear in `texts`, deduplicated case-insensitively and spelled
 * as first written. This is what "Skills found in your confirmed facts" shows.
 */
export function findSkills({ texts }: { texts: readonly string[] }): string[] {
  const found = new Map<string, string>();
  for (const text of texts) {
    for (const word of words(claimText(text))) {
      const lower = word.toLowerCase();
      if (found.has(lower)) continue;
      if (CLAIM_SKILLS.some((s) => (s === s.toLowerCase() ? s === lower : s === word))) found.set(lower, word);
    }
  }
  return [...found.values()];
}
