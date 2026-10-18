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
