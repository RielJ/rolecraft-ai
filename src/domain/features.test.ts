import { describe, expect, test } from "bun:test";
import { extractSkills, minYears, seniority } from "./features";

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
  test("multi-word skills match across spacing", () => {
    expect(extractSkills("Experience with React  Native and machine learning")).toEqual([
      "React",
      "React Native",
      "Machine learning",
    ]);
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
