import type { RoleFamily } from "@/shared/enums";
import { roleFamilyLabel } from "@/shared/labels";
import { normalize } from "./text";

/**
 * The role filter (PLAN.md section 3.7a). A typed rule table says, for each family, which role
 * nouns decide it (`heads`) and which core words name it (`words`). The head noun, the last role
 * word in the title, picks the job's family, so "Design Systems Engineer" is engineering and
 * "Frontend Designer" is design. Every word of every family counts toward "the title mixes
 * families". When in doubt the rules pick `unsure`, never `drop`.
 */

export type RoleFitLevel = "keep" | "unsure" | "drop";
export type RoleFit = { fit: RoleFitLevel; family: RoleFamily | "unknown"; reason: string };

type FamilyRule = {
  family: RoleFamily;
  /** Role nouns that decide the family: the last one in a title wins. */
  heads: readonly RegExp[];
  /** Modifiers that tie a title to the family ("frontend", "ux"); they make a title mixed. */
  words: readonly RegExp[];
  /**
   * Core words that name the family in tags and descriptions, besides the heads. Narrower than
   * `words`: a designer's posting saying "our mobile app" does not name engineering.
   */
  core: readonly RegExp[];
};

// Engineers and developers whose first word names another family are that family's head
// ("Data Engineer", "Sales Engineer"), so the generic head skips those prefixes.
const NOT_GENERIC = String.raw`(?<!\b(?:data|qa|test|security|devops|sales|solutions|support|machine learning|ml|analytics|network|cloud|infrastructure|reliability|automation|quality|field|customer|marketing)[ -])`;

const w = (source: string) => new RegExp(String.raw`(?<![\w-])(?:${source})(?![\w-])`, "gi");

export const ROLE_RULES: readonly FamilyRule[] = [
  {
    family: "engineering",
    heads: [w(`${NOT_GENERIC}(?:engineers?|developers?|programmers?)`), w("swe|sre|site reliability")],
    words: [
      w(
        String.raw`software|frontend|front-end|front end|backend|back-end|back end|full[- ]?stack|web|mobile|ios|android|react|node(?:\.js)?|java|python|golang|ruby|php|\.net|typescript|javascript|embedded|firmware|engineering|programming`,
      ),
    ],
    core: [w("engineering|programming|software development|software engineering")],
  },
  {
    family: "design",
    heads: [w("designers?|ux researcher|illustrator|art director|animator")],
    words: [w("ux|ui|design|visual|graphic|figma|motion")],
    core: [w("ux|ui/ux|user experience|visual design|graphic design|interaction design")],
  },
  {
    family: "product",
    heads: [w("product (?:managers?|owners?|lead|director|management)|head of product")],
    words: [w("product management")],
    core: [w("product management")],
  },
  {
    family: "data",
    heads: [
      w(
        "data (?:scientist|analyst|engineer|architect)s?|(?:machine learning|ml|analytics) engineers?|bi (?:analyst|developer)|business intelligence|statistician|research scientist",
      ),
    ],
    words: [w("data|analytics|machine learning|ml")],
    core: [w("data science|machine learning|analytics")],
  },
  {
    family: "qa",
    heads: [
      w(
        "qa(?: engineer| analyst| lead)?|quality assurance|(?<!penetration )testers?|test (?:engineer|analyst)|sdet|(?:automation|quality) engineers?",
      ),
    ],
    words: [w("testing|test automation")],
    core: [w("quality assurance|test automation|qa")],
  },
  {
    family: "devops",
    heads: [
      w(
        "dev ?ops(?: engineer)?|(?:cloud|infrastructure|network) (?:engineer|administrator|admin)s?|sysadmin|systems? administrator",
      ),
    ],
    words: [w("kubernetes|infrastructure|cloud")],
    core: [w("devops|kubernetes|infrastructure")],
  },
  {
    family: "security",
    heads: [
      w(
        "security (?:engineer|analyst|architect|specialist|researcher)s?|penetration tester|pentester|soc analyst|ciso",
      ),
    ],
    words: [w("security|appsec|infosec|cybersecurity")],
    core: [w("security|cybersecurity|infosec|appsec")],
  },
  {
    family: "sales",
    heads: [
      w(
        "account (?:executive|manager)s?|sdr|bdr|business development (?:representative|manager)|sales (?:engineer|representative|rep|manager|director|associate|executive|lead)s?|solutions (?:engineer|consultant)s?|salesperson",
      ),
    ],
    words: [w("sales|business development|partnerships|revenue")],
    core: [w("sales|business development")],
  },
  {
    family: "marketing",
    heads: [
      w(
        "marketers?|marketing (?:manager|specialist|lead|director|coordinator|associate)|copywriter|content (?:writer|strategist)|seo specialist|growth (?:marketer|manager)|social media manager|community manager|developer advocate|developer relations|devrel",
      ),
    ],
    words: [w("marketing|seo|content|growth|brand|social media|community")],
    core: [w("marketing|seo")],
  },
  {
    family: "support",
    heads: [
      w(
        "support (?:specialist|agent|engineer|representative|associate|lead|manager)s?|customer (?:support|service|success|experience|care)|help ?desk|technical support",
      ),
    ],
    words: [w("support|customer")],
    core: [w("customer support|customer success|technical support")],
  },
  {
    family: "ops",
    heads: [
      w(
        "(?:virtual|executive|administrative|personal) assistant|office manager|project manager|program manager|operations (?:manager|specialist|coordinator|associate|lead|analyst)|data entry|chief of staff|scrum master|delivery manager",
      ),
    ],
    words: [w("operations|ops|admin|logistics")],
    core: [w("operations")],
  },
  {
    family: "people",
    heads: [
      w(
        "recruiters?|talent (?:acquisition|partner|sourcer)|sourcer|hr (?:manager|generalist|business partner|specialist|coordinator)|people (?:partner|operations|ops)|human resources",
      ),
    ],
    words: [w("hr|people|talent|recruiting|recruitment")],
    core: [w("recruiting|recruitment|human resources|talent acquisition")],
  },
  {
    family: "finance",
    heads: [
      w(
        "accountant|bookkeeper|financial (?:analyst|controller)|finance (?:manager|analyst|director)|cfo|payroll specialist|auditor|tax (?:specialist|manager|associate)|accounts (?:payable|receivable)",
      ),
    ],
    words: [w("finance|financial|accounting|payroll|tax")],
    core: [w("finance|accounting|payroll")],
  },
];

type Hit = { family: RoleFamily; end: number; length: number };

function hits(text: string, patterns: (rule: FamilyRule) => readonly RegExp[]): Hit[] {
  const out: Hit[] = [];
  for (const rule of ROLE_RULES) {
    for (const pattern of patterns(rule)) {
      for (const m of text.matchAll(pattern)) {
        out.push({ family: rule.family, end: m.index + m[0].length, length: m[0].length });
      }
    }
  }
  return out;
}

/** Every family a title names, by head noun or modifier. */
export function familiesIn(title: string): Set<RoleFamily> {
  return new Set(hits(title, (r) => [...r.heads, ...r.words]).map((h) => h.family));
}

/** Every family tags or a description name, by head noun or core word only. */
export function familiesNamedIn(text: string): Set<RoleFamily> {
  return new Set(hits(text, (r) => [...r.heads, ...r.core]).map((h) => h.family));
}

/** The family of the last role noun in the title (the longest one on a tie), or null. */
export function headFamily(title: string): RoleFamily | null {
  let best: Hit | null = null;
  for (const hit of hits(title, (r) => r.heads)) {
    if (!best || hit.end > best.end || (hit.end === best.end && hit.length > best.length)) best = hit;
  }
  return best?.family ?? null;
}

/** How much of the description counts toward "a picked family is named" (section 3.7a). */
export const DESCRIPTION_HEAD_CHARS = 300;

const list = (families: Iterable<string>) => [...families].join(" and ");

/**
 * Should a posting from a source be kept? Only `drop` happens at sync; `unsure` is stored and
 * shown with a "Role unclear" chip. An empty `families` list means the user has not picked any,
 * so only exclude words drop.
 */
export function roleFit({
  title,
  tags,
  description,
  families,
  excludeWords,
}: {
  title: string;
  tags: readonly string[];
  description: string;
  families: readonly RoleFamily[];
  excludeWords: readonly string[];
}): RoleFit {
  const matched = familiesIn(title);
  const head = headFamily(title);
  const family: RoleFamily | "unknown" = head ?? (matched.size === 1 ? ([...matched][0] ?? "unknown") : "unknown");

  const excluded = excludeWordIn({ title, excludeWords });
  if (excluded !== null) return { fit: "drop", family, reason: `title contains "${excluded}"` };

  if (families.length === 0) return { fit: "keep", family, reason: "no role families picked" };
  if (matched.size === 0) return { fit: "unsure", family, reason: "no role family in the title" };

  const picked = new Set(families);
  const pickedInTitle = [...matched].filter((f) => picked.has(f));
  const unpickedInTitle = [...matched].filter((f) => !picked.has(f));
  if (pickedInTitle.length > 0 && unpickedInTitle.length > 0) {
    return { fit: "unsure", family, reason: `title mixes ${list([...pickedInTitle, ...unpickedInTitle])}` };
  }
  if (pickedInTitle.length > 0) return { fit: "keep", family, reason: `${family} is one of your role families` };

  const tagFamilies = familiesNamedIn(tags.join("\n"));
  const pickedInTags = [...tagFamilies].filter((f) => picked.has(f));
  if (pickedInTags.length > 0) {
    return { fit: "unsure", family, reason: `title is ${list(unpickedInTitle)} but a tag names ${list(pickedInTags)}` };
  }
  const pickedInDescription = [...familiesNamedIn(description.slice(0, DESCRIPTION_HEAD_CHARS))].filter((f) =>
    picked.has(f),
  );
  if (pickedInDescription.length > 0) {
    return {
      fit: "unsure",
      family,
      reason: `title is ${list(unpickedInTitle)} but the description names ${list(pickedInDescription)}`,
    };
  }
  if (unpickedInTitle.length > 1) {
    return { fit: "unsure", family, reason: `title mixes ${list(unpickedInTitle)}, none of them picked` };
  }
  return { fit: "drop", family, reason: `${list(unpickedInTitle)} is not one of your role families` };
}

/** The first exclude word the title contains, as the user typed it (trimmed), or null. */
export function excludeWordIn({
  title,
  excludeWords,
}: {
  title: string;
  excludeWords: readonly string[];
}): string | null {
  const lowerTitle = title.toLowerCase();
  return excludeWords.map((x) => x.trim()).find((x) => x !== "" && w(escapeRegex(x)).test(lowerTitle)) ?? null;
}

/**
 * The Board's group for a posting sync dropped (decision 53): the exclude word in its title
 * ("Title: intern"), or else the family that is not one of the user's ("Role: Design").
 */
export function roleDropReason({
  title,
  fit,
  excludeWords,
}: {
  title: string;
  fit: RoleFit;
  excludeWords: readonly string[];
}): string {
  const word = excludeWordIn({ title, excludeWords });
  if (word !== null) return `Title: ${word}`;
  return fit.family === "unknown" ? "Role: not one of yours" : `Role: ${roleFamilyLabel(fit.family)}`;
}

function escapeRegex(text: string): string {
  return text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Built-in boards return recent postings of every kind, so sync keeps those whose title or tags
 * contain a keyword (section 3.1 step 3). No keywords keeps everything.
 */
export function matchesKeywords({
  title,
  tags,
  keywords,
}: {
  title: string;
  tags: readonly string[];
  keywords: readonly string[];
}): boolean {
  const wanted = keywords.map(normalize).filter(Boolean);
  if (wanted.length === 0) return true;
  const haystack = ` ${normalize([title, ...tags].join(" "))} `;
  return wanted.some((k) => haystack.includes(` ${k} `));
}
