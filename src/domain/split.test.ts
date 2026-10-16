import { describe, expect, test } from "bun:test";
import { splitFacts } from "./split";

describe("splitFacts", () => {
  test("bullets become one candidate each, without the bullet marker", () => {
    const text = [
      "- Built a payments API in Go serving 2M requests a day",
      "* Led a team of 4 engineers",
      "• Cut build time from 20 to 6 minutes",
      "1. Mentored two junior developers",
    ].join("\n");
    expect(splitFacts({ text })).toEqual([
      "Built a payments API in Go serving 2M requests a day",
      "Led a team of 4 engineers",
      "Cut build time from 20 to 6 minutes",
      "Mentored two junior developers",
    ]);
  });

  test("prose paragraphs split into sentences", () => {
    const text =
      "I am a backend engineer at Acme Corp. I moved our jobs to Postgres in 2022. Uptime went to 99.9% after that.";
    expect(splitFacts({ text })).toEqual([
      "I am a backend engineer at Acme Corp.",
      "I moved our jobs to Postgres in 2022.",
      "Uptime went to 99.9% after that.",
    ]);
  });

  test("drops all-caps headings and lines ending with a colon", () => {
    const text = "EXPERIENCE\nWork history:\n- Shipped the mobile app\n\nSKILLS\n- TypeScript, React, Postgres";
    expect(splitFacts({ text })).toEqual(["Shipped the mobile app", "TypeScript, React, Postgres"]);
  });

  test("keeps role lines with dates", () => {
    expect(splitFacts({ text: "Senior Engineer, Acme Corp, 2019 to 2023" })).toEqual([
      "Senior Engineer, Acme Corp, 2019 to 2023",
    ]);
  });

  test("removes duplicates after normalizing case and spacing", () => {
    const text = "- Led a team of 4\n-   led a TEAM of 4";
    expect(splitFacts({ text })).toEqual(["Led a team of 4"]);
  });

  test("handles CRLF and empty input", () => {
    expect(splitFacts({ text: "- One thing\r\n- Two things\r\n" })).toEqual(["One thing", "Two things"]);
    expect(splitFacts({ text: "  \n\n " })).toEqual([]);
  });

  test("every candidate is a substring of the source text (nothing invented)", () => {
    const text = "SUMMARY\nI build web apps. I like Postgres.\n- Built X for Y in 2021\n";
    for (const fact of splitFacts({ text })) {
      expect(text.includes(fact)).toBe(true);
    }
  });
});
