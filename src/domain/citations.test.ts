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
import { projectHead } from "./draft-projects";
import { expandRoles, roleHeader } from "./work-roles";

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

  describe("role headers (decision 71)", () => {
    const header = roleHeader({
      title: "Full-stack Software Engineer",
      company: "Cashflowy",
      location: "Remote",
      start: "Jan, 2026",
      end: "Jun, 2026",
    });
    // FACT-2 sits under ROLE-1; FACT-1 and FACT-3 have no role.
    const roleFacts = facts.map((f) => ({ ...f, roleKey: f.key === k(2) ? "ROLE-1" : null }));
    const withRoles = (body: string) =>
      checkDraft({
        body,
        facts: roleFacts,
        allowedKeys: [k(1), k(2), k(3)],
        posting,
        contact,
        roles: [{ key: "ROLE-1", header }],
      });

    test("an expanded header of an allowed role passes", () => {
      expect(
        withRoles(["## Experience", header, "- Led a team of 4 engineers at Acme Corp [FACT-2]"].join("\n")),
      ).toEqual({
        ok: true,
      });
    });

    test("without the role list, the same header is an uncited claim", () => {
      expect(check(header)).toMatchObject({ ok: false, violations: [{ kind: "uncited_claim" }] });
    });

    test("an invented header is still flagged", () => {
      const result = withRoles("### Staff Engineer | Google, Remote | Jan, 2019 – Jun, 2021");
      expect(result).toMatchObject({ ok: false, violations: [{ kind: "uncited_claim" }] });
      if (!result.ok)
        expect(result.violations[0]).toMatchObject({ tokens: expect.arrayContaining(["Google", "2019"]) });
    });

    test("a [ROLE-n] left after expansion is an unknown role", () => {
      expect(withRoles("## Experience\n[ROLE-9]\n- Led a team of 4 engineers at Acme Corp [FACT-2]")).toMatchObject({
        ok: false,
        // The bullet has no real header above it, so it is also in the wrong place.
        violations: [
          { kind: "unknown_role", roleKey: "ROLE-9", sentence: "[ROLE-9]" },
          { kind: "wrong_role", roleKey: null, factKeys: ["FACT-2"] },
        ],
      });
      expect(withRoles("- Led a team at [ROLE-1] [FACT-2]")).toMatchObject({
        ok: false,
        violations: [{ kind: "unknown_role", roleKey: "ROLE-1" }],
      });
    });

    test("expansion then check: a known key passes, an unknown one fails", () => {
      const roles = [
        {
          key: "ROLE-1",
          title: "Full-stack Software Engineer",
          company: "Cashflowy",
          location: "Remote",
          start: "Jan, 2026",
          end: "Jun, 2026",
        },
      ];
      const body = "## Experience\n[ROLE-1]\n- Led a team of 4 engineers at Acme Corp [FACT-2]";
      expect(withRoles(expandRoles({ body, roles }))).toEqual({ ok: true });
      expect(withRoles(expandRoles({ body: body.replace("ROLE-1", "ROLE-2"), roles }))).toMatchObject({
        ok: false,
        violations: [
          { kind: "unknown_role", roleKey: "ROLE-2" },
          { kind: "wrong_role", roleKey: null },
        ],
      });
    });
  });

  describe("facts under the right role (decision 71)", () => {
    // Two overlapping roles, as on the user's CV: a part-time one runs alongside a full-time one.
    const cashflowy = roleHeader({
      title: "Full-stack Software Engineer",
      company: "Cashflowy",
      location: "Remote",
      start: "Jan, 2026",
      end: "Jun, 2026",
    });
    const tailor = roleHeader({
      title: "Full-stack Software Engineer",
      company: "Tailor.video",
      location: "Remote, Part-time",
      start: "Oct, 2025",
      end: "Apr, 2026",
    });
    const roleFacts = [
      { key: k(1), text: "Built the cash-flow dashboard in React.", roleKey: "ROLE-1" },
      { key: k(2), text: "Built the Zapier integration.", roleKey: "ROLE-2" },
      { key: k(3), text: "Skilled in TypeScript and Go.", roleKey: null },
    ];
    const run = (lines: string[]) =>
      checkDraft({
        body: lines.join("\n"),
        facts: roleFacts,
        allowedKeys: [k(1), k(2), k(3)],
        posting,
        contact,
        roles: [
          { key: "ROLE-1", header: cashflowy },
          { key: "ROLE-2", header: tailor },
        ],
      });

    test("each role's own facts under it pass, overlapping dates or not", () => {
      expect(
        run([
          "## Summary",
          "Skilled in TypeScript and Go [FACT-3]. Built the Zapier integration [FACT-2].",
          "## Experience",
          cashflowy,
          "- Built the cash-flow dashboard in React [FACT-1]",
          tailor,
          "- Built the Zapier integration [FACT-2]",
          "## Skills",
          "- TypeScript, Go [FACT-3]",
        ]),
      ).toEqual({ ok: true });
    });

    test("another role's fact under a header is a wrong role", () => {
      expect(run(["## Experience", cashflowy, "- Built the Zapier integration [FACT-2]"])).toMatchObject({
        ok: false,
        violations: [{ kind: "wrong_role", roleKey: "ROLE-1", factKeys: ["FACT-2"] }],
      });
    });

    test("a fact with no role under a header is a wrong role", () => {
      expect(run(["## Experience", tailor, "- Skilled in TypeScript and Go [FACT-3]"])).toMatchObject({
        ok: false,
        violations: [{ kind: "wrong_role", roleKey: "ROLE-2", factKeys: ["FACT-3"] }],
      });
    });

    test("a cited line under Experience before any header is a wrong role", () => {
      expect(run(["## Experience", "- Built the cash-flow dashboard in React [FACT-1]", cashflowy])).toMatchObject({
        ok: false,
        violations: [{ kind: "wrong_role", roleKey: null, factKeys: ["FACT-1"] }],
      });
    });

    test("a new section ends the role", () => {
      expect(
        run([
          "## Experience",
          cashflowy,
          "- Built the cash-flow dashboard in React [FACT-1]",
          "## Skills",
          "- TypeScript, Go [FACT-3]",
        ]),
      ).toEqual({ ok: true });
    });

    test("without roles there is no role rule", () => {
      expect(
        checkDraft({
          body: "## Experience\n- Skilled in TypeScript and Go [FACT-3]",
          facts: roleFacts,
          allowedKeys: [k(3)],
          posting,
          contact,
        }),
      ).toEqual({ ok: true });
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

describe("checkDraft with projects (decision 82)", () => {
  const k = (n: number) => FactKey.parse(`FACT-${n}`);
  const contact = { fullName: "Juan", email: "", phone: "", location: "", links: [] };
  const posting = { company: "Stripe", title: "Engineer" };
  const nyx = projectHead({ name: "Nyx", link: "https://github.com/rielj/nyx", stack: ["Go", "Kubernetes"] });
  const viem = projectHead({ name: "Viem", link: null, stack: [] });
  const role = roleHeader({ title: "Engineer", company: "Acme", location: null, start: null, end: null });
  const facts = [
    { key: k(1), text: "Nyx is a CLI that sorts Tailwind classes.", projectKey: "PROJECT-1" },
    { key: k(2), text: "Added value support to deployContract in Viem.", projectKey: "PROJECT-2" },
    { key: k(3), text: "Built the billing service.", roleKey: "ROLE-1" },
  ];
  const run = (lines: string[]) =>
    checkDraft({
      body: lines.join("\n"),
      facts,
      allowedKeys: [k(1), k(2), k(3)],
      posting,
      contact,
      roles: [{ key: "ROLE-1", header: role }],
      projects: [
        { key: "PROJECT-1", header: nyx },
        { key: "PROJECT-2", header: viem },
      ],
    });

  test("each project's facts under its head pass; the head's link and skills are the server's", () => {
    expect(
      run([
        "## Experience",
        role,
        "- Built the billing service [FACT-3]",
        "## Projects",
        nyx,
        "A CLI that sorts Tailwind classes [FACT-1].",
        "## Open Source Contributions",
        viem,
        "- Added value support to deployContract [FACT-2]",
      ]),
    ).toEqual({ ok: true });
  });

  test("another project's fact under a head is a wrong project", () => {
    expect(run(["## Projects", nyx, "- Added value support to deployContract [FACT-2]"])).toMatchObject({
      ok: false,
      violations: [{ kind: "wrong_project", projectKey: "PROJECT-1", factKeys: ["FACT-2"] }],
    });
    expect(run(["## Projects", nyx, "- Built the billing service [FACT-3]"])).toMatchObject({
      ok: false,
      violations: [{ kind: "wrong_project", projectKey: "PROJECT-1", factKeys: ["FACT-3"] }],
    });
  });

  test("a project's fact in a project section before any head is a wrong project; elsewhere it's fine", () => {
    expect(run(["## Projects", "A CLI that sorts Tailwind classes [FACT-1].", nyx])).toMatchObject({
      ok: false,
      violations: [{ kind: "wrong_project", projectKey: null, factKeys: ["FACT-1"] }],
    });
    expect(run(["## Summary", "Wrote a CLI that sorts Tailwind classes [FACT-1]."])).toEqual({ ok: true });
  });

  test("a project's fact under a role is a wrong role, and a role ends a project", () => {
    expect(run(["## Experience", role, "- Sorts Tailwind classes [FACT-1]"])).toMatchObject({
      ok: false,
      violations: [{ kind: "wrong_role", roleKey: "ROLE-1", factKeys: ["FACT-1"] }],
    });
    expect(run(["## Projects", nyx, role, "- Built the billing service [FACT-3]"])).toEqual({ ok: true });
  });

  test("projects alone don't turn on the Experience rule, and roles alone don't turn on the project one", () => {
    const noRoles = (body: string) =>
      checkDraft({
        body,
        facts,
        allowedKeys: [k(1), k(3)],
        posting,
        contact,
        roles: [],
        projects: [{ key: "PROJECT-1", header: nyx }],
      });
    expect(noRoles("## Experience\n- Built the billing service [FACT-3]")).toEqual({ ok: true });
    const noProjects = checkDraft({
      body: "## Projects\n- Sorts Tailwind classes [FACT-1]",
      facts,
      allowedKeys: [k(1)],
      posting,
      contact,
      roles: [{ key: "ROLE-1", header: role }],
      projects: [],
    });
    expect(noProjects).toEqual({ ok: true });
  });

  test("a contribution claimed as the candidate's own is flagged, cited or not; their own project is not", () => {
    const letter = (body: string) =>
      checkDraft({
        body,
        facts,
        allowedKeys: [k(1), k(2), k(3)],
        posting,
        contact,
        projectNames: [
          { key: "PROJECT-1", name: "Nyx", role: "own" },
          { key: "PROJECT-2", name: "Viem", role: "contribution" },
        ],
      });
    expect(letter("I built Viem, adding value support to deployContract [FACT-2].")).toMatchObject({
      ok: false,
      violations: [{ kind: "claims_contribution", projectKey: "PROJECT-2", name: "Viem", words: "built Viem" }],
    });
    expect(letter("I contributed value support to deployContract in Viem [FACT-2].")).toEqual({ ok: true });
    expect(letter("I built Nyx, a CLI that sorts Tailwind classes [FACT-1].")).toEqual({ ok: true });
  });

  test("citing a project's fact lets the sentence name the project", () => {
    const named = (projectNames: { key: string; name: string; role: "own" | "contribution" }[]) =>
      checkDraft({
        body: "I wrote the billing service for Acme Ledger [FACT-4].",
        facts: [{ key: k(4), text: "Wrote the billing service.", projectKey: "PROJECT-1" }],
        allowedKeys: [k(4)],
        posting,
        contact,
        projectNames,
      });
    expect(named([{ key: "PROJECT-1", name: "Acme Ledger", role: "own" }])).toEqual({ ok: true });
    expect(named([])).toMatchObject({ ok: false, violations: [{ kind: "unsupported_token" }] });
  });

  test("a [PROJECT-n] left in the body is an unknown project", () => {
    expect(run(["## Projects", "[PROJECT-9]", "See [PROJECT-1] for more."])).toMatchObject({
      ok: false,
      violations: [
        { kind: "unknown_project", projectKey: "PROJECT-9" },
        { kind: "unknown_project", projectKey: "PROJECT-1" },
      ],
    });
  });
});
