import { describe, expect, test } from "bun:test";
import {
  agoLabel,
  fillRatesSummary,
  fxAgeLabel,
  fxAgeLines,
  fxProvenanceLabel,
  rateDayLabel,
  refreshedLabel,
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
