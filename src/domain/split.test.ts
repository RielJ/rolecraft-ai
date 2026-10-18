import { describe, expect, test } from "bun:test";
import { sectionIn, splitFacts, splitSections } from "./split";

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

describe("splitSections", () => {
  const cv = [
    "EXPERIENCE",
    "Acme Corp, Senior Engineer, 2019 to 2023",
    "- Built a payments API in Go",
    "- Led a team of 4 engineers",
    "",
    "Globex — Engineer",
    "- Cut build time from 20 to 6 minutes",
    "",
    "EDUCATION",
    "- BS Computer Science, 2015",
  ].join("\n");

  test("bullets sit under the short line above them, the rest under the latest heading", () => {
    expect(splitSections({ text: cv })).toEqual([
      { text: "Acme Corp, Senior Engineer, 2019 to 2023", section: "Acme Corp, Senior Engineer, 2019 to 2023" },
      { text: "Built a payments API in Go", section: "Acme Corp, Senior Engineer, 2019 to 2023" },
      { text: "Led a team of 4 engineers", section: "Acme Corp, Senior Engineer, 2019 to 2023" },
      { text: "Globex — Engineer", section: "Globex — Engineer" },
      { text: "Cut build time from 20 to 6 minutes", section: "Globex — Engineer" },
      { text: "BS Computer Science, 2015", section: "EDUCATION" },
    ]);
  });

  test("a sentence above bullets does not name them", () => {
    const text = "SUMMARY\nI build web apps.\n- Built X for Y in 2021";
    expect(splitSections({ text })).toEqual([
      { text: "I build web apps.", section: "SUMMARY" },
      { text: "Built X for Y in 2021", section: "SUMMARY" },
    ]);
  });

  test("text with no headings has no sections", () => {
    expect(splitSections({ text: "I moved our jobs to Postgres in 2022." })).toEqual([
      { text: "I moved our jobs to Postgres in 2022.", section: null },
    ]);
  });

  test("every section is a line of the source text", () => {
    for (const { section } of splitSections({ text: cv })) {
      if (section) expect(cv.split("\n")).toContain(section);
    }
  });
});

describe("sectionIn", () => {
  const evidence = "CASHFLOWY — Senior Engineer\nJanuary 2026 – June 2026\n- Led the design";

  test("keeps a label the text contains, ignoring case and punctuation", () => {
    expect(sectionIn({ section: "Cashflowy", evidence })).toBe("Cashflowy");
    expect(sectionIn({ section: " CASHFLOWY — Senior Engineer: ", evidence })).toBe("CASHFLOWY — Senior Engineer");
  });

  test("drops a label the text does not contain, or only contains part of a word of", () => {
    expect(sectionIn({ section: "Globex", evidence })).toBeNull();
    expect(sectionIn({ section: "Cash", evidence })).toBeNull();
    expect(sectionIn({ section: "", evidence })).toBeNull();
    expect(sectionIn({ section: null, evidence })).toBeNull();
    expect(sectionIn({ section: "x".repeat(121), evidence: "x".repeat(121) })).toBeNull();
  });
});
