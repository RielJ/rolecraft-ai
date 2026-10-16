import { describe, expect, test } from "bun:test";
import { FactKey } from "@/shared/api";
import {
  checkDraft,
  checkThisPlaceholder,
  factKey,
  findPlaceholders,
  parseCitations,
  quarantineViolations,
  stripMarkers,
} from "./citations";

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

describe("checkDraft", () => {
  const k = (n: number) => FactKey.parse(`FACT-${n}`);
  const facts = [
    { key: k(1), text: "Built a payments API in Go serving 2M requests a day" },
    { key: k(2), text: "Led a team of 4 engineers at Acme Corp" },
    { key: k(3), text: "Moved the job queue to Postgres in March 2022, cutting costs by 30%" },
  ];
  const contact = {
    fullName: "Juan Dela Cruz",
    email: "juan@example.ph",
    phone: "",
    location: "Manila, Philippines",
    links: ["https://github.com/juan"],
  };
  const posting = { company: "Stripe", title: "Senior Backend Engineer" };
  const check = (body: string, allowedKeys = [k(1), k(2), k(3)]) =>
    checkDraft({ body, facts, allowedKeys, posting, contact });

  test("a draft whose claims all come from the cited facts passes", () => {
    const body = [
      "# Summary",
      "I build payment APIs in Go [FACT-1].",
      "## Experience",
      "- Led a team of four engineers at Acme [FACT-2]",
      "- Moved our queue to Postgres in March 2022 and cut costs by 30% [FACT-3].",
      "Dear Stripe team, I would like to talk. My code is on github.com/juan.",
    ].join("\n");
    expect(check(body)).toEqual({ ok: true });
  });

  test("an invented number is an unsupported token", () => {
    const result = check("I have 8 years of experience building payment APIs [FACT-1].");
    expect(result).toMatchObject({ ok: false, violations: [{ kind: "unsupported_token", tokens: ["8"] }] });
  });

  test("number words count as numbers", () => {
    expect(check("I led a team of four [FACT-2].")).toEqual({ ok: true });
    expect(check("I led a team of five [FACT-2].")).toMatchObject({ ok: false, violations: [{ tokens: ["five"] }] });
  });

  test("a claim must come from the facts that sentence cites, not another one", () => {
    const result = check("I used Postgres at Acme [FACT-2].");
    expect(result).toMatchObject({ ok: false, violations: [{ kind: "unsupported_token", tokens: ["Postgres"] }] });
  });

  test("a sentence with a claim and no marker is an uncited claim", () => {
    const result = check("I worked at Google for 3 years.");
    expect(result).toMatchObject({ ok: false, violations: [{ kind: "uncited_claim", tokens: ["3", "Google"] }] });
  });

  test("lowercase skills from the dictionary count as claims", () => {
    expect(check("I also know kubernetes [FACT-1].")).toMatchObject({
      ok: false,
      violations: [{ kind: "unsupported_token", tokens: ["kubernetes"] }],
    });
  });

  test("an unknown or disallowed key is an unknown fact", () => {
    expect(check("I built it [FACT-9].")).toMatchObject({
      ok: false,
      violations: [{ kind: "unknown_fact", factKey: "FACT-9" }],
    });
    expect(check("Led a team [FACT-2].", [k(1)])).toMatchObject({
      ok: false,
      violations: [{ kind: "unknown_fact", factKey: "FACT-2" }],
    });
  });

  test("unknown URLs and emails are claims; contact ones are not", () => {
    expect(check("Write to juan@example.ph.")).toEqual({ ok: true });
    expect(check("See juan.dev for more.")).toMatchObject({ ok: false, violations: [{ tokens: ["juan.dev"] }] });
  });

  test("placeholders and plain sentences carry no claims", () => {
    expect(check("I led [[how many]] people. I enjoy hard problems.")).toEqual({ ok: true });
  });

  test("violations carry offsets of the sentence in the body", () => {
    const body = "I build APIs [FACT-1]. I have 8 years in Go [FACT-1].";
    const result = check(body);
    if (result.ok) throw new Error("expected violations");
    const [v] = result.violations;
    expect(body.slice(v.start, v.end)).toBe("I have 8 years in Go [FACT-1].");
  });
});

describe("quarantineViolations", () => {
  test("replaces each failing sentence with a Check this placeholder", () => {
    const body = "I build APIs [FACT-1]. I have 8 years in Go [FACT-1].\n- Led a team";
    const sentence = "I have 8 years in Go [FACT-1].";
    const start = body.indexOf(sentence);
    const out = quarantineViolations({
      body,
      violations: [{ kind: "unsupported_token", tokens: ["8"], sentence, start, end: start + sentence.length }],
    });
    expect(out).toBe(`I build APIs [FACT-1]. ${checkThisPlaceholder(sentence)}\n- Led a team`);
    expect(findPlaceholders(out)).toEqual(['Check this: "I have 8 years in Go." is not backed by your facts']);
  });
});
