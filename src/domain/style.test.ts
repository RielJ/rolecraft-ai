import { describe, expect, test } from "bun:test";
import { BANNED_PHRASES, checkStyle, MAX_SENTENCE_WORDS, styleHitLabel, VOICE_RULES } from "./style";

const letterStyle = (body: string) => checkStyle({ body, kind: "letter" });

describe("checkStyle", () => {
  test("flags every phrase on the banned list", () => {
    for (const phrase of BANNED_PHRASES) {
      const hits = letterStyle(`Here is a line with ${phrase} in it.`);
      expect(hits.some((h) => h.rule === "banned_phrase")).toBe(true);
    }
  });

  test("a role header's date range is not a dash", () => {
    expect(
      letterStyle("### Engineer | Cashflowy, Remote | Jan, 2026 – Jun, 2026\n- Built it — fast [FACT-1]."),
    ).toEqual([{ sentence: "Built it — fast [FACT-1].", phrase: "—", rule: "dash" }]);
  });

  test("catches word endings and any case", () => {
    const hits = letterStyle("I am passionate about leveraging Go. Leveraged it daily.");
    expect(hits.map((h) => h.phrase)).toEqual(["passionate about", "leveraging", "Leveraged"]);
    expect(hits.every((h) => h.rule === "banned_phrase")).toBe(true);
  });

  test("names the sentence each hit is in", () => {
    const hits = letterStyle("I built the API [FACT-1]. It was a dynamic place [FACT-2].");
    expect(hits).toEqual([{ sentence: "It was a dynamic place [FACT-2].", phrase: "dynamic", rule: "banned_phrase" }]);
  });

  test("an em dash is punctuation; a spaced en dash is too; a range is not", () => {
    expect(letterStyle("I shipped it — fast.").map((h) => h.rule)).toEqual(["dash"]);
    expect(letterStyle("I shipped it – fast.").map((h) => h.rule)).toEqual(["dash"]);
    expect(letterStyle("Acme, 2019–2021.")).toEqual([]);
    expect(letterStyle("A well-known tool.")).toEqual([]);
  });

  test("flags three stacked adjectives", () => {
    const hits = letterStyle("I write reliable, scalable, and maintainable services.");
    expect(hits.map((h) => h.rule)).toEqual(["adjective_triplet"]);
  });

  test(`flags a sentence over ${MAX_SENTENCE_WORDS} words, and markers do not count as words`, () => {
    const long = `${Array.from({ length: MAX_SENTENCE_WORDS + 1 }, () => "word").join(" ")}.`;
    expect(letterStyle(long).map((h) => h.rule)).toEqual(["long_sentence"]);
    const ok = `${Array.from({ length: MAX_SENTENCE_WORDS }, () => "word").join(" ")} [FACT-1][FACT-2].`;
    expect(letterStyle(ok)).toEqual([]);
  });

  test("plain writing has no hits", () => {
    const body = "# Summary\nI build payment APIs in Go [FACT-1].\n## Experience\n- Led a team of four [FACT-2]";
    expect(letterStyle(body)).toEqual([]);
  });

  test("placeholders are not read as tells", () => {
    expect(letterStyle("I led [[dynamic team size]] people [FACT-1].")).toEqual([]);
  });
});

describe("VOICE_RULES", () => {
  test("names every banned phrase", () => {
    const text = VOICE_RULES.join("\n");
    for (const phrase of BANNED_PHRASES) expect(text).toContain(`"${phrase}"`);
  });
});

describe("styleHitLabel", () => {
  test("names the phrase", () => {
    expect(styleHitLabel({ rule: "banned_phrase", phrase: "leverage" })).toContain('"leverage"');
  });
});

describe("pronoun (resumes only)", () => {
  const resume = (body: string) => checkStyle({ body, kind: "resume" }).filter((h) => h.rule === "pronoun");

  test("flags I, my, we and our in a resume, with the word found", () => {
    expect(resume("- I built the payments API [FACT-1].").map((h) => h.phrase)).toEqual(["I"]);
    expect(resume("- Built my team's API [FACT-1].").map((h) => h.phrase)).toEqual(["my"]);
    expect(resume("- We shipped it [FACT-1].").map((h) => h.phrase)).toEqual(["We"]);
    expect(resume("Engineer who owned our billing [FACT-1].").map((h) => h.phrase)).toEqual(["our"]);
    expect(resume("- I've led migrations [FACT-1].").map((h) => h.phrase)).toEqual(["I've"]);
  });

  test("never flags I/O, the US, or words that contain a pronoun", () => {
    expect(resume("- Cut I/O waits for US customers in Mexico [FACT-1].")).toEqual([]);
    expect(resume("- Built a museum app and ourselves-free tooling [FACT-1].")).toEqual([]);
  });

  test("a letter keeps its first person", () => {
    expect(checkStyle({ body: "I built the payments API [FACT-1].", kind: "letter" })).toEqual([]);
  });
});

describe("repeated_opener", () => {
  const openers = (body: string, kind: "resume" | "letter" = "resume") =>
    checkStyle({ body, kind })
      .filter((h) => h.rule === "repeated_opener")
      .map((h) => h.sentence);

  test("a third bullet with the same opener under one heading is flagged, not the first two", () => {
    const body = [
      "### Engineer | Acme | Jan, 2024 – Present",
      "- Built the API [FACT-1].",
      "- Built the queue [FACT-2].",
      "- Built the dashboard [FACT-3].",
      "- Migrated the database [FACT-4].",
    ].join("\n");
    expect(openers(body)).toEqual(["Built the dashboard [FACT-3]."]);
  });

  test("the count restarts under each heading, until one verb opens more than a quarter of all bullets", () => {
    const role = (n: number) => [
      `### Role ${n} | Acme`,
      `- Built thing ${n} [FACT-${n}].`,
      `- Cut cost ${n} [FACT-${n}].`,
    ];
    const body = [1, 2, 3, 4].flatMap(role).join("\n");
    // 8 bullets: "built" and "cut" may each open max(3, 8/4 = 2) = 3, so the fourth of each is flagged.
    expect(openers(body)).toEqual(["Built thing 4 [FACT-4].", "Cut cost 4 [FACT-4]."]);
  });

  test("labelled bullets (skills, project titles) and pronoun openers are not openers", () => {
    const skills = ["## Skills", "- **Languages:** Go, Rust", "- **Languages:** Go", "- **Languages:** Go"].join("\n");
    expect(openers(skills)).toEqual([]);
    const pronouns = ["- I built a [FACT-1].", "- I built b [FACT-2].", "- I built c [FACT-3]."].join("\n");
    expect(openers(pronouns)).toEqual([]);
  });

  test("applies to bullets in any kind, never to plain sentences", () => {
    const bullets = ["- Built a [FACT-1].", "- Built b [FACT-2].", "- Built c [FACT-3]."].join("\n");
    expect(openers(bullets, "letter")).toEqual(["Built c [FACT-3]."]);
    expect(openers("I built a. I built b. I built c. I built d.", "letter")).toEqual([]);
  });
});

describe("same_shape", () => {
  const shaped = (lines: string[]) =>
    checkStyle({ body: lines.join("\n"), kind: "resume" })
      .filter((h) => h.rule === "same_shape")
      .map((h) => h.phrase);

  test("past half of the bullets, a trailing -ing clause is flagged", () => {
    expect(
      shaped([
        "- Rewrote queries, cutting load time by half [FACT-1].",
        "- Moved builds to Docker, reducing build time [FACT-2].",
        "- Added rollback, improving uptime [FACT-3].",
        "- Mentored three engineers [FACT-4].",
      ]),
    ).toEqual(["improving"]);
  });

  test("half or fewer is fine, and scope words like including or using never count", () => {
    expect(
      shaped([
        "- Rewrote queries, cutting load time [FACT-1].",
        "- Moved builds to Docker, reducing build time [FACT-2].",
        "- Built the API [FACT-3].",
        "- Shipped integrations, including Stripe [FACT-4].",
      ]),
    ).toEqual([]);
  });
});
