import { describe, expect, test } from "bun:test";
import { type MatchJob, type MatchLevel, type MatchProfile, matcher, matchJob, payBelow } from "./match";

const PROFILE: MatchProfile = {
  targetTitles: ["Frontend Engineer"],
  skills: ["React", "TypeScript", "CSS", "GraphQL", "Node.js"],
  seniority: "senior",
  years: 6,
};

const JOB: MatchJob = {
  title: "Senior Frontend Engineer",
  skills: ["React", "TypeScript", "CSS"],
  seniority: "senior",
  minYears: 5,
  eligibility: "worldwide",
  roleUnclear: null,
};

const level = (job: Partial<MatchJob>, profile: Partial<MatchProfile> = {}): MatchLevel =>
  matchJob({ job: { ...JOB, ...job }, profile: { ...PROFILE, ...profile } }).level;

const texts = (job: Partial<MatchJob>, profile: Partial<MatchProfile> = {}) =>
  matchJob({ job: { ...JOB, ...job }, profile: { ...PROFILE, ...profile } }).reasons.map((r) => `${r.sign}: ${r.text}`);

describe("matchJob: level boundaries (section 3.7)", () => {
  test("Strong: title fit, full coverage, no negatives, eligibility not capped", () => {
    expect(level({})).toBe("strong");
    expect(texts({})).toEqual([
      "positive: Title fits your target “Frontend Engineer”",
      "positive: In your facts: React, TypeScript, CSS",
      "positive: Hires worldwide",
    ]);
  });

  test("title: Jaccard 0.6 is a fit, 0.3 partial (both can be Strong), below 0.3 is Weak", () => {
    // Rank words are dropped from both sides: "Senior" does not count against the fit.
    // "Frontend" is "front end": {front, end, engineer} vs {front, end, engineer, react}: 3/4 ≥ 0.6, a fit.
    expect(texts({ title: "Senior React Frontend Engineer" })[0]).toBe(
      "positive: Title fits your target “Frontend Engineer”",
    );
    // vs {front, end, engineer, react, web, platform}: 3/6 = 0.5, partial, still Strong.
    expect(texts({ title: "Frontend Engineer, React Web Platform" })[0]).toBe(
      "positive: Title is close to your target “Frontend Engineer”",
    );
    expect(level({ title: "Frontend Engineer, React Web Platform" })).toBe("strong");
    // vs {front, end, web, platform, tooling, engineer, react, ui, design, systems, infra}: 3/11 < 0.3.
    expect(level({ title: "Frontend Web Platform Tooling Engineer React UI Design Systems Infra" })).toBe("weak");
    // Exactly 0.3 is partial: {a b c} vs {a b c d e f g h i j} = 3/10.
    expect(
      level(
        { title: "alpha beta gamma delta epsilon zeta eta theta iota kappa" },
        { targetTitles: ["alpha beta gamma"] },
      ),
    ).toBe("strong");
    expect(
      level(
        { title: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda" },
        { targetTitles: ["alpha beta gamma"] },
      ),
    ).toBe("weak");
  });

  test("title words: compounds split, developer is engineer, and a tail after a dash, bar or bracket is cut", () => {
    const fit = (title: string, targetTitles: string[]) =>
      texts({ title }, { targetTitles })[0]?.replace(/ your target .*/, "");
    expect(fit("Fullstack Developer", ["Full Stack Engineer"])).toBe("positive: Title fits");
    expect(fit("Front-end Programmer", ["Frontend Engineer"])).toBe("positive: Title fits");
    expect(fit("Backend Developer", ["Back End Engineer"])).toBe("positive: Title fits");
    expect(fit("Senior Full-Stack Engineer - Payments | Remote (PH)", ["Full Stack Engineer"])).toBe(
      "positive: Title fits",
    );
    expect(fit("Full Stack Engineer — Billing, Invoicing and Ledger Platform", ["Full Stack Engineer"])).toBe(
      "positive: Title fits",
    );
    expect(fit("Full Stack Engineer (TypeScript, React, Node, Postgres)", ["Full Stack Engineer"])).toBe(
      "positive: Title fits",
    );
    // A head of one word is not cut: the tail still counts.
    expect(fit("Engineer – Full Stack", ["Full Stack Engineer"])).toBe("positive: Title fits");
    // {web, engineer} vs {software, engineer}: 1/3, partial.
    expect(fit("Web Developer", ["Full Stack Engineer", "Frontend Engineer", "Software Engineer"])).toBe(
      "positive: Title is close to",
    );
    expect(fit("Data Analyst", ["Full Stack Engineer", "Frontend Engineer", "Software Engineer"])).toBe(
      "negative: Title is not close to any of",
    );
  });

  test("the best of several target titles counts", () => {
    expect(level({ title: "Backend Developer" }, { targetTitles: ["Frontend Engineer", "Backend Developer"] })).toBe(
      "strong",
    );
  });

  test("no target titles: the title is not scored, so Possible at best and never Weak by title", () => {
    expect(level({}, { targetTitles: [] })).toBe("possible");
    expect(texts({}, { targetTitles: [] })[0]).toBe(
      "neutral: No target titles in your profile, so the title is not scored",
    );
  });

  test("coverage 0.6 is Strong; just under is Possible", () => {
    // 3 of 5 = 0.6
    expect(level({ skills: ["React", "TypeScript", "CSS", "Go", "Kafka"] })).toBe("strong");
    // 3 of 6 = 0.5
    expect(level({ skills: ["React", "TypeScript", "CSS", "Go", "Kafka", "Rust"] })).toBe("possible");
  });

  test("coverage under 0.3 is Weak only with at least three job skills", () => {
    // 1 of 4 = 0.25, four skills: Weak.
    expect(level({ skills: ["React", "Go", "Kafka", "Rust"] })).toBe("weak");
    // 1 of 3 ≈ 0.33: not under 0.3, Possible.
    expect(level({ skills: ["React", "Go", "Kafka"] })).toBe("possible");
    // 0 of 2: under 0.3 but only two job skills, Possible.
    expect(level({ skills: ["Go", "Kafka"] })).toBe("possible");
    // No skills at all: coverage 0 of 0 cannot be Strong, and is not Weak.
    expect(level({ skills: [] })).toBe("possible");
  });

  test("skills compare case-insensitively and name at most five of each", () => {
    const reasons = texts({ skills: ["react", "Go", "Kafka", "Rust", "Ruby", "PHP", "Scala"] }, { skills: ["React"] });
    expect(reasons).toContain("positive: In your facts: react");
    expect(reasons).toContain("negative: Not in your facts: Go, Kafka, Rust, Ruby, PHP and 1 more");
  });

  test("seniority two or more steps apart is a negative and blocks Strong; one step is fine", () => {
    expect(level({ seniority: "lead" })).toBe("strong");
    expect(level({ seniority: "staff" })).toBe("possible");
    expect(texts({ seniority: "staff" })).toContain("negative: Staff role, and you are senior: above your level");
    expect(level({ seniority: "junior" })).toBe("possible");
    // Unknown on either side says nothing.
    expect(level({ seniority: null })).toBe("strong");
    expect(level({ seniority: "principal" }, { seniority: null })).toBe("strong");
  });

  test("manager roles are a negative unless a target title is a manager title", () => {
    // "Lead" is a rank word, so the title fits; the manager rule alone keeps it from Strong.
    expect(
      level(
        { seniority: "manager", title: "Frontend Engineering Manager" },
        { targetTitles: ["Frontend Engineering Lead"] },
      ),
    ).toBe("possible");
    expect(
      level(
        { seniority: "manager", title: "Frontend Engineering Manager" },
        { targetTitles: ["Frontend Engineering Manager"] },
      ),
    ).toBe("strong");
  });

  test("years: more than one year above yours is a negative", () => {
    expect(level({ minYears: 7 })).toBe("strong");
    expect(level({ minYears: 8 })).toBe("possible");
    expect(texts({ minYears: 8 })).toContain("negative: Asks for 8+ years of experience; you have 6 years");
    expect(level({ minYears: 20 }, { years: null })).toBe("strong");
  });
});

describe("matchJob: caps", () => {
  test("ph, worldwide and apac are positives and do not cap", () => {
    for (const eligibility of ["ph", "worldwide", "apac"] as const) expect(level({ eligibility })).toBe("strong");
  });

  test("americas caps at Possible", () => {
    expect(level({ eligibility: "americas" })).toBe("possible");
    expect(texts({ eligibility: "americas" })).toContain("negative: Hires in the Americas, so it is Possible at best");
  });

  test("unclear caps at Possible", () => {
    expect(level({ eligibility: "unclear" })).toBe("possible");
  });

  test("excluded forces Weak", () => {
    expect(level({ eligibility: "excluded" })).toBe("weak");
  });

  test("excluded but moved to Matches by the user caps at Possible instead (decision 53)", () => {
    expect(level({ eligibility: "excluded", eligibilityOverridden: true })).toBe("possible");
    expect(texts({ eligibility: "excluded", eligibilityOverridden: true })).toContain(
      "negative: The posting limits where it hires, and you moved it to Matches, so it is Possible at best",
    );
    // The flag means nothing on a verdict that is not excluded.
    expect(level({ eligibilityOverridden: true })).toBe("strong");
  });

  test("role unsure caps at Possible and says why", () => {
    const roleUnclear = { reason: "title mixes engineering and design" };
    expect(level({ roleUnclear })).toBe("possible");
    expect(texts({ roleUnclear })).toContain(
      "negative: Role unclear (title mixes engineering and design), so it is Possible at best",
    );
  });

  test("caps never lift a Weak job", () => {
    expect(level({ roleUnclear: { reason: "x" }, title: "Accountant" })).toBe("weak");
    expect(level({ eligibility: "americas", skills: ["Go", "Kafka", "Rust"] })).toBe("weak");
  });
});

describe("payBelow: the Matches pay filter (decision 20)", () => {
  const view = { viewCurrency: "PHP", rates: { USD: 58 } };
  test("hides only pay that converts and falls under the filter", () => {
    // $1,000 a month = ₱58,000.
    const usd = { min: 1000, max: null, currency: "USD", period: "month" as const };
    expect(payBelow({ pay: usd, atLeast: 60_000, ...view })).toBe(true);
    expect(payBelow({ pay: usd, atLeast: 58_000, ...view })).toBe(false);
    // The top of a range counts: $800–$1,200 reaches ₱60,000.
    expect(payBelow({ pay: { ...usd, min: 800, max: 1200 }, atLeast: 60_000, ...view })).toBe(false);
    // Yearly in the view currency: ₱600,000 a year = ₱50,000 a month.
    const php = { min: 600_000, max: null, currency: "PHP", period: "year" as const };
    expect(payBelow({ pay: php, atLeast: 60_000, ...view })).toBe(true);
  });

  test("never hides no pay, no period, or a currency with no rate", () => {
    expect(payBelow({ pay: null, atLeast: 1_000_000, ...view })).toBe(false);
    expect(payBelow({ pay: { min: 1, max: null, currency: "USD", period: null }, atLeast: 1e6, ...view })).toBe(false);
    expect(payBelow({ pay: { min: 1, max: null, currency: "EUR", period: "month" }, atLeast: 1e6, ...view })).toBe(
      false,
    );
  });
});

test("a 20k-job list scores well under a second (PLAN.md section 6 risk)", () => {
  const score = matcher(PROFILE);
  const jobs: MatchJob[] = Array.from({ length: 20_000 }, (_, i) => ({
    ...JOB,
    title: i % 3 === 0 ? "Senior Frontend Engineer" : i % 3 === 1 ? "Backend Developer" : "Data Analyst",
    skills: ["React", "TypeScript", "Go", "Kafka", "PostgreSQL"].slice(0, (i % 5) + 1),
  }));
  const started = performance.now();
  for (const job of jobs) score(job);
  expect(performance.now() - started).toBeLessThan(1000);
});
