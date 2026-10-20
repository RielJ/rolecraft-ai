import { describe, expect, test } from "bun:test";
import { type Contact, FactKey } from "@/shared/api";
import { mapFactsToLines, parseBaseCv, renderLines } from "./base-cv";
import { CV, ROLES } from "./base-cv.fixture";
import { checkLine } from "./citations";
import { applyEdits, changedText, changeViews, type TailorChange, type TailorOp, validateEdits } from "./tailor";

const key = (n: number) => FactKey.parse(`FACT-${n}`);
const contact: Contact = {
  fullName: "Alex Reyes",
  email: "alex@example.com",
  phone: "",
  location: "Manila",
  links: [],
};
const posting = { company: "Owner", title: "Senior Backend Engineer" };

const FACTS = [
  { key: key(1), text: "Cut p95 checkout latency by 40% with Postgres query plans.", roleKey: "ROLE-1" },
  { key: key(2), text: "Used Redis caching for checkout.", roleKey: "ROLE-1" },
  { key: key(3), text: "Built a ledger service in Go that settles 2 million payments a day.", roleKey: "ROLE-1" },
  { key: key(4), text: "Ran the ledger service on Docker with GitHub Actions deploys.", roleKey: "ROLE-1" },
  { key: key(5), text: "Wrote the order API in TypeScript used by 3 mobile apps.", roleKey: "ROLE-2" },
  { key: key(6), text: "Backend engineer with 6 years building payment services.", roleKey: null },
  { key: key(7), text: "Knows Solidity and Hardhat.", roleKey: null },
];

const { lines: base } = mapFactsToLines({ lines: parseBaseCv({ text: CV, roles: ROLES }), facts: FACTS });
const id = (start: string) => base.find((l) => l.text.startsWith(start))?.id ?? "missing";
const roleLine = (n: number) => base.filter((l) => l.kind === "role")[n - 1]?.id ?? "missing";
const skills = base.find((l) => l.kind === "heading" && l.section === "skills")?.id ?? "missing";

const validate = (ops: TailorOp[], protectedKeys: FactKey[] = []) =>
  validateEdits({
    base,
    ops,
    facts: FACTS,
    protectedKeys: new Set(protectedKeys),
    requirementIds: new Set(["R1", "R2", "R3"]),
    posting,
    contact,
  });

const reword = (line: string, text: string, facts: FactKey[] = []): TailorOp => ({
  op: "reword",
  line,
  text,
  facts,
  reasons: ["R1"],
  note: null,
});

describe("checkLine", () => {
  test("a tool the evidence lacks is flagged", () => {
    expect(
      checkLine({ text: "Ran checkout on Kubernetes.", evidence: ["Ran checkout on Docker."], posting, contact }),
    ).toEqual(["Kubernetes"]);
  });

  test("a number the evidence lacks is flagged", () => {
    expect(checkLine({ text: "Cut latency by 60%.", evidence: ["Cut latency by 40%."], posting, contact })).toEqual([
      "60%",
    ]);
  });

  test("the CV line's own words pass", () => {
    const line = "Cut p95 checkout latency by 40% with Postgres query plans and Redis caching.";
    expect(checkLine({ text: `Improved performance: ${line}`, evidence: [line], posting, contact })).toEqual([]);
  });
});

describe("validateEdits", () => {
  test("a reword backed by the line and its facts is kept", () => {
    const { changes, dropped } = validate([
      reword(
        id("Cut p95"),
        "Improved checkout performance: cut p95 latency by 40% with Postgres query plans and Redis caching.",
      ),
    ]);
    expect(dropped).toEqual([]);
    expect(changes.map((c) => [c.id, c.op, c.status])).toEqual([["C1", "reword", "accepted"]]);
  });

  test("a reword adding a tool is dropped as unsupported", () => {
    const { changes, dropped } = validate([reword(id("Cut p95"), "Cut p95 latency by 40% on Kubernetes.")]);
    expect(changes).toEqual([]);
    expect(dropped.map((d) => [d.reason, d.detail])).toEqual([["unsupported", "Kubernetes"]]);
  });

  test("a reword may use a cited fact of its own role", () => {
    const { dropped } = validate([
      reword(
        id("Built a ledger"),
        "Built a ledger service in Go, deployed on Docker, that settles 2 million payments a day.",
        [key(4)],
      ),
    ]);
    expect(dropped).toEqual([]);
  });

  test("a fact from another role is wrong_role", () => {
    const { dropped } = validate([reword(id("Cut p95"), "Cut p95 latency by 40% in TypeScript.", [key(5)])]);
    expect(dropped.map((d) => d.reason)).toEqual(["wrong_role"]);
  });

  test("an unknown fact is dropped", () => {
    const { dropped } = validate([reword(id("Cut p95"), "Cut p95 latency by 40%.", [key(99)])]);
    expect(dropped.map((d) => d.reason)).toEqual(["unknown_fact"]);
  });

  test("a pronoun is dropped", () => {
    const { dropped } = validate([reword(id("Cut p95"), "I cut p95 checkout latency by 40%.")]);
    expect(dropped.map((d) => d.reason)).toEqual(["pronoun"]);
  });

  test("a heading, role header or contact line can't be edited", () => {
    const { dropped } = validate([
      reword(roleLine(1), "Staff Engineer"),
      { op: "remove", line: "L1", reasons: [], note: null },
      { op: "remove", line: skills, reasons: [], note: null },
    ]);
    expect(dropped.map((d) => d.reason)).toEqual(["bad_target", "bad_target", "bad_target"]);
  });

  test("an unchanged reword is no_change", () => {
    const line = base.find((l) => l.id === id("Cut p95"));
    expect(validate([reword(id("Cut p95"), line?.text ?? "")]).dropped.map((d) => d.reason)).toEqual(["no_change"]);
  });

  test("a line holding a REQUIRED fact can't be removed", () => {
    const { dropped } = validate([{ op: "remove", line: id("Cut p95"), reasons: [], note: null }], [key(1)]);
    expect(dropped.map((d) => [d.reason, d.detail])).toEqual([["protected", "FACT-1"]]);
  });

  test("a project's only description can't be removed (its title and link would be left bare)", () => {
    const { changes, dropped } = validate([
      { op: "remove", line: id("A CLI that diffs"), reasons: [], note: null },
      { op: "remove", line: id("Fixed a race"), reasons: [], note: null },
    ]);
    expect(changes).toEqual([]);
    expect(dropped.map((d) => [d.reason, d.detail])).toEqual([
      ["only_description", "pg-tools - Postgres CLI helpers"],
      ["only_description", "Open Source"],
    ]);
  });

  test("a project with two descriptions can lose one, never both", () => {
    const cv = CV.replace("• A CLI that diffs two schemas.", "• A CLI that diffs two schemas.\n• Ships as one binary.");
    const twoLines = parseBaseCv({ text: cv, roles: ROLES });
    const at = (start: string) => twoLines.find((l) => l.text.startsWith(start))?.id ?? "missing";
    const { changes, dropped } = validateEdits({
      base: twoLines,
      ops: [
        { op: "remove", line: at("Ships as"), reasons: [], note: null },
        { op: "remove", line: at("A CLI that diffs"), reasons: [], note: null },
      ],
      facts: FACTS,
      protectedKeys: new Set(),
      requirementIds: new Set(),
      posting,
      contact,
    });
    expect(changes.map((c) => c.op === "remove" && c.line)).toEqual([at("Ships as")]);
    expect(dropped.map((d) => d.reason)).toEqual(["only_description"]);
  });

  test("the blockchain skills line can be removed", () => {
    const { changes } = validate([{ op: "remove", line: id("Blockchain"), reasons: [], note: "Not asked for" }]);
    expect(changes).toHaveLength(1);
  });

  test("a second change on one line is dropped", () => {
    const { changes, dropped } = validate([
      { op: "remove", line: id("Blockchain"), reasons: [], note: null },
      reword(id("Blockchain"), "Blockchain: Solidity"),
    ]);
    expect(changes).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(["bad_target"]);
  });

  test("an order must permute exactly the role's bullets", () => {
    const bullets = base.filter((l) => l.role === roleLine(1)).map((l) => l.id);
    const { changes, dropped } = validate([
      { op: "order", parent: roleLine(1), lines: bullets.slice(1), reasons: ["R1"], note: null },
      { op: "order", parent: roleLine(1), lines: [...bullets].reverse(), reasons: ["R1"], note: null },
    ]);
    expect(dropped.map((d) => d.reason)).toEqual(["bad_target"]);
    expect(changes.map((c) => c.op)).toEqual(["order"]);
  });

  test("skills lines can be ordered", () => {
    const lines = base.filter((l) => l.section === "skills" && l.kind === "text").map((l) => l.id);
    expect(
      validate([{ op: "order", parent: skills, lines: [...lines].reverse(), reasons: [], note: null }]).changes,
    ).toHaveLength(1);
  });

  test("an add needs a fact of the anchor's role and new content", () => {
    const { changes, dropped } = validate([
      { op: "add", after: roleLine(1), text: "Ran the ledger service on Docker.", facts: [], reasons: [], note: null },
      { op: "add", after: roleLine(1), text: "Wrote the order API.", facts: [key(5)], reasons: [], note: null },
      {
        op: "add",
        after: roleLine(1),
        text: "Cut p95 checkout latency by 40% with Postgres query plans and Redis caching.",
        facts: [key(1)],
        reasons: [],
        note: null,
      },
      {
        op: "add",
        after: id("Cut p95"),
        text: "Ran the ledger service on Docker with GitHub Actions deploys.",
        facts: [key(4)],
        reasons: ["R2", "R9"],
        note: null,
      },
    ]);
    expect(dropped.map((d) => d.reason)).toEqual(["uncited", "wrong_role", "duplicate"]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.reasons).toEqual(["R2"]);
  });

  test("a summary is checked against the CV's summary, roles and cited facts", () => {
    const ok = validate([
      {
        op: "summary",
        text: "Senior Backend Engineer with 6 years building payment services in Go and Postgres.",
        facts: [key(6)],
        reasons: ["R1"],
        note: null,
      },
    ]);
    expect(ok.dropped).toEqual([]);
    const bad = validate([
      { op: "summary", text: "Backend engineer with 9 years in Rust.", facts: [key(6)], reasons: [], note: null },
    ]);
    expect(bad.dropped.map((d) => d.reason)).toEqual(["unsupported"]);
  });
});

describe("applyEdits", () => {
  const all = (ops: TailorOp[]) => validate(ops).changes;

  test("with no change the body is the base", () => {
    expect(applyEdits({ base, changes: [] })).toBe(renderLines(base));
  });

  test("an undone change has no effect", () => {
    const changes = all([{ op: "remove", line: id("Blockchain"), reasons: [], note: null }]).map(
      (c): TailorChange => ({ ...c, status: "rejected" }),
    );
    expect(applyEdits({ base, changes })).toBe(renderLines(base));
  });

  test("order, reword, add after a removed anchor, and remove apply together", () => {
    const bullets = base.filter((l) => l.role === roleLine(1)).map((l) => l.id);
    const changes = all([
      {
        op: "order",
        parent: roleLine(1),
        lines: [bullets[1], bullets[0], bullets[2]] as string[],
        reasons: [],
        note: null,
      },
      reword(
        id("Cut p95"),
        "Improved checkout performance: cut p95 latency by 40% with Postgres query plans and Redis caching.",
      ),
      {
        op: "add",
        after: id("Moved the job queue"),
        text: "Ran the ledger service on Docker with GitHub Actions deploys.",
        facts: [key(4)],
        reasons: [],
        note: null,
      },
      { op: "remove", line: id("Moved the job queue"), reasons: [], note: null },
      { op: "remove", line: id("Blockchain"), reasons: [], note: null },
    ]);
    expect(changes).toHaveLength(5);
    const body = applyEdits({ base, changes });
    const role1 = body.slice(body.indexOf("### Senior"), body.indexOf("### Backend"));
    expect(role1.split("\n").slice(1, -2)).toEqual([
      "- Improved checkout performance: cut p95 latency by 40% with Postgres query plans and Redis caching. [FACT-1] [FACT-2]",
      "- Built a ledger service in Go that settles 2 million payments a day with no double charges. [FACT-3]",
      "- Ran the ledger service on Docker with GitHub Actions deploys. [FACT-4]",
    ]);
    expect(body).not.toContain("Blockchain");
    expect(changedText({ base, changes })).not.toContain("Built a ledger");
  });

  test("a summary replaces the CV's summary text", () => {
    const changes = all([
      {
        op: "summary",
        text: "Senior Backend Engineer with 6 years building payment services.",
        facts: [key(6)],
        reasons: [],
        note: null,
      },
    ]);
    const body = applyEdits({ base, changes });
    expect(
      body.startsWith(
        "## PROFESSIONAL SUMMARY\nSenior Backend Engineer with 6 years building payment services. [FACT-6]\n",
      ),
    ).toBe(true);
  });

  test("a summary is added under a new heading when the CV has none", () => {
    const noSummary = base.filter((l) => l.section !== "summary");
    const { changes } = validateEdits({
      base: noSummary,
      ops: [
        {
          op: "summary",
          text: "Backend engineer with 6 years building payment services.",
          facts: [key(6)],
          reasons: [],
          note: null,
        },
      ],
      facts: FACTS,
      protectedKeys: new Set(),
      requirementIds: new Set(),
      posting,
      contact,
    });
    expect(applyEdits({ base: noSummary, changes }).startsWith("## Summary\nBackend engineer")).toBe(true);
  });
});

describe("changeViews", () => {
  test("rows show before and after without markers, with reasons from the map", () => {
    const changes = validate([
      reword(
        id("Cut p95"),
        "Improved checkout performance: cut p95 latency by 40% with Postgres query plans and Redis caching.",
      ),
    ]).changes;
    const [view] = changeViews({
      tailoring: { base, changes },
      map: {
        role: "Backend Engineer",
        requirements: [{ id: "R1", text: "Performance", weight: "must", facts: [] }],
        context: [],
      },
    });
    expect(view?.before).toBe("Cut p95 checkout latency by 40% with Postgres query plans and Redis caching.");
    expect(view?.reasons).toEqual([{ id: "R1", text: "Performance" }]);
    expect(view?.where).toBe("Senior Backend Engineer, Paywise, Remote");
  });
});
