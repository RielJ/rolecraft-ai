/**
 * Job-description-like texts for the skill timing tests (decision 66): about 8 KB each, built
 * from posting sentences in a fixed pseudo-random order, so every run reads the same text.
 */

const SENTENCES = [
  "We are a remote-first team building payroll software for small businesses across Asia.",
  "You will build our React and TypeScript web app with a focus on accessibility.",
  "Our backend runs Go and Python services on AWS, with PostgreSQL and Redis behind them.",
  "Experience with Kubernetes, Terraform and GitHub Actions is a plus.",
  "Spark joy in every release by writing tests in Jest and Playwright.",
  "You have 5+ years of experience shipping production systems.",
  "We monitor everything with Prometheus, Grafana and Sentry.",
  "Familiarity with LLMs, RAG pipelines and LangChain helps on the AI team.",
  "Data lives in BigQuery and Databricks; dashboards are in Tableau and Looker.",
  "The mobile team works in Swift, Kotlin and React Native.",
  "Grafana Labs and Spark Capital are among our partners.",
  "- Own features end to end, from design to deploy.",
  "- Write clear docs and review code with care.",
  "- Mentor junior engineers and pair often.",
  "Salary is competitive and paid monthly in PHP or USD.",
  "We hire worldwide and work async across time zones.",
  "Nice to have: Solidity, Hardhat or Foundry for our web3 work.",
  "Our stack also includes Next.js, Tailwind, Prisma and Supabase on Vercel.",
  "Benefits include a learning budget, health cover and flexible hours.",
  "Please include links to work you are proud of when you apply.",
];

/** `count` texts of at least `bytes` characters each. */
export function skillTexts({ count, bytes }: { count: number; bytes: number }): string[] {
  let seed = 42;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  return Array.from({ length: count }, (_, i) => {
    const parts = [`Job ${i}: Senior Software Engineer`];
    let size = parts[0]?.length ?? 0;
    while (size < bytes) {
      const sentence = SENTENCES[next() % SENTENCES.length] ?? "";
      parts.push(sentence);
      size += sentence.length + 1;
    }
    return parts.join(next() % 3 === 0 ? "\n" : " ");
  });
}

/** Twenty skills of the user's own, as a user might add them: some short, some multi-word. */
export const CUSTOM_SKILLS = [
  "Hasura",
  "Temporal",
  "Zig",
  "Elm",
  "OCaml",
  "Remix",
  "Astro",
  "SolidJS",
  "tRPC",
  "Expo",
  "Pulumi",
  "ClickHouse",
  "Kotlin Multiplatform",
  "Jetpack Compose",
  "Power BI",
  "dbt Cloud",
  "Fivetran",
  "Mixpanel",
  "Amplitude",
  "Retool",
];

const SYLLABLES = [
  "ka",
  "lo",
  "mi",
  "ne",
  "ru",
  "sa",
  "ti",
  "vo",
  "ba",
  "de",
  "fu",
  "gi",
  "ho",
  "ja",
  "pe",
  "qu",
  "ri",
  "su",
  "to",
  "wy",
  "xe",
  "zo",
  "an",
  "el",
  "or",
];

/** Words shared across `variedTexts`, as postings share a language: a few common, most rare. */
const VOCABULARY = 2500;

/**
 * `count` texts of at least `bytes` characters, like real postings in the way that matters to
 * Postgres (decision 68): each `search` tsvector holds a few hundred lexemes and a few KB, as on
 * the dev database (about 335 lexemes and 5 KB per job of about 5.6 KB). Words come from a shared, skewed
 * vocabulary of made-up words; every text names payroll in its first sentence and mixes in the
 * posting sentences above.
 */
export function variedTexts({ count, bytes }: { count: number; bytes: number }): string[] {
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    // The low bits of this generator repeat quickly; the high ones vary.
    return Math.floor(seed / 65_536);
  };
  const words = Array.from({ length: VOCABULARY }, (_, i) => {
    let w = "";
    for (let n = i; n > 0 || w === ""; n = Math.floor(n / SYLLABLES.length)) w += SYLLABLES[n % SYLLABLES.length];
    return `${w}x`;
  });
  // A uniform draw to the 8th power makes low indexes common: a skewed, Zipf-like pick, about 500
  // distinct words in 8 KB.
  const word = () => words[Math.floor(VOCABULARY * ((next() % 10_000) / 10_000) ** 8)] ?? "";
  return Array.from({ length: count }, (_, i) => {
    const parts = [`Job ${i}: Senior Software Engineer.`, SENTENCES[0] ?? ""];
    let size = parts.join(" ").length;
    while (size < bytes) {
      const piece =
        next() % 8 === 0
          ? (SENTENCES[next() % SENTENCES.length] ?? "")
          : `${Array.from({ length: 8 + (next() % 8) }, word).join(" ")}.`;
      parts.push(piece);
      size += piece.length + 1;
    }
    return parts.join(next() % 3 === 0 ? "\n" : " ");
  });
}
