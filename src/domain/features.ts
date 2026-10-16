import type { JOB_SENIORITIES } from "@/shared/enums";
import { tokens } from "./text";

export type JobSeniority = (typeof JOB_SENIORITIES)[number];

/**
 * One skill: the name shown, and the spellings that count as it. Lowercase spellings match in any
 * case. Spellings with capitals are also ordinary English words ("Go", "Rust", "Swift"), so they
 * count only when written exactly that way.
 */
type Skill = { name: string; spellings: readonly string[] };

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
  { name: "Node.js", spellings: ["node.js", "nodejs", "Node"] },
  { name: "Deno", spellings: ["deno"] },
  { name: "Bun", spellings: ["Bun"] },
  { name: ".NET", spellings: [".net", "asp.net", "dotnet"] },
  { name: "React", spellings: ["React", "react.js", "reactjs"] },
  { name: "React Native", spellings: ["react native"] },
  { name: "Next.js", spellings: ["next.js", "nextjs"] },
  { name: "Vue", spellings: ["vue", "vue.js", "vuejs"] },
  { name: "Nuxt", spellings: ["nuxt"] },
  { name: "Angular", spellings: ["angular"] },
  { name: "Svelte", spellings: ["svelte", "sveltekit"] },
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
  { name: "Docker", spellings: ["docker"] },
  { name: "Kubernetes", spellings: ["kubernetes", "k8s"] },
  { name: "Terraform", spellings: ["terraform"] },
  { name: "Ansible", spellings: ["ansible"] },
  { name: "AWS", spellings: ["aws", "amazon web services"] },
  { name: "GCP", spellings: ["gcp", "google cloud"] },
  { name: "Azure", spellings: ["azure"] },
  { name: "Linux", spellings: ["linux"] },
  { name: "Git", spellings: ["Git", "github", "gitlab"] },
  { name: "CI/CD", spellings: ["ci/cd"] },
  { name: "HTML", spellings: ["html"] },
  { name: "CSS", spellings: ["css"] },
  { name: "Tailwind", spellings: ["tailwind", "tailwindcss"] },
  { name: "Figma", spellings: ["figma"] },
  { name: "Android", spellings: ["android"] },
  { name: "iOS", spellings: ["ios"] },
  { name: "Machine learning", spellings: ["machine learning"] },
  { name: "PyTorch", spellings: ["pytorch"] },
  { name: "TensorFlow", spellings: ["tensorflow"] },
  { name: "Pandas", spellings: ["pandas"] },
  { name: "Spark", spellings: ["Spark", "pyspark", "apache spark"] },
  { name: "Airflow", spellings: ["airflow"] },
  { name: "dbt", spellings: ["dbt"] },
  { name: "Snowflake", spellings: ["Snowflake"] },
  { name: "Playwright", spellings: ["playwright"] },
  { name: "Cypress", spellings: ["cypress"] },
  { name: "Selenium", spellings: ["selenium"] },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A spelling counts only as a whole word: no letter, digit, `+` or `#` touching either end. */
const SKILL_PATTERNS: readonly { name: string; re: RegExp }[] = SKILLS.flatMap((skill) =>
  skill.spellings.map((spelling) => ({
    name: skill.name,
    re: new RegExp(
      `(?<![\\p{L}\\p{N}.])${escapeRegExp(spelling).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}+#]|\\.[\\p{L}\\p{N}])`,
      spelling === spelling.toLowerCase() ? "iu" : "u",
    ),
  })),
);

/** Skills from the dictionary that `text` names, in dictionary order, each once. */
export function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const { name, re } of SKILL_PATTERNS) {
    if (!found.has(name) && re.test(text)) found.add(name);
  }
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
