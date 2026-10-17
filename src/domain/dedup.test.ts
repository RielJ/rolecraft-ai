import { describe, expect, test } from "bun:test";
import {
  applyUrlKey,
  companyKey,
  type DuplicateCandidate,
  duplicateDiff,
  isAutoMerge,
  likelyDuplicates,
  titleKey,
} from "./dedup";
import { descriptionKey } from "./text";

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

describe("isAutoMerge (decision 46)", () => {
  const base = {
    titleKey: titleKey("Software Engineer"),
    companyKey: companyKey("Acme Inc"),
    applyUrlKey: null,
    descriptionKey: descriptionKey("Build payment APIs in Go."),
    seenAt: new Date("2026-03-01T00:00:00Z"),
  };
  test("the same company, title and description within 28 days merge", () => {
    expect(isAutoMerge({ a: base, b: { ...base, seenAt: new Date("2026-03-29T00:00:00Z") } })).toBe(true);
  });
  test("past 28 days, or with a different description, they stay apart", () => {
    expect(isAutoMerge({ a: base, b: { ...base, seenAt: new Date("2026-03-30T00:00:01Z") } })).toBe(false);
    expect(isAutoMerge({ a: base, b: { ...base, descriptionKey: descriptionKey("Build UIs in React.") } })).toBe(false);
  });
  test("the same apply URL and title merge at any date; a different title never does", () => {
    const url = { ...base, applyUrlKey: "https://jobs.lever.co/acme/1" };
    const later = { ...url, descriptionKey: "x", seenAt: new Date("2027-01-01T00:00:00Z") };
    expect(isAutoMerge({ a: url, b: later })).toBe(true);
    expect(isAutoMerge({ a: url, b: { ...url, titleKey: titleKey("Designer") } })).toBe(false);
  });
});

function candidate(overrides: Partial<DuplicateCandidate> & { id: string; title: string }): DuplicateCandidate {
  const { title, ...rest } = overrides;
  return {
    titleKey: titleKey(title),
    companyKey: companyKey("Acme Inc"),
    description: "We build payment APIs in Go for banks across Asia and need help scaling them.",
    locationText: "Remote",
    payPhrase: null,
    skills: ["Go"],
    minYears: null,
    closedAt: null,
    ...rest,
  };
}

describe("likelyDuplicates (section 3.8)", () => {
  const job = candidate({ id: "a", title: "Software Engineer" });

  test("same company with title token Jaccard >= 0.5", () => {
    const same = candidate({ id: "b", title: "Software Engineer", description: "Totally different text about UIs." });
    const close = candidate({ id: "c", title: "Senior Software Engineer" }); // 2 of 3 tokens
    const far = candidate({ id: "d", title: "Product Designer" });
    expect(likelyDuplicates({ job, candidates: [same, close, far] }).map((c) => c.id)).toEqual(["b", "c"]);
  });

  test("same title at another company only when descriptions are >= 0.8 similar", () => {
    const copied = candidate({ id: "b", title: "Software Engineer", companyKey: "acme recruiting" });
    const different = candidate({
      id: "c",
      title: "Software Engineer",
      companyKey: "globex",
      description: "Globex hires engineers to maintain a large Java monolith for insurance clients.",
    });
    expect(likelyDuplicates({ job, candidates: [copied, different] }).map((c) => c.id)).toEqual(["b"]);
  });

  test("slice 9: 'Sr. Frontend Engineer (Remote)' at 'Acme Inc' and 'Frontend Engineer, Senior' at 'Acme' are suggested", () => {
    const sr: DuplicateCandidate = {
      ...candidate({ id: "sr", title: "Sr. Frontend Engineer (Remote)" }),
      companyKey: companyKey("Acme Inc"),
      description: "Build our design system in React and TypeScript.",
    };
    const senior: DuplicateCandidate = {
      ...candidate({ id: "senior", title: "Frontend Engineer, Senior" }),
      companyKey: companyKey("Acme"),
      description: "Own the checkout UI. Vue experience is a plus. Work hours overlap with Manila.",
    };
    expect(likelyDuplicates({ job: sr, candidates: [senior] }).map((c) => c.id)).toEqual(["senior"]);
    expect(likelyDuplicates({ job: senior, candidates: [sr] }).map((c) => c.id)).toEqual(["sr"]);
  });

  test("the job itself and closed jobs are left out", () => {
    const closed = candidate({ id: "b", title: "Software Engineer", closedAt: new Date("2026-01-01T00:00:00Z") });
    expect(likelyDuplicates({ job, candidates: [job, closed] })).toEqual([]);
  });
});

describe("duplicateDiff", () => {
  test("names the requirements, location and pay that differ, one line per job", () => {
    const a = candidate({
      id: "a",
      title: "Software Engineer",
      skills: ["Go", "Kafka"],
      minYears: 5,
      locationText: "Remote (US only)",
      payPhrase: "$120k–$150k/yr",
    });
    const b = candidate({ id: "b", title: "Software Engineer", skills: ["Go", "React"], minYears: 2 });
    expect(duplicateDiff({ job: a, other: b })).toEqual({
      job: "Asks for 5+ years, Kafka · Remote (US only) · $120k–$150k/yr",
      other: "Asks for 2+ years, React · Remote · Pay not stated",
    });
  });

  test("with the same requirements, location and pay, it quotes the first sentence that differs", () => {
    const a = candidate({ id: "a", title: "Software Engineer", description: "Join payments. You own the ledger." });
    const b = candidate({ id: "b", title: "Software Engineer", description: "Join payments. You own onboarding." });
    expect(duplicateDiff({ job: a, other: b })).toEqual({ job: "You own the ledger.", other: "You own onboarding." });
    expect(duplicateDiff({ job: a, other: a })).toEqual({
      job: "Same requirements, location and pay",
      other: "Same requirements, location and pay",
    });
  });
});
