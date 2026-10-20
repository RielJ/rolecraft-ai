import type { JOB_SENIORITIES } from "@/shared/enums";
import { tokens } from "./text";

export type JobSeniority = (typeof JOB_SENIORITIES)[number];

/**
 * One skill: the name shown, and the spellings that count as it. Lowercase spellings match in any
 * case. Spellings with capitals are also ordinary English words ("Go", "Rust", "Swift"), so they
 * count only when written exactly that way.
 */
type Skill = {
  name: string;
  spellings: readonly string[];
  /**
   * A capitalized spelling counts only inside a sentence: not first on a line or bullet, and not
   * right after a sentence ends. "Spark joy" and "Foundry is our lab" start sentences.
   */
  strict?: true;
  /** A spelling followed by one of these words is a different name ("Spark Capital", "Grafana Labs"). */
  notAfter?: readonly string[];
  /** A spelling after one of these words is a different name ("Palantir Foundry"). */
  notBefore?: readonly string[];
};

export const SKILLS: readonly Skill[] = [
  { name: "TypeScript", spellings: ["typescript"] },
  { name: "JavaScript", spellings: ["javascript", "ecmascript"] },
  { name: "Python", spellings: ["python"] },
  { name: "Java", spellings: ["java"] },
  { name: "Kotlin", spellings: ["kotlin"] },
  { name: "Go", spellings: ["golang", "Go"] },
  { name: "Rust", spellings: ["Rust", "RUST"] },
  { name: "Ruby", spellings: ["ruby"] },
  { name: "PHP", spellings: ["php"] },
  { name: "Scala", spellings: ["scala"] },
  { name: "Elixir", spellings: ["elixir"] },
  { name: "Haskell", spellings: ["haskell"] },
  { name: "C#", spellings: ["c#"] },
  { name: "C++", spellings: ["c++"] },
  { name: "Swift", spellings: ["Swift", "swiftui"] },
  { name: "Dart", spellings: ["Dart"] },
  { name: "Solidity", spellings: ["Solidity"], strict: true },
  { name: "Bash", spellings: ["Bash", "bash scripting", "bash script"] },
  { name: "Node.js", spellings: ["node.js", "nodejs", "Node"] },
  { name: "Deno", spellings: ["deno"] },
  { name: "Bun", spellings: ["Bun"] },
  { name: ".NET", spellings: [".net", "asp.net", "dotnet"] },
  { name: "React", spellings: ["React", "react.js", "reactjs"] },
  { name: "React Native", spellings: ["react native"] },
  { name: "React Router", spellings: ["react router", "react-router"] },
  { name: "Redux", spellings: ["redux"] },
  { name: "Next.js", spellings: ["next.js", "nextjs"] },
  { name: "Vue", spellings: ["vue", "vue.js", "vuejs"] },
  { name: "Nuxt", spellings: ["nuxt"] },
  { name: "Angular", spellings: ["angular"] },
  { name: "Svelte", spellings: ["svelte", "sveltekit"] },
  { name: "Vite", spellings: ["vite", "vitejs"] },
  { name: "shadcn", spellings: ["shadcn", "shadcn/ui"] },
  { name: "Storybook", spellings: ["storybook"] },
  { name: "Flutter", spellings: ["flutter"] },
  { name: "Express", spellings: ["Express", "express.js", "expressjs"] },
  { name: "NestJS", spellings: ["nestjs"] },
  { name: "Django", spellings: ["django"] },
  { name: "Flask", spellings: ["Flask"] },
  { name: "FastAPI", spellings: ["fastapi"] },
  { name: "Rails", spellings: ["Rails", "ruby on rails"] },
  { name: "Laravel", spellings: ["laravel"] },
  { name: "Spring", spellings: ["Spring", "spring boot"] },
  { name: "GraphQL", spellings: ["graphql"] },
  { name: "gRPC", spellings: ["grpc"] },
  { name: "REST", spellings: ["REST", "restful"] },
  { name: "PostgreSQL", spellings: ["postgres", "postgresql"] },
  { name: "MySQL", spellings: ["mysql"] },
  { name: "SQLite", spellings: ["sqlite"] },
  { name: "SQL", spellings: ["sql"] },
  { name: "MongoDB", spellings: ["mongodb", "mongo"] },
  { name: "Redis", spellings: ["redis"] },
  { name: "DynamoDB", spellings: ["dynamodb"] },
  { name: "Elasticsearch", spellings: ["elasticsearch", "opensearch"] },
  { name: "Kafka", spellings: ["kafka"] },
  { name: "RabbitMQ", spellings: ["rabbitmq"] },
  { name: "Prisma", spellings: ["prisma"], notAfter: ["Cloud", "Access"] },
  { name: "Supabase", spellings: ["supabase"] },
  { name: "Firebase", spellings: ["firebase"] },
  { name: "Docker", spellings: ["docker"] },
  { name: "Kubernetes", spellings: ["kubernetes", "k8s"] },
  { name: "Terraform", spellings: ["terraform"] },
  { name: "Ansible", spellings: ["ansible"] },
  { name: "Nginx", spellings: ["nginx"] },
  { name: "AWS", spellings: ["aws", "amazon web services"] },
  { name: "GCP", spellings: ["gcp", "google cloud"] },
  { name: "Azure", spellings: ["azure"] },
  { name: "Cloudflare", spellings: ["cloudflare"] },
  { name: "Vercel", spellings: ["vercel"] },
  { name: "Linux", spellings: ["linux"] },
  { name: "Git", spellings: ["Git", "github", "gitlab"] },
  { name: "CI/CD", spellings: ["ci/cd"] },
  { name: "GitHub Actions", spellings: ["github actions"] },
  { name: "Jenkins", spellings: ["jenkins"] },
  { name: "Datadog", spellings: ["datadog"] },
  { name: "Grafana", spellings: ["grafana"], notAfter: ["Labs"] },
  { name: "Prometheus", spellings: ["prometheus"] },
  { name: "Sentry", spellings: ["sentry"] },
  { name: "HTML", spellings: ["html"] },
  { name: "CSS", spellings: ["css"] },
  { name: "Tailwind", spellings: ["tailwind", "tailwindcss"] },
  { name: "Figma", spellings: ["figma"] },
  { name: "Android", spellings: ["android"] },
  { name: "iOS", spellings: ["ios"] },
  { name: "Machine learning", spellings: ["machine learning"] },
  { name: "LLM", spellings: ["llm", "llms", "large language model", "large language models"] },
  { name: "OpenAI", spellings: ["openai"] },
  { name: "RAG", spellings: ["RAG", "retrieval-augmented generation", "retrieval augmented generation"] },
  { name: "LangChain", spellings: ["langchain"] },
  { name: "Hugging Face", spellings: ["hugging face", "huggingface"] },
  { name: "PyTorch", spellings: ["pytorch"] },
  { name: "TensorFlow", spellings: ["tensorflow"] },
  { name: "Pandas", spellings: ["pandas"] },
  {
    name: "Spark",
    // Known miss: "Spark, Hadoop" first on a bullet. Strict reads it as a sentence's first word.
    spellings: ["Spark", "pyspark", "apache spark", "spark sql", "spark streaming"],
    strict: true,
    notAfter: ["Networks", "Capital", "Labs", "Group"],
  },
  { name: "Airflow", spellings: ["airflow"] },
  { name: "dbt", spellings: ["dbt"] },
  { name: "Snowflake", spellings: ["Snowflake"] },
  { name: "BigQuery", spellings: ["bigquery"] },
  { name: "Databricks", spellings: ["databricks"] },
  { name: "Tableau", spellings: ["tableau"] },
  { name: "Looker", spellings: ["looker"] },
  { name: "Web3", spellings: ["web3"] },
  { name: "Hardhat", spellings: ["hardhat"] },
  { name: "Foundry", spellings: ["Foundry", "foundry-rs"], strict: true, notBefore: ["Palantir"] },
  { name: "Playwright", spellings: ["playwright"] },
  { name: "Cypress", spellings: ["cypress"] },
  { name: "Selenium", spellings: ["selenium"] },
  { name: "Jest", spellings: ["Jest"] },
];
/**
 * Bump this whenever `SKILLS`, the way a spelling matches, or the way `skill-sections.ts` finds
 * nice-to-have text changes: every stored job's skills stamp goes stale and the next Refresh reads
 * them all again once (decision 68). A test pins a fingerprint of the dictionary to this number, so
 * a dictionary edit without a bump fails; a `skill-sections.ts` edit needs the bump by hand.
 * 2: nice-to-have skills (decision 76).
 */
export const BUILTIN_SKILLS_VERSION = 2;

// Measured extras (open jobs naming each in the dev database, 2026-10-18; kept at 5 or more):
// GitHub Actions 36, LangChain 34, BigQuery 28, Databricks 26, Vercel 25, Tableau 22, Jenkins 21,
// Hugging Face 15, Redux 11, Sentry 10, Looker 9, Storybook 5. Left out: Webpack 4, Ethereum 4,
// Hono 4, Vitest 3, Zod 0, Drizzle 0.

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const words = (list: readonly string[]) => list.map((w) => escapeRegExp(w).replace(/ /g, "\\s+")).join("|");

// A sentence ends at . ! or ? and a space, except after a short form like "e.g." or "etc.".
const SENTENCE_START = "(?:^|\\n|(?<!\\b(?:e\\.g|i\\.e|etc|incl|vs|ex))[.!?]\\s)[\\s\\p{P}\\p{S}]*";

/**
 * A spelling counts only as a whole word: no letter, digit, `+` or `#` touching either end. A
 * spelling in lowercase matches in any case; one with capitals only as written.
 */
function spellingPattern(
  spelling: string,
  {
    exactCase,
    strict = false,
    notAfter = [],
    notBefore = [],
  }: {
    exactCase: boolean;
    strict?: boolean;
    notAfter?: readonly string[];
    notBefore?: readonly string[];
  },
): RegExp {
  const before = [
    "(?<![\\p{L}\\p{N}.])",
    strict && exactCase ? `(?<!${SENTENCE_START})` : "",
    notBefore.length > 0 ? `(?<!(?:${words(notBefore)})\\s+)` : "",
  ].join("");
  const after = [
    "(?![\\p{L}\\p{N}+#]|\\.[\\p{L}\\p{N}])",
    notAfter.length > 0 ? `(?!\\s+(?:${words(notAfter)})(?![\\p{L}\\p{N}]))` : "",
  ].join("");
  return new RegExp(`${before}${escapeRegExp(spelling).replace(/ /g, "\\s+")}${after}`, exactCase ? "u" : "iu");
}

/**
 * The skills one user's jobs are read for: the built-in dictionary, then the user's own skills in
 * the order they were added. Compiled once per refresh or request, never per job.
 */
export type SkillPattern = {
  readonly name: string;
  readonly re: RegExp;
  /**
   * The spelling's longest piece without spaces, folded with `foldCase`. Every text the regex
   * matches contains it once folded, so a text without it skips the regex (decision 68).
   */
  readonly literal: string;
  /**
   * The same piece before folding. Adding a skill of your own asks Postgres for the open jobs whose
   * text contains it, lowercased there (decision 68); Postgres' `lower` is not `foldCase`, so it
   * gets the piece as written and lowercases both sides itself.
   */
  readonly piece: string;
};

export type SkillDictionary = {
  readonly names: readonly string[];
  readonly patterns: readonly SkillPattern[];
  /** The user's own names that compiled, in the order added: what the skills stamp records (decision 68). */
  readonly custom: readonly string[];
};

/**
 * Characters that a case-insensitive regex (`iu`) folds to another letter but `toLowerCase` keeps:
 * µ, ſ, ς, ϐ, ϑ, ϕ, ϖ, ϰ, ϱ, ϵ, the combining iota, Cyrillic ᲀ to ᲈ, ẛ and ι. Found by checking every
 * code point (test/skills-quick-check.test.ts). Each maps to its upper case, lowercased.
 */
const FOLD_EXTRA = "[\u00b5\u017f\u0345\u03c2\u03d0\u03d1\u03d5\u03d6\u03f0\u03f1\u03f5\u1c80-\u1c88\u1e9b\u1fbe]";
const HAS_FOLD_EXTRA = new RegExp(FOLD_EXTRA, "u");
const FOLD_EXTRA_ALL = new RegExp(FOLD_EXTRA, "gu");
const foldExtra = (c: string) => c.toUpperCase().toLowerCase();

/**
 * Lowercase, so that two strings a case-insensitive regex treats as equal fold to the same text.
 * Only the quick-check uses it; the regex still decides.
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  return HAS_FOLD_EXTRA.test(lower) ? lower.replace(FOLD_EXTRA_ALL, foldExtra) : lower;
}

/** The piece every match of `spelling` contains: its longest run without spaces, as written. */
function pieceOf(spelling: string): string {
  return spelling.split(" ").reduce((best, piece) => (piece.length > best.length ? piece : best), "");
}

const BUILTIN_PATTERNS: SkillPattern[] = SKILLS.flatMap((skill) =>
  skill.spellings.map((spelling) => ({
    name: skill.name,
    piece: pieceOf(spelling),
    literal: foldCase(pieceOf(spelling)),
    re: spellingPattern(spelling, {
      exactCase: spelling !== spelling.toLowerCase(),
      ...(skill.strict ? { strict: true } : {}),
      ...(skill.notAfter ? { notAfter: skill.notAfter } : {}),
      ...(skill.notBefore ? { notBefore: skill.notBefore } : {}),
    }),
  })),
);

/** Names of the built-in skills, lowercased. */
const BUILTIN_KEYS: ReadonlySet<string> = new Set(SKILLS.map((s) => s.name.toLowerCase()));

/** A custom name this short ("Zig", "Elm") is too often an ordinary word in other cases, so it matches as written. */
export const CUSTOM_EXACT_CASE_MAX = 3;

/**
 * The built-in dictionary plus the user's own skill names, in the order they were added. A name
 * that is a built-in skill, or repeats an earlier one, adds nothing.
 */
export function compileSkills(custom: readonly string[]): SkillDictionary {
  const seen = new Set(BUILTIN_KEYS);
  const extra: SkillPattern[] = [];
  for (const name of custom) {
    const key = name.toLowerCase();
    if (name.trim() === "" || seen.has(key)) continue;
    seen.add(key);
    extra.push({
      name,
      piece: pieceOf(name),
      literal: foldCase(pieceOf(name)),
      re: spellingPattern(name, { exactCase: name.length <= CUSTOM_EXACT_CASE_MAX }),
    });
  }
  return {
    names: [...SKILLS.map((s) => s.name), ...extra.map((e) => e.name)],
    patterns: [...BUILTIN_PATTERNS, ...extra],
    custom: extra.map((e) => e.name),
  };
}

/** The dictionary with no user skills: what every caller without a user list reads with. */
export const BUILTIN_SKILLS: SkillDictionary = compileSkills([]);

/**
 * Skills from the dictionary that `text` names: built-ins in dictionary order, then the user's own,
 * each once. The text is folded once, and a pattern whose literal it lacks skips its regex
 * (decision 68). `quickCheck: false` runs every regex; the output is the same, and a test proves it.
 */
export function extractSkills(
  text: string,
  dict: SkillDictionary = BUILTIN_SKILLS,
  { quickCheck = true }: { quickCheck?: boolean } = {},
): string[] {
  const folded = quickCheck ? foldCase(text) : "";
  const found = new Set<string>();
  for (const { name, re, literal } of dict.patterns) {
    if (found.has(name) || (quickCheck && !folded.includes(literal))) continue;
    if (re.test(text)) found.add(name);
  }
  return dict.names.filter((name) => found.has(name));
}

/**
 * Built-in skills named in the user's confirmed fact texts, in dictionary order, each once:
 * Profile's "found in your confirmed facts". Matching adds the skills the user added and removes
 * the ones they hid (decision 66, `profileSkills`). A typed skills field on an item does not count
 * (decision 9).
 */
export function skillsInFacts({ texts }: { texts: readonly string[] }): string[] {
  // Each fact on its own, so a two-word skill never spans the end of one fact and the start of the next.
  const found = new Set(texts.flatMap((text) => extractSkills(text)));
  return SKILLS.map((s) => s.name).filter((name) => found.has(name));
}

// Checked in this order; the first level whose words appear in the title wins. Intern beats
// everything, manager beats rank words ("Senior Engineering Manager" manages people).
const SENIORITY_WORDS: readonly (readonly [JobSeniority, readonly string[]])[] = [
  ["intern", ["intern", "internship", "trainee", "ojt"]],
  ["manager", ["manager", "head", "director", "vp"]],
  ["principal", ["principal", "distinguished"]],
  ["staff", ["staff"]],
  ["lead", ["lead", "tech lead", "team lead"]],
  ["senior", ["senior", "sr", "snr", "iii"]],
  ["junior", ["junior", "jr", "jnr", "entry level", "graduate", "associate"]],
  ["mid", ["mid", "mid level", "intermediate", "ii"]],
];

/** The seniority a title states, or null when it states none. */
export function seniority(title: string): JobSeniority | null {
  const text = ` ${tokens(title).join(" ")} `;
  for (const [level, words] of SENIORITY_WORDS) {
    if (words.some((w) => text.includes(` ${w} `))) return level;
  }
  return null;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const YEARS_RE =
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b/gi;

/**
 * The fewest years of experience the posting asks for: the largest lower bound among phrases
 * like "5+ years of experience" or "3-5 years building APIs ... experience". A number counts only
 * when its sentence talks about experience, so "founded 10 years ago" does not.
 */
export function minYears(description: string): number | null {
  let best: number | null = null;
  for (const sentence of description.split(/\n+|(?<=[.!?])\s+/)) {
    if (!/\bexperience|\bexperienced\b|\bbackground\b/i.test(sentence)) continue;
    for (const m of sentence.matchAll(YEARS_RE)) {
      const raw = (m[1] ?? "").toLowerCase();
      const n = NUMBER_WORDS[raw] ?? Number(raw);
      if (Number.isInteger(n) && n > 0 && n <= 30 && (best === null || n > best)) best = n;
    }
  }
  return best;
}
