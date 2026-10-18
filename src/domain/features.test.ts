import { describe, expect, test } from "bun:test";
import { compileSkills, extractSkills, minYears, SKILLS, seniority } from "./features";

describe("extractSkills", () => {
  test("finds dictionary skills once each, under one name", () => {
    expect(
      extractSkills("We use Go, golang tooling, PostgreSQL and postgres replicas, plus k8s and Kubernetes."),
    ).toEqual(["Go", "PostgreSQL", "Kubernetes"]);
  });
  test("ordinary words count only when written as the skill", () => {
    expect(extractSkills("You will go far. We react to rust and change. Built with React and Rust.")).toEqual([
      "Rust",
      "React",
    ]);
    expect(extractSkills("we go to the express lane in spring")).toEqual([]);
  });
  test("whole words only: java is not javascript, sql is not postgresql, c is not c++", () => {
    expect(extractSkills("JavaScript and PostgreSQL")).toEqual(["JavaScript", "PostgreSQL"]);
    expect(extractSkills("Strong C++ and C# skills; Node.js and Next.js")).toEqual(["C#", "C++", "Node.js", "Next.js"]);
  });
  test("names are unique and the dictionary stays between 100 and 115 skills", () => {
    const names = SKILLS.map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(SKILLS.length).toBeGreaterThanOrEqual(100);
    expect(SKILLS.length).toBeLessThanOrEqual(115);
  });
  test.each([
    ["Solidity", "Contracts in Solidity and Hardhat"],
    ["Vite", "Built with Vite"],
    ["Nginx", "behind NGINX"],
    ["Bash", "Python and Bash"],
    ["Bash", "bash scripting for deploys"],
    ["Hardhat", "tested with hardhat"],
    ["Foundry", "tested with Foundry and forge"],
    ["Foundry", "foundry-rs toolchain"],
    ["shadcn", "UI built on shadcn/ui"],
    ["Cloudflare", "Cloudflare Workers"],
    ["React Router", "routing with react-router"],
    ["LLM", "LLM-based features"],
    ["LLM", "fine-tuning large language models"],
    ["Web3", "a Web3 wallet"],
    ["Supabase", "Supabase auth"],
    ["OpenAI", "the OpenAI API"],
    ["RAG", "RAG pipelines"],
    ["RAG", "retrieval-augmented generation"],
    ["Datadog", "DataDog dashboards"],
    ["Prisma", "Node.js, Prisma, PostgreSQL"],
    ["Firebase", "Firebase messaging"],
    ["Jest", "tests in Jest"],
    ["Grafana", "Prometheus, Grafana and Loki"],
    ["Prometheus", "Prometheus alerts"],
    ["Redux", "state in Redux"],
    ["Storybook", "a Storybook library"],
    ["Jenkins", "CI with Jenkins"],
    ["GitHub Actions", "GitHub Actions workflows"],
    ["Sentry", "errors in Sentry"],
    ["Vercel", "deployed on Vercel"],
    ["LangChain", "agents with LangChain"],
    ["Hugging Face", "models from Hugging Face"],
    ["BigQuery", "BigQuery warehouse"],
    ["Databricks", "on Databricks"],
    ["Tableau", "Tableau dashboards"],
    ["Looker", "Looker Studio"],
    ["Spark", "frameworks like Hadoop, Spark, or Flink"],
    ["Spark", "data (e.g. Spark, Flink)"],
    ["Spark", "PySpark jobs"],
    ["Spark", "Spark SQL first on a line"],
  ] as const)("%s is found in %p", (skill, text) => {
    expect(extractSkills(text)).toContain(skill);
  });
  test.each([
    ["Spark", "Spark joy in every release."],
    ["Spark", "We ship fast. Spark is our motto."],
    ["Spark", "Backed by Spark Capital"],
    ["Spark", "Spark Networks is hiring"],
    ["Grafana", "Grafana Labs is hiring"],
    ["Foundry", "experience with Palantir Foundry"],
    ["Foundry", "Foundry is our product lab."],
    ["Prisma", "Prisma Cloud and Prisma Access"],
    ["Jest", "no jest, we mean it"],
    ["RAG", "a rag to wipe the desk"],
    ["Bash", "a team bash on Friday"],
    ["Solidity", "Solidity of the balance sheet"],
    ["Solidity", "the financial solidity of the firm"],
  ] as const)("%s is not found in %p", (skill, text) => {
    expect(extractSkills(text)).not.toContain(skill);
  });
  test("known miss: strict Spark first on a bullet", () => {
    expect(extractSkills("- Spark, Hadoop")).not.toContain("Spark");
  });
  test("multi-word skills match across spacing", () => {
    expect(extractSkills("Experience with React  Native and machine learning")).toEqual([
      "React",
      "React Native",
      "Machine learning",
    ]);
  });
});

describe("compileSkills", () => {
  test("no dictionary reads the built-ins only", () => {
    expect(extractSkills("Hasura and Go")).toEqual(["Go"]);
  });
  test("built-ins first in dictionary order, then the user's skills in the order added", () => {
    const dict = compileSkills(["Temporal", "Hasura"]);
    expect(extractSkills("Hasura, Temporal, Go and TypeScript", dict)).toEqual([
      "TypeScript",
      "Go",
      "Temporal",
      "Hasura",
    ]);
  });
  test("a long name matches in any case; three letters or fewer only as written", () => {
    const dict = compileSkills(["Hasura", "Zig"]);
    expect(extractSkills("HASURA and zig", dict)).toEqual(["Hasura"]);
    expect(extractSkills("hasura and Zig", dict)).toEqual(["Hasura", "Zig"]);
  });
  test("names are escaped and use the built-in boundaries", () => {
    const dict = compileSkills(["C++/CLI", "Temporal"]);
    expect(extractSkills("C++/CLI and Temporal.io", dict)).toEqual(["C++", "C++/CLI"]);
    expect(extractSkills("Temporals and xC++/CLI", dict)).toEqual([]);
    expect(extractSkills("Temporal  workflows", compileSkills(["Temporal workflows"]))).toEqual(["Temporal workflows"]);
  });
  test("a name that is a built-in or a repeat adds nothing", () => {
    expect(compileSkills(["go", "Hasura", "hasura"]).names.slice(SKILLS.length)).toEqual(["Hasura"]);
  });
});

describe("seniority", () => {
  test.each([
    ["Senior Backend Engineer", "senior"],
    ["Sr. Frontend Developer", "senior"],
    ["Staff Software Engineer", "staff"],
    ["Principal Engineer", "principal"],
    ["Tech Lead, Payments", "lead"],
    ["Junior QA Analyst", "junior"],
    ["Software Engineering Intern", "intern"],
    ["Senior Engineering Manager", "manager"],
    ["Software Engineer II", "mid"],
    ["Software Engineer", null],
  ] as const)("%s -> %s", (title, level) => {
    expect(seniority(title)).toBe(level);
  });
});

describe("minYears", () => {
  test("reads the largest lower bound of experience phrases", () => {
    expect(minYears("You have 5+ years of experience in backend work. 2+ years with Go experience is a plus.")).toBe(5);
    expect(minYears("3-5 years of professional experience")).toBe(3);
    expect(minYears("At least three years experience shipping web apps")).toBe(3);
  });
  test("ignores years that are not about experience", () => {
    expect(minYears("Founded 10 years ago, we have grown fast.")).toBeNull();
    expect(minYears("No experience needed.")).toBeNull();
  });
});
