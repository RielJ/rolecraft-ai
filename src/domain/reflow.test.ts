import { describe, expect, test } from "bun:test";
import { reflowPdfText } from "./reflow";

const lines = (...rows: string[]) => rows.join("\n");

describe("reflowPdfText", () => {
  test("joins a sentence the page wrapped, and keeps the header and headings on their own lines", () => {
    const pdf = lines(
      "Ana Cruz",
      "+63 917 555 0101 • ana@cruz.dev • Iligan City",
      "Summary",
      "Senior Full-stack Engineer with over 5 years of experience specializing in the design and development of",
      "scalable cloud-based microservices and financial services solutions. Proven track record of leveraging",
      "TypeScript, AWS, and modern distributed systems to drive technical excellence and meet complex regulatory",
      "requirements.",
      "Work Experience",
    );
    expect(reflowPdfText(pdf)).toBe(
      lines(
        "Ana Cruz",
        "+63 917 555 0101 • ana@cruz.dev • Iligan City",
        "Summary",
        "Senior Full-stack Engineer with over 5 years of experience specializing in the design and development of scalable cloud-based microservices and financial services solutions. Proven track record of leveraging TypeScript, AWS, and modern distributed systems to drive technical excellence and meet complex regulatory requirements.",
        "Work Experience",
      ),
    );
  });

  test("a bullet glyph on a line of its own separates items and is dropped", () => {
    const pdf = lines(
      "Full-stack Software Engineer January 2026 – June 2026",
      "CASHFLOWY, REMOTE",
      "Led the design and implementation of React/TypeScript and Django microservices for a financial services platform,",
      "ensuring high availability and regulatory compliance for transaction and invoicing workflows.",
      "•",
      "Drive modernization of core database queries, achieving a 40-66% performance increase through targeted",
      "refactoring and the elimination of high-latency query patterns to reduce technical debt.",
      "•",
      "Full-stack Software Engineer October 2025 – April 2026",
    );
    expect(reflowPdfText(pdf)).toBe(
      lines(
        "Full-stack Software Engineer January 2026 – June 2026",
        "CASHFLOWY, REMOTE",
        "Led the design and implementation of React/TypeScript and Django microservices for a financial services platform, ensuring high availability and regulatory compliance for transaction and invoicing workflows.",
        "Drive modernization of core database queries, achieving a 40-66% performance increase through targeted refactoring and the elimination of high-latency query patterns to reduce technical debt.",
        "Full-stack Software Engineer October 2025 – April 2026",
      ),
    );
  });

  test("a word hyphenated across lines keeps its hyphen and loses the space", () => {
    const pdf = lines(
      "Influence the technical growth of junior engineers through structured code reviews and collaborative pair-",
      "programming, emphasizing clean code and API design standards.",
    );
    expect(reflowPdfText(pdf)).toBe(
      "Influence the technical growth of junior engineers through structured code reviews and collaborative pair-programming, emphasizing clean code and API design standards.",
    );
  });

  test("labelled skill lines stay apart, and a wrapped one is joined", () => {
    const pdf = lines(
      "Core Languages & Development: Java, TypeScript, JavaScript, Go, Scala, Python, Solidity, Node.js, Golang",
      "Cloud, Infrastructure & DevOps: AWS, Kubernetes, Docker, Docker Compose, Terraform, CI/CD,",
      "Infrastructure as Code, GCP, GitHub Actions, Fly.io, Serverless, Observability",
      "Frameworks & UI: React, Next.js, Django, NestJS, Express, Tailwind CSS, ShadCn UI, GraphQL, Vite",
      "Databases & Tools: PostgreSQL, Redis, MongoDB, DynamoDB, Nginx, Bash, Linux (Arch), Hardhat, Foundry",
      "Projects",
    );
    expect(reflowPdfText(pdf)).toBe(
      lines(
        "Core Languages & Development: Java, TypeScript, JavaScript, Go, Scala, Python, Solidity, Node.js, Golang",
        "Cloud, Infrastructure & DevOps: AWS, Kubernetes, Docker, Docker Compose, Terraform, CI/CD, Infrastructure as Code, GCP, GitHub Actions, Fly.io, Serverless, Observability",
        "Frameworks & UI: React, Next.js, Django, NestJS, Express, Tailwind CSS, ShadCn UI, GraphQL, Vite",
        "Databases & Tools: PostgreSQL, Redis, MongoDB, DynamoDB, Nginx, Bash, Linux (Arch), Hardhat, Foundry",
        "Projects",
      ),
    );
  });

  test("a long uppercase line before a heading is not joined to it", () => {
    const pdf = lines(
      "Lead the development of full-stack AI solutions, including automated campaign creation and complex dataset",
      "workflows, while managing account analytics and secure share portals.",
      "B.S. in Computer Engineering January 2022",
      "MINDANAO STATE UNIVERSITY – ILIGAN INSTITUTE OF TECHNOLOGY, ILIGAN CITY, PHILIPPINES",
      "Additional Skills",
    );
    expect(reflowPdfText(pdf).split("\n").slice(1)).toEqual([
      "B.S. in Computer Engineering January 2022",
      "MINDANAO STATE UNIVERSITY – ILIGAN INSTITUTE OF TECHNOLOGY, ILIGAN CITY, PHILIPPINES",
      "Additional Skills",
    ]);
  });

  test("a bullet that leads its line keeps it, and the next bullet starts a new line", () => {
    const pdf = lines(
      "• Owned the full lifecycle design and development of an automated financial asset-allocation product, from",
      "initial architecture through deployment on AWS.",
      "• Modernized a legacy Angular application by migrating to Next.js.",
    );
    expect(reflowPdfText(pdf)).toBe(
      lines(
        "• Owned the full lifecycle design and development of an automated financial asset-allocation product, from initial architecture through deployment on AWS.",
        "• Modernized a legacy Angular application by migrating to Next.js.",
      ),
    );
  });

  test("blank lines stay paragraph breaks, and short lines are left alone", () => {
    expect(reflowPdfText("Ana Cruz\nana@cruz.dev\n\nSkills\nGo")).toBe("Ana Cruz\nana@cruz.dev\n\nSkills\nGo");
  });
});
