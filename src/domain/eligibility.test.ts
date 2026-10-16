import { describe, expect, test } from "bun:test";
import { classifyEligibility, ELIGIBILITY_RULES } from "./eligibility";

const classify = (description: string, locationText = "", structured: { restrictions: string[] } | null = null) =>
  classifyEligibility({ description, locationText, structured });

describe("classifyEligibility: one fixture per rule (section 3.6)", () => {
  test("rule 1: the Philippines named in a negative -> excluded", () => {
    expect(classify("We hire remotely in Asia, excluding India and the Philippines.")).toEqual({
      verdict: "excluded",
      phrase: "We hire remotely in Asia, excluding India and the Philippines.",
    });
  });

  test("rule 2: the Philippines named positively -> ph", () => {
    expect(classify("About us. We hire in the Philippines and Vietnam.")).toEqual({
      verdict: "ph",
      phrase: "We hire in the Philippines and Vietnam.",
    });
    expect(classify("Office in Makati.", "Manila, NCR").verdict).toBe("ph");
  });

  test("rule 3: a country lock without the Philippines -> excluded", () => {
    expect(classify("Join our platform team.", "Remote (US only)")).toEqual({
      verdict: "excluded",
      phrase: "Remote (US only)",
    });
    expect(classify("You must reside in the United States.").verdict).toBe("excluded");
    expect(classify("Candidates must be authorized to work in the UK.").verdict).toBe("excluded");
    expect(classify("This role requires an active security clearance.").verdict).toBe("excluded");
    expect(classify("Open to US citizens.").verdict).toBe("excluded");
  });

  test("rule 4: APAC -> apac", () => {
    expect(classify("Remote across Asia-Pacific. Hours follow GMT+8.")).toEqual({
      verdict: "apac",
      phrase: "Remote across Asia-Pacific.",
    });
    expect(classify("Must overlap with UTC+8 business hours.").verdict).toBe("apac");
  });

  test("rule 5: Americas -> americas", () => {
    expect(classify("Remote within North America.").verdict).toBe("americas");
    expect(classify("You will work EST hours.").verdict).toBe("americas");
    expect(classify("4 hours of overlap with US time zones.").verdict).toBe("americas");
  });

  test("rule 6: worldwide -> worldwide", () => {
    expect(classify("We are a fully remote team. Work from anywhere!")).toEqual({
      verdict: "worldwide",
      phrase: "Work from anywhere!",
    });
  });

  test("rule 7: structured restrictions", () => {
    expect(classify("A remote role.", "", { restrictions: [] })).toEqual({
      verdict: "worldwide",
      phrase: "Location: Anywhere",
    });
    expect(classify("A remote role.", "", { restrictions: ["United States", "Canada"] })).toEqual({
      verdict: "excluded",
      phrase: "Hiring in: United States, Canada",
    });
    expect(classify("A remote role.", "", { restrictions: ["Philippines", "Singapore"] }).verdict).toBe("ph");
  });

  test("rule 8: nothing said -> unclear, with no phrase", () => {
    expect(classify("Build payment APIs in Go.")).toEqual({ verdict: "unclear", phrase: null });
  });

  test("the rule table has the six text rules in order", () => {
    expect(ELIGIBILITY_RULES.map((r) => r.verdict)).toEqual([
      "excluded",
      "ph",
      "excluded",
      "apac",
      "americas",
      "worldwide",
    ]);
  });
});

describe("classifyEligibility: ordering and boundaries", () => {
  test("an exclusion beats a region named earlier in the posting", () => {
    expect(classify("We are remote across APAC. Must live in Canada.").verdict).toBe("excluded");
  });
  test("ordinary lowercase words are not regions: us, sea, est", () => {
    expect(classify("Email us only if you love the sea. Est. 2019.")).toEqual({ verdict: "unclear", phrase: null });
  });
  test("text beats structured data", () => {
    expect(classify("Remote (US only)", "", { restrictions: [] }).verdict).toBe("excluded");
  });
  test("a long sentence is trimmed to about 160 characters around the match", () => {
    const long = `${"We value craft and care. ".repeat(4)}We hire in the Philippines and ${"many other places ".repeat(8)}today`;
    const { phrase } = classify(long.replace(/\. /g, ", "));
    expect(phrase?.length).toBeLessThanOrEqual(162);
    expect(phrase).toContain("Philippines");
  });
});
