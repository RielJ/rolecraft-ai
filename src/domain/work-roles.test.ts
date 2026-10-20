import { describe, expect, test } from "bun:test";
import { COMMA_CV, COMMA_ROLES, PAREN_CV, PAREN_ROLES } from "../../test/fixtures/roles-cv";
import {
  checkRoles,
  type DraftRole,
  expandRoles,
  isRoleHeader,
  parseRoleHeader,
  roleForSection,
  roleHeader,
  roleHeaderPlain,
  rolePromptLine,
  textContains,
} from "./work-roles";

const TEXT = [
  "Full-stack Software Engineer Jan, 2026 – Jun, 2026",
  "Cashflowy (Remote)",
  "• Built the invoicing flow.",
  "Full-stack Software Engineer January 2026 – June 2026",
  "CASHFLOWY, REMOTE",
].join("\n");

describe("textContains", () => {
  test("ignores case and whitespace", () => {
    expect(textContains({ text: "Cashflowy  (Remote)", value: "cashflowy" })).toBe(true);
    expect(textContains({ text: "Jan,\n2026", value: "Jan, 2026" })).toBe(true);
  });

  test("a word must not be part of a longer word", () => {
    expect(textContains({ text: "Software Engineering", value: "Engineer" })).toBe(false);
    expect(textContains({ text: "Engineering, Engineer", value: "Engineer" })).toBe(true);
  });

  test("punctuation at a value's edge needs no boundary", () => {
    expect(textContains({ text: "Soulbound Inc. (Remote)", value: "Soulbound Inc." })).toBe(true);
  });
});

describe("checkRoles", () => {
  test("keeps every field the text has, in both header shapes", () => {
    const roles = [
      {
        title: "Full-stack Software Engineer",
        company: "Cashflowy",
        location: "Remote",
        start: "Jan, 2026",
        end: "Jun, 2026",
      },
      {
        title: "Full-stack Software Engineer",
        company: "CASHFLOWY",
        location: "REMOTE",
        start: "January 2026",
        end: "June 2026",
      },
    ];
    expect(checkRoles({ text: TEXT, roles })).toEqual(roles);
  });

  test("a field missing from the text is dropped and the role stays", () => {
    expect(
      checkRoles({
        text: TEXT,
        roles: [
          {
            title: "Full-stack Software Engineer",
            company: "Cashflowy",
            location: "Manila",
            start: "Jan 2026",
            end: "Jun, 2026",
          },
        ],
      }),
    ).toEqual([
      { title: "Full-stack Software Engineer", company: "Cashflowy", location: null, start: null, end: "Jun, 2026" },
    ]);
  });

  test("a role without a company, or with an invented one, is dropped", () => {
    expect(
      checkRoles({
        text: TEXT,
        roles: [
          { title: "Full-stack Software Engineer", company: null },
          { title: "Full-stack Software Engineer", company: "Google" },
          { title: "Staff Engineer", company: "Cashflowy" },
        ],
      }),
    ).toEqual([]);
  });

  test("the user's real CV: every role reads back whole", () => {
    expect(checkRoles({ text: PAREN_CV, roles: PAREN_ROLES })).toEqual(PAREN_ROLES);
    expect(checkRoles({ text: COMMA_CV, roles: COMMA_ROLES })).toEqual(COMMA_ROLES);
  });

  test("overlapping roles are normal: both are kept, in the CV's order, with their own dates", () => {
    // The user's real CV: a part-time role runs alongside two full-time ones.
    const text = [
      "Full-stack Software Engineer Jan, 2026 – Jun, 2026",
      "Cashflowy (Remote)",
      "• Built the cash-flow dashboard.",
      "Full-stack Software Engineer Oct, 2025 – Apr, 2026",
      "Tailor.video (Remote, Part-time)",
      "• Built Zapier integration.",
      "Full-stack Software Engineer Nov, 2024 – Jan, 2026",
      "Soulbound Inc. (Remote)",
      "• Shipped the wallet.",
    ].join("\n");
    const roles = [
      {
        title: "Full-stack Software Engineer",
        company: "Cashflowy",
        location: "Remote",
        start: "Jan, 2026",
        end: "Jun, 2026",
      },
      {
        title: "Full-stack Software Engineer",
        company: "Tailor.video",
        location: "Remote, Part-time",
        start: "Oct, 2025",
        end: "Apr, 2026",
      },
      {
        title: "Full-stack Software Engineer",
        company: "Soulbound Inc.",
        location: "Remote",
        start: "Nov, 2024",
        end: "Jan, 2026",
      },
    ];
    expect(checkRoles({ text, roles })).toEqual(roles);
  });

  test("a company named only in a bullet is not a role", () => {
    // "Stripe" and "Google" sit in bullets of the user's CV; the titles sit in headers.
    const text = [
      "Full-stack Software Engineer Jan, 2026 – Jun, 2026",
      "Cashflowy (Remote)",
      "• Integrated Plaid and Stripe, then generated type-safe TypeScript SDKs.",
      "• Replaced Stack Auth with Better Auth, implementing Google and Microsoft OAuth.",
    ].join("\n");
    expect(
      checkRoles({
        text,
        roles: [
          { title: "Full-stack Software Engineer", company: "Stripe" },
          { title: "Full-stack Software Engineer", company: "Google", start: "Jan, 2026" },
        ],
      }),
    ).toEqual([]);
  });

  test("a bullet after a lone bullet mark is bullet text too", () => {
    const text = ["Software Engineer March 2022 – December 2025", "BANWA, MANILA", "•", "Shipped Stripe billing."].join(
      "\n",
    );
    expect(checkRoles({ text, roles: [{ title: "Software Engineer", company: "Stripe" }] })).toEqual([]);
  });

  test("fields from two different roles' headers do not make one role", () => {
    // Title of one role, company of another, dates of a third: each exists, never together.
    const mixed = checkRoles({
      text: PAREN_CV,
      roles: [
        { title: "Backend Engineer", company: "Lakbay Labs" },
        { title: "Full-stack Software Engineer", company: "Lakbay Labs", start: "Jul, 2023", end: "Feb, 2024" },
      ],
    });
    expect(mixed).toEqual([
      { title: "Full-stack Software Engineer", company: "Lakbay Labs", location: null, start: null, end: null },
    ]);
  });

  test("a wrapped bullet's next line is bullet text too", () => {
    const text = [
      "Software Engineer Jul, 2023 – Feb, 2024",
      "Token Metrics (Remote)",
      "• Migrated a legacy Angular application to Next.js and improved load speed with",
      "cloudflare (Remote) in before-and-after tests.",
    ].join("\n");
    expect(checkRoles({ text, roles: [{ title: "Software Engineer", company: "cloudflare" }] })).toEqual([]);
  });

  test("a title or company must start its part of the line, not sit inside a longer one", () => {
    // "Software Engineer" is inside "Full-stack Software Engineer"; "Labs" inside "Lakbay Labs".
    expect(
      checkRoles({
        text: PAREN_CV,
        roles: [
          { title: "Software Engineer", company: "Lakbay Labs", start: "Jan, 2026" },
          { title: "Full-stack Software Engineer", company: "Labs" },
        ],
      }),
    ).toEqual([]);
    // After a separator is fine: "Acme Corp — Senior Engineer", "Senior Engineer at Acme Corp".
    for (const line of ["Acme Corp — Senior Engineer, 2019 – 2021", "Senior Engineer at Acme Corp, 2019 – 2021"]) {
      expect(checkRoles({ text: line, roles: [{ title: "Senior Engineer", company: "Acme Corp" }] })).toHaveLength(1);
    }
  });

  test("a header spread over four lines still reads", () => {
    const text = ["Senior Engineer", "Acme Corp", "Manila", "May 2019 – Present", "- Built the API."].join("\n");
    expect(
      checkRoles({
        text,
        roles: [
          { title: "Senior Engineer", company: "Acme Corp", location: "Manila", start: "May 2019", end: "Present" },
        ],
      }),
    ).toEqual([
      { title: "Senior Engineer", company: "Acme Corp", location: "Manila", start: "May 2019", end: "Present" },
    ]);
  });

  test("fields are trimmed, and a repeated role is kept once", () => {
    const role = { title: "  Full-stack  Software Engineer ", company: "Cashflowy" };
    expect(checkRoles({ text: TEXT, roles: [role, role] })).toEqual([
      { title: "Full-stack Software Engineer", company: "Cashflowy", location: null, start: null, end: null },
    ]);
  });
});

const CASHFLOWY: DraftRole = {
  key: "ROLE-1",
  title: "Full-stack Software Engineer",
  company: "Cashflowy",
  location: "Remote",
  start: "Jan, 2026",
  end: "Jun, 2026",
};
const TAILOR: DraftRole = {
  key: "ROLE-2",
  title: "Full-stack Software Engineer",
  company: "Tailor.video",
  location: "Remote, Part-time",
  start: "Oct, 2025",
  end: "Apr, 2026",
};

describe("roleHeader", () => {
  test("title, company with location, and dates as written", () => {
    expect(roleHeader(CASHFLOWY)).toBe("### Full-stack Software Engineer | Cashflowy, Remote | Jan, 2026 – Jun, 2026");
    expect(roleHeader(TAILOR)).toBe(
      "### Full-stack Software Engineer | Tailor.video, Remote, Part-time | Oct, 2025 – Apr, 2026",
    );
  });

  test("parts the role lacks are left out", () => {
    expect(roleHeader({ ...CASHFLOWY, location: null, start: null, end: null })).toBe(
      "### Full-stack Software Engineer | Cashflowy",
    );
    expect(roleHeader({ ...CASHFLOWY, start: "January 2026", end: "Present" })).toBe(
      "### Full-stack Software Engineer | Cashflowy, Remote | January 2026 – Present",
    );
    expect(roleHeader({ ...CASHFLOWY, start: null })).toBe(
      "### Full-stack Software Engineer | Cashflowy, Remote | Jun, 2026",
    );
  });

  test("a | in a field cannot split the header", () => {
    expect(parseRoleHeader(roleHeader({ ...CASHFLOWY, title: "Engineer | Lead" }))).toEqual({
      title: "Engineer / Lead",
      org: "Cashflowy, Remote",
      dates: "Jan, 2026 – Jun, 2026",
    });
  });
});

describe("rolePromptLine", () => {
  test("names every part on one line", () => {
    expect(rolePromptLine(CASHFLOWY)).toBe(
      "ROLE-1: Full-stack Software Engineer, Cashflowy, Remote, Jan, 2026 – Jun, 2026",
    );
  });
});

describe("parseRoleHeader and roleHeaderPlain", () => {
  test("a header reads as one plain line", () => {
    const header = parseRoleHeader(roleHeader(CASHFLOWY));
    expect(header).not.toBeNull();
    if (header)
      expect(roleHeaderPlain(header)).toBe("Full-stack Software Engineer, Cashflowy, Remote (Jan, 2026 – Jun, 2026)");
  });

  test("a header without dates has no parentheses", () => {
    const header = parseRoleHeader("### Engineer | Cashflowy");
    expect(header && roleHeaderPlain(header)).toBe("Engineer, Cashflowy");
  });

  test("other headings are not role headers", () => {
    expect(parseRoleHeader("## Experience")).toBeNull();
    expect(parseRoleHeader("### Projects")).toBeNull();
    expect(parseRoleHeader("- a | b")).toBeNull();
  });
});

describe("roleForSection", () => {
  const roles = [
    { id: 1, company: "CASHFLOWY" },
    { id: 2, company: "Banwa" },
    { id: 3, company: "banwa " },
  ];

  test("a section equal to one company, in any case, links to that role", () => {
    expect(roleForSection({ section: "Cashflowy", roles })?.id).toBe(1);
  });

  test("a section matching two roles, none, or no section links to nothing", () => {
    expect(roleForSection({ section: "BANWA", roles })).toBeNull();
    expect(roleForSection({ section: "Cashflowy Inc.", roles })).toBeNull();
    expect(roleForSection({ section: null, roles })).toBeNull();
  });
});

describe("expandRoles", () => {
  test("each [ROLE-n] line becomes its role's header", () => {
    const body = ["## Experience", "[ROLE-1]", "- Built it [FACT-1].", "  [ROLE-2]  ", "- Moved it [FACT-2]."].join(
      "\n",
    );
    expect(expandRoles({ body, roles: [CASHFLOWY, TAILOR] })).toBe(
      ["## Experience", roleHeader(CASHFLOWY), "- Built it [FACT-1].", roleHeader(TAILOR), "- Moved it [FACT-2]."].join(
        "\n",
      ),
    );
  });

  test("a key after a heading mark is expanded too", () => {
    expect(expandRoles({ body: "### [ROLE-1]", roles: [CASHFLOWY] })).toBe(roleHeader(CASHFLOWY));
  });

  test("an unknown key and an inline key stay as written", () => {
    const body = "[ROLE-9]\n- Built it at [ROLE-1] [FACT-1].";
    expect(expandRoles({ body, roles: [CASHFLOWY] })).toBe(body);
  });
});

describe("isRoleHeader (decision 71)", () => {
  const roles = [
    {
      title: "Full-stack Software Engineer",
      company: "Cashflowy",
      location: "Remote",
      start: "Jan, 2026",
      end: "Jun, 2026",
    },
    { title: "Software Engineer", company: "Token Metrics", location: "Remote", start: "Jul, 2023", end: "Feb, 2024" },
    { title: "Backend Engineer", company: "BANWA", location: null, start: "March 2022", end: "Present" },
  ];

  test("the split's header facts from the user's CV are headers", () => {
    for (const text of [
      "Full-stack Software Engineer, Jan, 2026 – Jun, 2026",
      "Software Engineer, Jul, 2023 – Feb, 2024",
      "Full-stack Software Engineer at Cashflowy (Remote)",
      "Cashflowy",
      "Jan, 2026 – Jun, 2026",
      "Backend Engineer | BANWA | March 2022 - Present.",
    ]) {
      expect({ text, header: isRoleHeader({ text, roles }) }).toEqual({ text, header: true });
    }
  });

  test("a claim that names a role's fields is not a header", () => {
    for (const text of [
      "Built Zapier integration.",
      "Full-stack Software Engineer with 5 years of TypeScript.",
      "Led a team of 4 at Cashflowy.",
      "Joined Token Metrics in Jul, 2023 to rebuild the dashboard.",
      "Remote work across 3 time zones.",
    ]) {
      expect({ text, header: isRoleHeader({ text, roles }) }).toEqual({ text, header: false });
    }
  });

  test("fields of two roles mixed are not one role's header", () => {
    expect(isRoleHeader({ text: "Backend Engineer, Jan, 2026 – Jun, 2026", roles })).toBe(false);
  });

  test("with no roles nothing is a header", () => {
    expect(isRoleHeader({ text: "Software Engineer, Jul, 2023 – Feb, 2024", roles: [] })).toBe(false);
  });
});
