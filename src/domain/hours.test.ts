import { describe, expect, test } from "bun:test";
import { offsetMinutes, parseHours, toManila } from "./hours";

const JANUARY = new Date("2026-01-15T00:00:00Z");
const JULY = new Date("2026-07-15T00:00:00Z");

describe("parseHours", () => {
  test("a range with am/pm and a zone abbreviation", () => {
    expect(parseHours("Core hours are 9am to 5pm ET, Monday to Friday.")).toEqual({
      phrase: "9am to 5pm ET",
      tz: "America/New_York",
      start: "09:00",
      end: "17:00",
    });
  });
  test("24-hour clocks and zone names", () => {
    expect(parseHours("Shift: 09:00-17:30 CET")).toMatchObject({ tz: "Europe/Berlin", start: "09:00", end: "17:30" });
    expect(parseHours("Work 8:30 AM – 5:30 PM Pacific Time")).toMatchObject({
      tz: "America/Los_Angeles",
      start: "08:30",
      end: "17:30",
    });
  });
  test("one am/pm on the end applies to both ends when it fits", () => {
    expect(parseHours("1 - 5pm EST")).toMatchObject({ start: "13:00", end: "17:00" });
    expect(parseHours("9 to 5pm EST")).toMatchObject({ start: "09:00", end: "17:00" });
  });
  test("an overlap requirement", () => {
    expect(parseHours("You need at least 4 hours of overlap with PST.")).toEqual({
      phrase: "4 hours of overlap with PST",
      tz: "America/Los_Angeles",
      overlapHours: 4,
    });
    expect(parseHours("Overlap of 3 hours with US Eastern is required.")).toMatchObject({
      tz: "America/New_York",
      overlapHours: 3,
    });
  });
  test("no stated hours gives null; lowercase 'et' is not a zone", () => {
    expect(parseHours("We are flexible about hours.")).toBeNull();
    expect(parseHours("From 9 to 5 et cetera")).toBeNull();
  });
});

describe("offsetMinutes", () => {
  test("US zones follow DST on the date; Manila is always +8", () => {
    expect(offsetMinutes({ tz: "America/New_York", instant: JANUARY })).toBe(-300);
    expect(offsetMinutes({ tz: "America/New_York", instant: JULY })).toBe(-240);
    expect(offsetMinutes({ tz: "Asia/Manila", instant: JULY })).toBe(480);
  });
});

describe("toManila", () => {
  const nineToFive = { phrase: "9am to 5pm ET", tz: "America/New_York", start: "09:00", end: "17:00" };

  test("9am to 5pm ET on a January date (EST) is 10:00 PM to 6:00 AM PHT", () => {
    expect(toManila({ hours: nineToFive, on: JANUARY })).toBe("10:00 PM to 6:00 AM PHT");
  });
  test("9am to 5pm ET on a July date (EDT) is 9:00 PM to 5:00 AM PHT", () => {
    expect(toManila({ hours: nineToFive, on: JULY })).toBe("9:00 PM to 5:00 AM PHT");
  });
  test("the DST switch dates use the offset of that day", () => {
    // US DST began 2026-03-08 at 2:00 AM local. The day before is EST, the day after EDT.
    expect(toManila({ hours: nineToFive, on: new Date("2026-03-07T17:00:00Z") })).toBe("10:00 PM to 6:00 AM PHT");
    expect(toManila({ hours: nineToFive, on: new Date("2026-03-09T17:00:00Z") })).toBe("9:00 PM to 5:00 AM PHT");
  });
  test("hours already in Manila time stay as they are", () => {
    expect(toManila({ hours: { phrase: "", tz: "Asia/Manila", start: "08:00", end: "17:00" }, on: JULY })).toBe(
      "8:00 AM to 5:00 PM PHT",
    );
  });
  test("an overlap shows the zone's working day in PHT", () => {
    expect(toManila({ hours: { phrase: "", tz: "America/Los_Angeles", overlapHours: 4 }, on: JANUARY })).toBe(
      "4 hours of overlap with PT; their 9:00 AM to 5:00 PM is 1:00 AM to 9:00 AM PHT",
    );
  });
});
