import { describe, expect, test } from "bun:test";
import { compileSkills } from "./features";
import { readJobSkills, splitNiceToHave } from "./skill-sections";

const lines = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

describe("splitNiceToHave", () => {
  test("a heading's list is nice; the section ends at the next heading", () => {
    const { main, nice } = splitNiceToHave(
      [
        "Requirements",
        "",
        "- 5 years of TypeScript",
        "- PostgreSQL in production",
        "",
        "Nice to Have",
        "",
        "- Kafka or RabbitMQ",
        "- Some Rust",
        "",
        "Interviewing with Acme",
        "",
        "We value your time.",
      ].join("\n"),
    );
    expect(lines(nice)).toEqual(["Nice to Have", "- Kafka or RabbitMQ", "- Some Rust"]);
    expect(main).toContain("PostgreSQL");
    expect(main).toContain("Interviewing with Acme");
  });

  test("Markdown headings and a trailing colon open a section too", () => {
    expect(lines(splitNiceToHave("## **Bonus points:**\n* Go\n* Rust\n\n## Benefits\n* Remote").nice)).toEqual([
      "## **Bonus points:**",
      "* Go",
      "* Rust",
    ]);
    expect(lines(splitNiceToHave("Bonus points if you have experience with:\n- Terraform").nice)).toEqual([
      "Bonus points if you have experience with:",
      "- Terraform",
    ]);
  });

  test("a section with no list takes one paragraph", () => {
    const { main, nice } = splitNiceToHave(
      "Nice to have\nExperience with Kafka and Go.\nWe offer equity and remote work.",
    );
    expect(lines(nice)).toEqual(["Nice to have", "Experience with Kafka and Go."]);
    expect(main).toBe("We offer equity and remote work.");
  });

  test("prose after the list ends the section", () => {
    const { main, nice } = splitNiceToHave("Preferred Qualifications\n- AWS\nAcme is an equal opportunity employer.");
    expect(lines(nice)).toEqual(["Preferred Qualifications", "- AWS"]);
    expect(main).toBe("Acme is an equal opportunity employer.");
  });

  test("lone list markers with the text further down stay in the section", () => {
    const { nice } = splitNiceToHave(
      "Nice to Have\n\n-\n\nSelling observability or DevOps platforms\n\n-\n\nC-level ties\n\nWhy join",
    );
    expect(lines(nice)).toEqual(["Nice to Have", "Selling observability or DevOps platforms", "C-level ties"]);
  });

  test("a labelled or marked line is nice on its own, and its neighbours are not", () => {
    const { main, nice } = splitNiceToHave(
      [
        "- Node.js and PostgreSQL",
        "- Preferred: Kafka, Go",
        "- Kubernetes is a plus",
        "- Docker (nice to have)",
        "- Terraform preferred",
        "- AWS",
      ].join("\n"),
    );
    expect(lines(nice)).toEqual([
      "- Preferred: Kafka, Go",
      "- Kubernetes is a plus",
      "- Docker (nice to have)",
      "- Terraform preferred",
    ]);
    expect(lines(main)).toEqual(["- Node.js and PostgreSQL", "- AWS"]);
  });

  test("in prose only the marked sentence is nice", () => {
    const { main, nice } = splitNiceToHave(
      "You will build APIs in Go. Experience with Kafka would be a big plus. You join a team of 5.",
    );
    expect(nice).toBe("Experience with Kafka would be a big plus.");
    expect(main).toBe("You will build APIs in Go. You join a team of 5.");
  });

  test("'is a plus' covers its own clause: after a semicolon or dash, or inside brackets", () => {
    expect(splitNiceToHave("- Familiar with MySQL; knowledge of MongoDB is a plus")).toEqual({
      main: "Familiar with MySQL",
      nice: "knowledge of MongoDB is a plus",
    });
    expect(splitNiceToHave("- Strong engineering background – familiarity with Python will be a bonus").nice).toBe(
      "familiarity with Python will be a bonus",
    );
    expect(splitNiceToHave("- Redis, RabbitMQ or Kafka (hands-on Kubernetes is a plus, not required)")).toEqual({
      main: "Redis, RabbitMQ or Kafka",
      nice: "(hands-on Kubernetes is a plus, not required)",
    });
    expect(splitNiceToHave("- Advanced Excel required, SQL or Python is an advantage")).toEqual({
      main: "Advanced Excel required",
      nice: "SQL or Python is an advantage",
    });
    // Commas list what is a plus, so they do not end the clause.
    expect(splitNiceToHave("- Experience with cloud platforms (AWS, GCP, or Azure) is a plus.").nice).toBe(
      "- Experience with cloud platforms (AWS, GCP, or Azure) is a plus.",
    );
  });

  test("words that only look like a label stay main", () => {
    // "Ideally" opens a section only as a label with a colon; a bullet that starts with it is not a heading.
    const text = "Ideally located on the West Coast\n- Ideally can commit 20 hours\n- Python";
    expect(splitNiceToHave(text).nice).toBe("");
  });

  test("no nice-to-have text: everything is main", () => {
    expect(splitNiceToHave("Requirements\n- Go\n- AWS").nice).toBe("");
  });
});

describe("readJobSkills", () => {
  const title = "Senior Backend Engineer";

  test("a skill only in nice-to-have text is nice; one also named elsewhere is required", () => {
    const description =
      "Requirements\n- Node.js and PostgreSQL\n- Docker\n\nNice to have\n- Kafka\n- Docker in production";
    expect(readJobSkills({ title, description })).toEqual({
      skills: ["Node.js", "PostgreSQL", "Kafka", "Docker"],
      nice: ["Kafka"],
    });
  });

  test("the title counts as main text", () => {
    expect(readJobSkills({ title: "Go Engineer", description: "Nice to have\n- Go\n- Rust" }).nice).toEqual(["Rust"]);
  });

  test("no nice-to-have text: no nice skills", () => {
    expect(readJobSkills({ title, description: "- Node.js\n- Kafka" })).toEqual({
      skills: ["Node.js", "Kafka"],
      nice: [],
    });
  });

  test("the user's own skills are read the same way", () => {
    const dict = compileSkills(["Payroll"]);
    expect(readJobSkills({ title, description: "- Go\nBonus points:\n- Payroll systems" }, dict).nice).toEqual([
      "Payroll",
    ]);
  });
});
