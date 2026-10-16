import { describe, expect, test } from "bun:test";
import { applyUrlKey, companyKey, titleKey } from "./dedup";

describe("titleKey", () => {
  test("seniority abbreviations, parentheticals, punctuation and order do not matter", () => {
    expect(titleKey("Sr. Frontend Engineer (Remote)")).toBe("engineer frontend senior");
    expect(titleKey("Frontend Engineer, Senior")).toBe("engineer frontend senior");
    expect(titleKey("Jr Developer")).toBe("developer junior");
  });
});

describe("companyKey", () => {
  test("drops legal suffixes and punctuation", () => {
    expect(companyKey("Acme Inc.")).toBe("acme");
    expect(companyKey("ACME, LLC")).toBe("acme");
    expect(companyKey("Acme Ltd")).toBe("acme");
    expect(companyKey("Acme Corp")).toBe("acme");
    expect(companyKey("Acme Co.")).toBe("acme");
    expect(companyKey("Acme Cloud Co")).toBe("acme cloud");
  });
});

describe("applyUrlKey", () => {
  test("lowercases the host, drops tracking params, hash and trailing slash", () => {
    expect(applyUrlKey("https://Jobs.Lever.co/acme/123/?utm_source=x&ref=y&gh_src=1#apply")).toBe(
      "https://jobs.lever.co/acme/123?gh_src=1",
    );
    expect(applyUrlKey("https://jobs.lever.co/acme/123")).toBe("https://jobs.lever.co/acme/123");
  });
  test("keeps the path case and sorts the remaining params", () => {
    expect(applyUrlKey("https://x.com/Jobs/A?b=2&a=1")).toBe("https://x.com/Jobs/A?a=1&b=2");
  });
  test("returns null for non-http or invalid URLs", () => {
    expect(applyUrlKey("not a url")).toBeNull();
    expect(applyUrlKey("mailto:jobs@acme.com")).toBeNull();
  });
});
