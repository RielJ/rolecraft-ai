import { describe, expect, test } from "bun:test";
import { FactKey, OutputId } from "./api";
import {
  agoLabel,
  blockerLabel,
  fileStatusLabel,
  fillRatesSummary,
  fxAgeLabel,
  fxAgeLines,
  fxProvenanceLabel,
  matchSkillsLabel,
  outdatedLabel,
  RESUME_ONE_PAGE_WORDS,
  rateDayLabel,
  refreshedLabel,
  resumeLikelyLong,
} from "./labels";

const NOW = new Date("2026-10-18T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("agoLabel", () => {
  test("just now, minutes, hours, days", () => {
    expect(agoLabel({ at: new Date(NOW.getTime() + 5_000), now: NOW })).toBe("just now");
    expect(agoLabel({ at: new Date(NOW.getTime() - 60_000), now: NOW })).toBe("1 minute ago");
    expect(agoLabel({ at: hoursAgo(2), now: NOW })).toBe("2 hours ago");
    expect(agoLabel({ at: hoursAgo(49), now: NOW })).toBe("2 days ago");
  });

  test("refreshedLabel reads as before", () => {
    expect(refreshedLabel({ at: null, now: NOW })).toBe("Not refreshed yet");
    expect(refreshedLabel({ at: NOW, now: NOW })).toBe("Refreshed just now");
    expect(refreshedLabel({ at: hoursAgo(2), now: NOW })).toBe("Refreshed 2 hours ago");
    expect(refreshedLabel({ at: hoursAgo(24), now: NOW })).toBe("Refreshed 1 day ago");
  });
});

describe("exchange-rate labels (decision 67)", () => {
  test("a rate date is a calendar day, never shifted by the time zone", () => {
    expect(rateDayLabel("2026-10-16")).toBe("16 Oct");
    expect(rateDayLabel("2026-01-01")).toBe("1 Jan");
  });

  test("the age line names the source, its rate date and the fetch", () => {
    expect(fxAgeLabel({ by: "ecb", rateDate: "2026-10-16", fetchedAt: hoursAgo(2), now: NOW })).toBe(
      "ECB rates of 16 Oct · fetched 2 hours ago",
    );
    expect(fxAgeLabel({ by: "currency-api", rateDate: "2026-10-18", fetchedAt: NOW, now: NOW })).toBe(
      "currency-api rates of 18 Oct · fetched just now",
    );
  });

  test("provenance", () => {
    expect(fxProvenanceLabel("ecb")).toBe("ECB");
    expect(fxProvenanceLabel("currency-api")).toBe("currency-api");
    expect(fxProvenanceLabel("user")).toBe("Set by you");
  });

  test("one line per fetched source, ECB first, from its newest fetch", () => {
    const lines = fxAgeLines({
      now: NOW,
      rates: [
        { by: "currency-api", setAt: hoursAgo(1).toISOString(), rateDate: "2026-10-18" },
        { by: "ecb", setAt: hoursAgo(30).toISOString(), rateDate: "2026-10-15" },
        { by: "ecb", setAt: hoursAgo(2).toISOString(), rateDate: "2026-10-16" },
        { by: "user", setAt: NOW.toISOString(), rateDate: null },
      ],
    });
    expect(lines.map((l) => l.text)).toEqual([
      "ECB rates of 16 Oct · fetched 2 hours ago",
      "currency-api rates of 18 Oct · fetched 1 hour ago",
    ]);
    expect(lines[0]).toMatchObject({ rateDate: "2026-10-16", fetchedAt: hoursAgo(2).toISOString() });
  });

  test("no line when every rate is the user's", () => {
    expect(fxAgeLines({ now: NOW, rates: [{ by: "user", setAt: NOW.toISOString(), rateDate: null }] })).toEqual([]);
    expect(fxAgeLines({ now: NOW, rates: [] })).toEqual([]);
  });
});

describe("fillRatesSummary", () => {
  const none = { filled: [], kept: [], unsupported: [], unavailable: [], viewChanged: false };
  test("filled, unsupported and unavailable", () => {
    expect(
      fillRatesSummary({
        ...none,
        filled: [
          { currency: "USD", rate: 62.9681, by: "ecb" },
          { currency: "EUR", rate: 70.858, by: "ecb" },
        ],
        unsupported: ["XTS"],
        unavailable: ["VND"],
      }),
    ).toBe("Filled 2 rates. No source publishes XTS. Could not get VND; try again later.");
    expect(fillRatesSummary({ ...none, filled: [{ currency: "USD", rate: 62.9681, by: "ecb" }] })).toBe(
      "Filled 1 rate.",
    );
  });

  test("nothing to do, and a view change", () => {
    expect(fillRatesSummary({ ...none, kept: ["USD"] })).toBe("Every rate is already set.");
    expect(fillRatesSummary({ ...none, viewChanged: true })).toBe(
      "Your view currency changed while filling, so nothing was saved. Fill again.",
    );
  });
});

describe("fileStatusLabel", () => {
  const at = hoursAgo(2).toISOString();

  test("a draft: when, words and blanks", () => {
    expect(fileStatusLabel({ generatedAt: at, editedAt: null, words: 290, blanks: 2, now: NOW })).toBe(
      "Drafted 2 hours ago · 290 words · 2 blanks",
    );
  });

  test("an edit newer than the draft names the edit; no blanks, no blank count", () => {
    expect(
      fileStatusLabel({ generatedAt: hoursAgo(5).toISOString(), editedAt: at, words: 300, blanks: 0, now: NOW }),
    ).toBe("Edited 2 hours ago · 300 words");
  });

  test("written by hand with no draft", () => {
    expect(fileStatusLabel({ generatedAt: null, editedAt: at, words: 1, blanks: 1, now: NOW })).toBe(
      "Edited 2 hours ago · 1 word · 1 blank",
    );
  });
});

describe("resumeLikelyLong", () => {
  test("warns only past the one-page estimate", () => {
    expect(resumeLikelyLong(RESUME_ONE_PAGE_WORDS)).toBe(false);
    expect(resumeLikelyLong(RESUME_ONE_PAGE_WORDS + 1)).toBe(true);
  });
});

describe("labels name no fact keys", () => {
  test("outdated changes", () => {
    for (const reason of ["edited", "deleted", "unconfirmed", "letters_only"] as const) {
      expect(outdatedLabel(reason)).not.toMatch(/FACT/);
    }
    expect(outdatedLabel("deleted")).toBe("A fact this used was deleted");
  });

  test("placeholder blockers name the blank without its brackets", () => {
    const outputId = OutputId.parse("00000000-0000-4000-8000-000000000000");
    expect(blockerLabel({ kind: "placeholder", outputId, text: "Employer for the 2019 role" })).toBe(
      "Fill in: Employer for the 2019 role",
    );
    expect(
      blockerLabel({
        kind: "placeholder",
        outputId,
        text: 'Check this: "I led a team of 40" is not backed by your facts',
      }),
    ).toBe('Check a sentence your facts don\'t back: "I led a team of 40"');
  });

  test("a deleted-fact blocker", () => {
    const label = blockerLabel({
      kind: "deleted_fact",
      outputId: OutputId.parse("00000000-0000-4000-8000-000000000000"),
      factKey: FactKey.parse("FACT-3"),
    });
    expect(label).not.toMatch(/FACT/);
  });
});

describe("matchSkillsLabel (decision 76)", () => {
  const label = (matched: number, asked: number, nice = { matched: 0, asked: 0 }) =>
    matchSkillsLabel({ matched, asked, nice });

  test("a percentage from three skills up; the count below that", () => {
    expect(label(7, 8)).toEqual({ short: "88% skills", full: "7 of 8 skills" });
    expect(label(0, 3)).toEqual({ short: "0% skills", full: "0 of 3 skills" });
    expect(label(1, 2)).toEqual({ short: "1 of 2 skills", full: "1 of 2 skills" });
  });

  test("with nice-to-have skills the percentage is of the required ones", () => {
    expect(label(11, 12, { matched: 2, asked: 5 })).toEqual({
      short: "92% required skills",
      full: "11 of 12 required skills · 2 of 5 nice-to-have",
    });
  });

  test("no skills named: nothing", () => {
    expect(label(0, 0)).toBeNull();
  });
});
