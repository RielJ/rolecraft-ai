import { describe, expect, test } from "bun:test";
import {
  type DraftProject,
  expandProjects,
  keyProjects,
  ownershipClaim,
  paragraphProjects,
  parseProjectHead,
  placeProjects,
  projectHead,
  projectHeadPlain,
  projectPromptLine,
  projectSectionOf,
} from "./draft-projects";

const NYX: DraftProject = {
  key: "PROJECT-1",
  name: "Nyx",
  link: "https://github.com/rielj/nyx",
  stack: ["Go", "TypeScript", "Tailwind CSS", "Rust"],
  role: "own",
};
const VIEM: DraftProject = { key: "PROJECT-2", name: "Viem", link: null, stack: [], role: "contribution" };
const NYX_HEAD = "#### Nyx | https://github.com/rielj/nyx";
const STACKED_HEAD = "#### Nyx | https://github.com/rielj/nyx | Go, TypeScript, Tailwind CSS";

describe("project heads (decisions 82 and 83)", () => {
  test("your own project's head is its name and public link: its paragraph names the stack", () => {
    expect(projectHead(NYX)).toBe(NYX_HEAD);
    expect(projectHead({ ...NYX, link: null })).toBe("#### Nyx");
  });

  test("a contribution's head adds up to 3 skills; parts it lacks are left out", () => {
    expect(projectHead({ ...NYX, role: "contribution" })).toBe(STACKED_HEAD);
    expect(projectHead(VIEM)).toBe("#### Viem");
    expect(projectHead({ name: "A | B", link: "not a link", stack: ["Go"], role: "contribution" })).toBe(
      "#### A / B | Go",
    );
  });

  test("a head parses back, and reads as one plain line", () => {
    expect(parseProjectHead(NYX_HEAD)).toEqual({ name: "Nyx", link: "https://github.com/rielj/nyx", stack: null });
    // Heads drafted before decision 83 list your own project's stack too.
    const head = parseProjectHead(STACKED_HEAD);
    expect(head).toEqual({ name: "Nyx", link: "https://github.com/rielj/nyx", stack: "Go, TypeScript, Tailwind CSS" });
    if (!head) throw new Error("no head");
    expect(projectHeadPlain(head)).toBe("Nyx · github.com/rielj/nyx · Go, TypeScript, Tailwind CSS");
    expect(parseProjectHead("#### Viem")).toEqual({ name: "Viem", link: null, stack: null });
    // The export stripped a URL that turned private.
    expect(parseProjectHead("#### Nyx | | Go")).toEqual({ name: "Nyx", link: null, stack: "Go" });
    expect(parseProjectHead("#### Nyx |")).toEqual({ name: "Nyx", link: null, stack: null });
    expect(parseProjectHead("### Engineer | Acme")).toBeNull();
    expect(parseProjectHead("#### a | b | c")).toBeNull();
  });

  test("the prompt line says whose project it is and your own project's stack, and no link to copy", () => {
    expect(projectPromptLine(NYX)).toBe("PROJECT-1: Nyx (your own project; stack: Go, TypeScript, Tailwind CSS, Rust)");
    expect(projectPromptLine({ ...NYX, stack: [] })).toBe("PROJECT-1: Nyx (your own project)");
    expect(projectPromptLine(VIEM)).toBe("PROJECT-2: Viem (a contribution to someone else's project)");
  });

  test("[PROJECT-n] lines become heads, also after a heading mark or in bold; unknown keys stay", () => {
    const body =
      "## Projects\n[PROJECT-1]\nCLI. [FACT-1]\n### [PROJECT-2]\n**[PROJECT-2]**\n[PROJECT-9]\nSee [PROJECT-1] here.";
    expect(expandProjects({ body, projects: [NYX, VIEM] }).split("\n")).toEqual([
      "## Projects",
      NYX_HEAD,
      "CLI. [FACT-1]",
      "#### Viem",
      "#### Viem",
      "[PROJECT-9]",
      "See [PROJECT-1] here.",
    ]);
  });

  test("sections: contributions, then projects; other headings are neither", () => {
    expect(projectSectionOf("## Open Source Contributions")).toBe("contribution");
    expect(projectSectionOf("## Projects")).toBe("own");
    expect(projectSectionOf("# Personal projects")).toBe("own");
    expect(projectSectionOf("## Experience")).toBeNull();
    expect(projectSectionOf("### Projects")).toBeNull();
  });
});

describe("paragraphProjects (decision 83)", () => {
  const CONTRIB: DraftProject = { ...VIEM, stack: ["TypeScript"] };
  const VIEM_HEAD = "#### Viem | TypeScript";

  test("your own project's lines and bullets become one paragraph; sentences keep their markers", () => {
    const body = [
      "## Projects",
      NYX_HEAD,
      "A terminal file manager [FACT-1].",
      "- Previews 40 file types [FACT-2]",
      "",
      "* Built in Go and Rust. [FACT-3]",
      "",
      "## Open Source Contributions",
      VIEM_HEAD,
      "- Added batching [FACT-4]",
      "- Fixed gas estimates [FACT-5]",
      "",
      "## Skills",
    ].join("\n");
    expect(paragraphProjects({ body, projects: [NYX, CONTRIB] }).split("\n")).toEqual([
      "## Projects",
      NYX_HEAD,
      "A terminal file manager [FACT-1]. Previews 40 file types [FACT-2]. Built in Go and Rust. [FACT-3]",
      "",
      "## Open Source Contributions",
      VIEM_HEAD,
      "- Added batching [FACT-4]",
      "- Fixed gas estimates [FACT-5]",
      "",
      "## Skills",
    ]);
  });

  test("a paragraph ends at the next project's head; a lone paragraph is left as written", () => {
    const other: DraftProject = { key: "PROJECT-3", name: "Kain", link: null, stack: [], role: "own" };
    const body = `${NYX_HEAD}\n- One [FACT-1]\n#### Kain\nAlready one paragraph. [FACT-2]\n`;
    expect(paragraphProjects({ body, projects: [NYX, other] })).toBe(
      `${NYX_HEAD}\nOne [FACT-1].\n\n#### Kain\nAlready one paragraph. [FACT-2]\n`,
    );
    const done = `${NYX_HEAD}\nOne. [FACT-1]\n\n## Skills\nGo`;
    expect(paragraphProjects({ body: done, projects: [NYX] })).toBe(done);
  });
});

describe("placeProjects", () => {
  const projects = [NYX, VIEM];

  test("projects already in place are untouched", () => {
    const body = `## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]\n\n## Open Source Contributions\n\n#### Viem\n- Fix. [FACT-2]`;
    expect(placeProjects({ body, projects })).toBe(body);
  });

  test("a contribution under Projects moves to a new Contributions section right after it", () => {
    const body = `## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]\n\n#### Viem\n- Fix. [FACT-2]\n\n## Education\n\nBS CS`;
    expect(placeProjects({ body, projects })).toBe(
      `## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]\n\n## Open Source Contributions\n\n#### Viem\n- Fix. [FACT-2]\n\n## Education\n\nBS CS`,
    );
  });

  test("an own project under Contributions moves to Projects, added before it; an emptied section goes", () => {
    const body = `## Experience\n\n### Dev | Acme\n- Work. [FACT-3]\n\n## Open Source Contributions\n\n${NYX_HEAD}\nCLI. [FACT-1]`;
    expect(placeProjects({ body, projects })).toBe(
      `## Experience\n\n### Dev | Acme\n- Work. [FACT-3]\n\n## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]`,
    );
  });

  test("with neither section, projects go before Skills; a block ends at a role header", () => {
    const body = `## Experience\n\n${NYX_HEAD}\nCLI. [FACT-1]\n### Dev | Acme\n- Work. [FACT-3]\n\n## Skills\n\nGo`;
    expect(placeProjects({ body, projects })).toBe(
      `## Experience\n\n### Dev | Acme\n- Work. [FACT-3]\n\n## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]\n\n## Skills\n\nGo`,
    );
  });

  test("moved projects join the end of an existing section in their order", () => {
    const body = `## Projects\n\n#### Viem\n- Fix. [FACT-2]\n\n## Open Source Contributions\n\n#### Other\n- x\n\n${NYX_HEAD}\nCLI. [FACT-1]`;
    const other: DraftProject = { key: "PROJECT-3", name: "Other", link: null, stack: [], role: "contribution" };
    expect(placeProjects({ body, projects: [...projects, other] })).toBe(
      `## Projects\n\n${NYX_HEAD}\nCLI. [FACT-1]\n\n## Open Source Contributions\n\n#### Other\n- x\n\n#### Viem\n- Fix. [FACT-2]`,
    );
  });
});

describe("keyProjects", () => {
  const info = new Map([
    ["nyx", { name: "Nyx", stack: ["Go", "TypeScript", "Tailwind CSS", "Rust"], role: "own" as const }],
    ["viem", { name: "Viem", stack: [], role: "contribution" as const }],
  ]);
  const fact = (itemId: string, link: string | null) => ({ itemId, link });

  test("keys projects in their first fact's order, marks facts, keeps facts from other items unkeyed", () => {
    const out = keyProjects({
      facts: [fact("cv", null), fact("viem", null), fact("nyx", "https://github.com/rielj/nyx"), fact("viem", null)],
      info,
    });
    expect(out.facts.map((f) => f.projectKey)).toEqual([null, "PROJECT-1", "PROJECT-2", "PROJECT-1"]);
    expect(out.projects).toEqual([
      { key: "PROJECT-1", name: "Viem", link: null, stack: [], role: "contribution" },
      {
        key: "PROJECT-2",
        name: "Nyx",
        link: "https://github.com/rielj/nyx",
        stack: ["Go", "TypeScript", "Tailwind CSS"],
        role: "own",
      },
    ]);
  });

  test("a project with any fact whose link was withheld (private) gets no link", () => {
    const out = keyProjects({ facts: [fact("nyx", "https://github.com/rielj/nyx"), fact("nyx", null)], info });
    expect(out.projects[0]?.link).toBeNull();
  });

  test("keying again after a cut leaves no gaps", () => {
    const first = keyProjects({ facts: [fact("viem", null), fact("nyx", null)], info });
    const again = keyProjects({ facts: first.facts.filter((f) => f.itemId === "nyx"), info });
    expect(again.facts.map((f) => f.projectKey)).toEqual(["PROJECT-1"]);
  });
});

describe("ownershipClaim", () => {
  const claim = (sentence: string, name = "Viem") => ownershipClaim({ sentence, name });

  test("saying the candidate made or owns the project is a claim", () => {
    expect(claim("I built Viem from scratch.")).toBe("built Viem");
    expect(claim("I built Viem and shipped it.")).toBe("built Viem");
    expect(claim("Created the open-source Viem library.")).toBe("Created the open-source Viem library");
    expect(claim("I own Viem.")).toBe("own Viem");
    expect(claim("Built my Viem alone.")).toBe("my Viem");
    expect(claim("Our Viem library \u2013 fast.")).toBe("Our Viem library");
    expect(claim("My project Viem sorts things.")).toBe("My project Viem");
    expect(claim("Viem, my side project, is fast.")).toBe("Viem, my side project");
    expect(claim("As the creator of Viem I ship.")).toBe("creator of Viem");
  });

  test("saying what the candidate did in it is not", () => {
    expect(claim("I built value support in Viem.")).toBeNull();
    expect(claim("I started contributing to Viem.")).toBeNull();
    expect(claim("Contributed deployContract value support to Viem.")).toBeNull();
    expect(claim("Built Viem's docs.")).toBeNull();
    expect(claim("Built the Viem CLI tool support.")).toBeNull();
    expect(claim("Built Next.js routing.", "Next.js")).toBeNull();
  });

  test("the name must stand alone, and an empty name never matches", () => {
    expect(claim("I built Viemish.")).toBeNull();
    expect(claim("Built my-viem.")).toBeNull();
    expect(claim("I built it.", "  ")).toBeNull();
  });
});
