import type { BaseRole } from "./base-cv";

/** Same shape as a real PDF extract: capital headings, two-line role headers, • bullets, wraps. */
export const CV = [
  "ALEX REYES",
  "Backend Engineer",
  "+63 900 000 0000 | alex@example.com",
  "PROFESSIONAL SUMMARY",
  "Backend engineer with 6 years building payment services in Go and Postgres.",
  "SKILLS",
  "Languages: Go, TypeScript, Python,",
  "SQL",
  "Blockchain: Solidity, Hardhat",
  "WORK EXPERIENCE",
  "Senior Backend Engineer Jan, 2023 – Mar, 2025",
  "Paywise (Remote)",
  "• Built a ledger service in Go that settles 2 million payments a day with no",
  "double charges.",
  "• Cut p95 checkout latency by 40% with Postgres query plans and Redis caching.",
  "•",
  "Moved the job queue to Kafka, so retries no longer block checkout.",
  "Backend Engineer Jun, 2020 – Dec, 2022",
  "Shoply (Manila)",
  "• Wrote the order API in TypeScript used by 3 mobile apps.",
  "PROJECTS",
  "Open Source",
  "• Fixed a race in the pgx pool shutdown path. (Merged)",
  "pg-tools - Postgres CLI helpers",
  "https://github.com/alex/pg-tools",
  "• A CLI that diffs two schemas.",
  "EDUCATION",
  "B.S. Computer Science (2020)",
].join("\n");

export const ROLES: BaseRole[] = [
  {
    key: "ROLE-1",
    title: "Senior Backend Engineer",
    company: "Paywise",
    location: "Remote",
    start: "Jan, 2023",
    end: "Mar, 2025",
  },
  {
    key: "ROLE-2",
    title: "Backend Engineer",
    company: "Shoply",
    location: "Manila",
    start: "Jun, 2020",
    end: "Dec, 2022",
  },
];
