import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readPage } from "./page-reader";

const page = (name: string) => Bun.file(join(import.meta.dir, "../../../test/fixtures/pages", name)).text();

describe("readPage", () => {
  test("prefers a JSON-LD JobPosting, even inside @graph with an entity-escaped description", async () => {
    const read = readPage({ html: await page("json-ld.html") });
    expect(read).toMatchObject({
      via: "json-ld",
      title: "Senior Backend Engineer",
      company: "Acme Inc",
      locationText: "Remote",
      postedAt: new Date("2026-07-01"),
      expiresAt: new Date("2026-08-31T23:59:59Z"),
      pay: { min: 60000, max: 80000, currency: "USD", period: "year", phrase: "$60,000–$80,000 a year" },
      restrictions: ["Philippines"],
    });
    expect(read.description).toContain("- Design and run Go services on PostgreSQL and Kafka.");
    expect(read.description).toContain("Pay is $60k–$80k/yr depending on experience.");
    expect(read.description).not.toContain("<");
    expect(read.description.length).toBeGreaterThan(600);
  });

  test("falls back to Readability for pages without JSON-LD", async () => {
    const read = readPage({ html: await page("readability.html") });
    expect(read).toMatchObject({ via: "readability", title: "Frontend Developer", company: "Globex", pay: null });
    expect(read.description).toContain("You will build features in React and TypeScript");
    expect(read.description).toContain("- 3+ years of experience shipping React apps to production.");
    expect(read.description).not.toContain("All rights reserved");
    expect(read.description.length).toBeGreaterThan(600);
  });

  test("a thin page keeps the title and company it found", async () => {
    const read = readPage({ html: await page("thin.html") });
    expect(read.title).toBe("Data Analyst");
    expect(read.company).toBe("Initech");
    expect(read.description.length).toBeLessThan(600);
  });

  test("broken JSON-LD and markup never throw", () => {
    const read = readPage({ html: '<script type="application/ld+json">{oops</script><p>Hi' });
    expect(read.via).toBe("readability");
    expect(read.title).toBeNull();
  });
});
