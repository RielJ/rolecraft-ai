/*
 * CV texts with role headers, in the two shapes real CVs use (docs/plans/roles.md). Each role is a
 * "Title  Start – End" line followed by a company line. Fictional people; the shapes are copied
 * from real CVs read by the app's own extractor.
 */
import type { RoleFields } from "@/domain/work-roles";

/**
 * The extractor's text of a PDF CV laid out like a Word template: "Mon, YYYY" dates and the
 * location in parentheses after the company. A bullet can wrap onto a second line.
 */
export const PAREN_CV = [
  "MARIA SANTOS",
  "BACKEND ENGINEER",
  "PROFESSIONAL EXPERIENCE",
  "Full-stack Software Engineer Jan, 2026 – Jun, 2026",
  "Lakbay Labs (Remote)",
  "• Built a billing service in TypeScript and Postgres for 40 clinics.",
  "• Cut invoice processing time from 40 minutes to 6 minutes by batching",
  "queries.",
  "Backend Engineer Oct, 2025 – Apr, 2026",
  "Tala.video (Remote, Part-time)",
  "• Migrated the API from Express to Hono on Cloudflare Workers.",
  "Software Engineer Jul, 2023 – Feb, 2024",
  "Sinag Inc. (Cebu City)",
  "• Mentored 3 junior engineers through code review.",
  "EDUCATION",
  "B.S. Computer Engineering (2022)",
].join("\n");

/** The roles a careful reader takes from `PAREN_CV`, most recent first. */
export const PAREN_ROLES: RoleFields[] = [
  {
    title: "Full-stack Software Engineer",
    company: "Lakbay Labs",
    location: "Remote",
    start: "Jan, 2026",
    end: "Jun, 2026",
  },
  {
    title: "Backend Engineer",
    company: "Tala.video",
    location: "Remote, Part-time",
    start: "Oct, 2025",
    end: "Apr, 2026",
  },
  { title: "Software Engineer", company: "Sinag Inc.", location: "Cebu City", start: "Jul, 2023", end: "Feb, 2024" },
];

/**
 * The same kind of CV in another template: full month names, "COMPANY, LOCATION" in capitals, and
 * each bullet a lone "•" line with its text on the next line.
 */
export const COMMA_CV = [
  "JUAN DELA CRUZ",
  "EXPERIENCE",
  "Full-stack Software Engineer January 2026 – Present",
  "BANWA, REMOTE",
  "Payments and reporting for small shops.",
  "•",
  "Built a payments API in Go serving 2M requests a day.",
  "•",
  "Led a team of 4 engineers.",
  "Software Engineer March 2022 – December 2025",
  "BANWA, MANILA",
  "•",
  "Moved the reporting jobs to Postgres.",
  "Frontend Developer June 2019 – February 2022",
  "HALO DIGITAL, MAKATI",
  "•",
  "Rebuilt the storefront in React.",
].join("\n");

/** The roles a careful reader takes from `COMMA_CV`. Two of them are at one company. */
export const COMMA_ROLES: RoleFields[] = [
  {
    title: "Full-stack Software Engineer",
    company: "BANWA",
    location: "REMOTE",
    start: "January 2026",
    end: "Present",
  },
  { title: "Software Engineer", company: "BANWA", location: "MANILA", start: "March 2022", end: "December 2025" },
  {
    title: "Frontend Developer",
    company: "HALO DIGITAL",
    location: "MAKATI",
    start: "June 2019",
    end: "February 2022",
  },
];
