import { describe, expect, test } from "bun:test";
import type { FactKey } from "@/shared/api";
import { isUsableBase, mapFactsToLines, parseBaseCv, renderLines } from "./base-cv";
import { CV, ROLES } from "./base-cv.fixture";

const key = (n: number) => `FACT-${n}` as FactKey;

describe("parseBaseCv", () => {
  const lines = parseBaseCv({ text: CV, roles: ROLES });
  const byText = (start: string) => lines.find((l) => l.text.startsWith(start));

  test("lines before the first heading are contact", () => {
    expect(lines.slice(0, 3).map((l) => l.kind)).toEqual(["contact", "contact", "contact"]);
  });

  test("ids run in document order", () => {
    expect(lines.map((l) => l.id)).toEqual(lines.map((_, i) => `L${i + 1}`));
  });

  test("headings set the section", () => {
    expect(byText("Backend engineer with")?.section).toBe("summary");
    expect(byText("Blockchain")?.section).toBe("skills");
    expect(byText("B.S.")?.section).toBe("education");
  });

  test("a two-line role header is one role line with the server-written header", () => {
    const roles = lines.filter((l) => l.kind === "role");
    expect(roles.map((l) => l.text)).toEqual([
      "### Senior Backend Engineer | Paywise, Remote | Jan, 2023 – Mar, 2025",
      "### Backend Engineer | Shoply, Manila | Jun, 2020 – Dec, 2022",
    ]);
  });

  test("a wrapped bullet is joined, the mark dropped and the wording kept", () => {
    const ledger = byText("Built a ledger");
    expect(ledger?.kind).toBe("bullet");
    expect(ledger?.text).toBe(
      "Built a ledger service in Go that settles 2 million payments a day with no double charges.",
    );
  });

  test("the line after a lone bullet mark is a bullet", () => {
    expect(byText("Moved the job queue")?.kind).toBe("bullet");
  });

  test("bullets carry their role", () => {
    expect(byText("Cut p95")?.roleKey).toBe("ROLE-1");
    expect(byText("Wrote the order API")?.roleKey).toBe("ROLE-2");
    expect(byText("Fixed a race")?.roleKey).toBeNull();
  });

  test("a skills line ending in a comma takes its next line", () => {
    expect(byText("Languages")?.text).toBe("Languages: Go, TypeScript, Python, SQL");
  });

  test("a project name after a finished bullet, and a URL, are their own lines", () => {
    expect(byText("pg-tools")?.kind).toBe("text");
    expect(byText("https://")?.kind).toBe("text");
  });
});

describe("mapFactsToLines", () => {
  const lines = parseBaseCv({ text: CV, roles: ROLES });

  test("a fact goes to the bullet it was split from, in its role", () => {
    const { lines: mapped } = mapFactsToLines({
      lines,
      facts: [
        { key: key(1), text: "Cut p95 checkout latency by 40%.", roleKey: "ROLE-1" },
        { key: key(2), text: "Used Redis caching and Postgres query plans.", roleKey: "ROLE-1" },
      ],
    });
    expect(mapped.find((l) => l.text.startsWith("Cut p95"))?.facts).toEqual([key(1), key(2)]);
  });

  test("a number the line lacks keeps the fact off it", () => {
    const { extras } = mapFactsToLines({
      lines,
      facts: [{ key: key(3), text: "Cut p95 checkout latency by 60%.", roleKey: "ROLE-1" }],
    });
    expect(extras).toEqual([key(3)]);
  });

  test("a fact from another role, or from no line, is an extra", () => {
    const { extras } = mapFactsToLines({
      lines,
      facts: [
        { key: key(4), text: "Wrote the order API in TypeScript.", roleKey: "ROLE-1" },
        { key: key(5), text: "Maintains a Terraform module for EKS.", roleKey: null },
      ],
    });
    expect(extras).toEqual([key(4), key(5)]);
  });
});

describe("isUsableBase", () => {
  test("the CV is usable", () => {
    expect(isUsableBase({ lines: parseBaseCv({ text: CV, roles: ROLES }), roleCount: 2 })).toBe(true);
  });

  test("a plain paragraph is not", () => {
    const lines = parseBaseCv({ text: "I am an engineer who likes Go.", roles: ROLES });
    expect(isUsableBase({ lines, roleCount: 2 })).toBe(false);
  });

  test("a CV whose role header was not found is not", () => {
    const text = CV.replace("Paywise (Remote)", "A payments company");
    expect(isUsableBase({ lines: parseBaseCv({ text, roles: ROLES }), roleCount: 2 })).toBe(false);
  });
});

describe("renderLines", () => {
  test("contact is left out, headings and roles get a blank line, bullets their markers", () => {
    const { lines } = mapFactsToLines({
      lines: parseBaseCv({ text: CV, roles: ROLES }),
      facts: [{ key: key(1), text: "Wrote the order API in TypeScript.", roleKey: "ROLE-2" }],
    });
    const body = renderLines(lines);
    expect(body.startsWith("## PROFESSIONAL SUMMARY\n")).toBe(true);
    expect(body).not.toContain("alex@example.com");
    expect(body).toContain(
      "\n\n### Backend Engineer | Shoply, Manila | Jun, 2020 – Dec, 2022\n- Wrote the order API in TypeScript used by 3 mobile apps. [FACT-1]\n",
    );
  });
});
