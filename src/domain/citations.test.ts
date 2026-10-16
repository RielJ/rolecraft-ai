import { describe, expect, test } from "bun:test";
import { factKey, findPlaceholders, parseCitations, stripMarkers } from "./citations";

describe("factKey", () => {
  test("formats the identity number", () => {
    expect(String(factKey(12))).toBe("FACT-12");
  });
});

describe("parseCitations", () => {
  test("returns distinct keys in order of first use", () => {
    const body = "I built the API [FACT-3]. I led a team [FACT-1][FACT-3]. Again [FACT-1].";
    expect(parseCitations(body).map(String)).toEqual(["FACT-3", "FACT-1"]);
  });

  test("ignores malformed markers and placeholders", () => {
    expect(parseCitations("[FACT-0] [FACT-x] [fact-2] [[FACT-4]] [FACT- 5]").map(String)).toEqual([]);
  });

  test("empty body has no citations", () => {
    expect(parseCitations("").map(String)).toEqual([]);
  });
});

describe("findPlaceholders", () => {
  test("finds every [[...]] with its inner text", () => {
    expect(findPlaceholders("Led [[team size]] people for [[years]]. Done [FACT-1].")).toEqual(["team size", "years"]);
  });

  test("an empty placeholder still counts", () => {
    expect(findPlaceholders("x [[]] y")).toEqual([""]);
  });

  test("single brackets are not placeholders", () => {
    expect(findPlaceholders("I wrote [FACT-1] and [a note]")).toEqual([]);
  });
});

describe("stripMarkers", () => {
  test("removes markers and the space before them", () => {
    expect(stripMarkers("I built the API [FACT-3]. I led a team [FACT-1] [FACT-2].")).toBe(
      "I built the API. I led a team.",
    );
  });

  test("keeps line structure", () => {
    expect(stripMarkers("# Jane\n- Shipped X [FACT-1]\n- Fixed Y [FACT-2]\n")).toBe("# Jane\n- Shipped X\n- Fixed Y\n");
  });

  test("leaves text without markers alone", () => {
    expect(stripMarkers("Plain text, nothing cited.")).toBe("Plain text, nothing cited.");
  });
});
