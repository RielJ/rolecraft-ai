import { describe, expect, test } from "bun:test";
import { BANNED_PHRASES, checkStyle, MAX_SENTENCE_WORDS, styleHitLabel, VOICE_RULES } from "./style";

describe("checkStyle", () => {
  test("flags every phrase on the banned list", () => {
    for (const phrase of BANNED_PHRASES) {
      const hits = checkStyle(`Here is a line with ${phrase} in it.`);
      expect(hits.some((h) => h.rule === "banned_phrase")).toBe(true);
    }
  });

  test("catches word endings and any case", () => {
    const hits = checkStyle("I am passionate about leveraging Go. Leveraged it daily.");
    expect(hits.map((h) => h.phrase)).toEqual(["passionate about", "leveraging", "Leveraged"]);
    expect(hits.every((h) => h.rule === "banned_phrase")).toBe(true);
  });

  test("names the sentence each hit is in", () => {
    const hits = checkStyle("I built the API [FACT-1]. It was a dynamic place [FACT-2].");
    expect(hits).toEqual([{ sentence: "It was a dynamic place [FACT-2].", phrase: "dynamic", rule: "banned_phrase" }]);
  });

  test("an em dash is punctuation; a spaced en dash is too; a range is not", () => {
    expect(checkStyle("I shipped it — fast.").map((h) => h.rule)).toEqual(["dash"]);
    expect(checkStyle("I shipped it – fast.").map((h) => h.rule)).toEqual(["dash"]);
    expect(checkStyle("Acme, 2019–2021.")).toEqual([]);
    expect(checkStyle("A well-known tool.")).toEqual([]);
  });

  test("flags three stacked adjectives", () => {
    const hits = checkStyle("I write reliable, scalable, and maintainable services.");
    expect(hits.map((h) => h.rule)).toEqual(["adjective_triplet"]);
  });

  test(`flags a sentence over ${MAX_SENTENCE_WORDS} words, and markers do not count as words`, () => {
    const long = `${Array.from({ length: MAX_SENTENCE_WORDS + 1 }, () => "word").join(" ")}.`;
    expect(checkStyle(long).map((h) => h.rule)).toEqual(["long_sentence"]);
    const ok = `${Array.from({ length: MAX_SENTENCE_WORDS }, () => "word").join(" ")} [FACT-1][FACT-2].`;
    expect(checkStyle(ok)).toEqual([]);
  });

  test("plain writing has no hits", () => {
    const body = "# Summary\nI build payment APIs in Go [FACT-1].\n## Experience\n- Led a team of four [FACT-2]";
    expect(checkStyle(body)).toEqual([]);
  });

  test("placeholders are not read as tells", () => {
    expect(checkStyle("I led [[dynamic team size]] people [FACT-1].")).toEqual([]);
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
