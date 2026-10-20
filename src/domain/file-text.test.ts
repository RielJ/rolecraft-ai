import { describe, expect, test } from "bun:test";
import { cleanForEdit, fillBlanks, restoreMarkers, stripLeadingName, toPlainText } from "./file-text";

describe("toPlainText", () => {
  test("headings become plain lines with a blank line before them", () => {
    expect(toPlainText("Intro line.\n## Experience\n- Built X")).toBe("Intro line.\n\nExperience\n• Built X");
  });

  test("a heading on the first line gets no blank line before it", () => {
    expect(toPlainText("# Summary\nShipped things.")).toBe("Summary\nShipped things.");
  });

  test("a heading after a blank line gets only one blank line", () => {
    expect(toPlainText("Para.\n\n# Skills\n- Go")).toBe("Para.\n\nSkills\n• Go");
  });

  test("dash and star bullets become dots, keeping indentation", () => {
    expect(toPlainText("- One\n* Two\n  - Three")).toBe("• One\n• Two\n  • Three");
  });

  test("bold markup loses its asterisks", () => {
    expect(toPlainText("- **Acme** | Engineer\nI **led** it.")).toBe("• Acme | Engineer\nI led it.");
  });

  test("fact markers are removed", () => {
    expect(toPlainText("- Built the API [FACT-3].\nLed a team [FACT-1] [FACT-2].")).toBe(
      "• Built the API.\nLed a team.",
    );
  });

  test("blanks stay as written", () => {
    expect(toPlainText("- Led [[team size]] people [FACT-2]")).toBe("• Led [[team size]] people");
  });

  test("runs of blank lines collapse to one, and the ends are trimmed", () => {
    expect(toPlainText("\n\nOne.\n\n\n\nTwo.  \n\n")).toBe("One.\n\nTwo.");
  });

  test("a role header reads as one line: title, company, location and dates in brackets", () => {
    expect(
      toPlainText(
        "## Experience\n### Full-stack Software Engineer | Cashflowy, Remote | Jan, 2026 – Jun, 2026\n- Built X [FACT-1]",
      ),
    ).toBe("Experience\n\nFull-stack Software Engineer, Cashflowy, Remote (Jan, 2026 – Jun, 2026)\n• Built X");
    expect(toPlainText("### Software Engineer | CASHFLOWY, REMOTE | January 2026 – June 2026")).toBe(
      "Software Engineer, CASHFLOWY, REMOTE (January 2026 – June 2026)",
    );
    expect(toPlainText("### Software Engineer | Cashflowy")).toBe("Software Engineer, Cashflowy");
  });

  test("a project head reads as one line: name, link without its scheme, skills (decision 82)", () => {
    expect(toPlainText("## Projects\n#### Nyx | https://github.com/rielj/nyx | Go, Rust\nA CLI [FACT-1].")).toBe(
      "Projects\n\nNyx · github.com/rielj/nyx · Go, Rust\nA CLI.",
    );
    expect(toPlainText("#### Viem")).toBe("Viem");
  });

  test("numbered items stay as written", () => {
    expect(toPlainText("1. First\n2. Second")).toBe("1. First\n2. Second");
  });

  test("the output has no #, ** or FACT", () => {
    const out = toPlainText("# Juan\n## Experience\n- **Built** X [FACT-1]\n### Notes\nDone [FACT-2].");
    expect(out).not.toMatch(/#|\*\*|FACT/);
  });
});

describe("stripLeadingName", () => {
  test("drops a first heading that is the contact name, and the blank lines after it", () => {
    expect(stripLeadingName({ body: "# Juan Dela Cruz\n\n## Summary\nText.", name: "Juan Dela Cruz" })).toBe(
      "## Summary\nText.",
    );
  });

  test("matches regardless of case and spacing", () => {
    expect(stripLeadingName({ body: "#   juan  DELA cruz \nText.", name: " Juan Dela  Cruz" })).toBe("Text.");
  });

  test("leading blank lines before the heading are skipped", () => {
    expect(stripLeadingName({ body: "\n# Juan\nText.", name: "Juan" })).toBe("Text.");
  });

  test("a heading with markers or bold still matches", () => {
    expect(stripLeadingName({ body: "# **Juan** [FACT-1]\nText.", name: "Juan" })).toBe("Text.");
  });

  test("keeps a first heading that is not the name", () => {
    const body = "# Summary\nText.";
    expect(stripLeadingName({ body, name: "Juan" })).toBe(body);
  });

  test("keeps a name heading that is not the first line", () => {
    const body = "Intro.\n# Juan\nText.";
    expect(stripLeadingName({ body, name: "Juan" })).toBe(body);
  });

  test("only a level-one heading counts", () => {
    const body = "## Juan\nText.";
    expect(stripLeadingName({ body, name: "Juan" })).toBe(body);
  });

  test("an empty name drops nothing", () => {
    const body = "# \nText.";
    expect(stripLeadingName({ body, name: "  " })).toBe(body);
  });
});

describe("cleanForEdit", () => {
  test("removes markers and keeps blanks and Markdown", () => {
    expect(cleanForEdit("# Summary\n- Built X [FACT-1].\n- Led [[team size]] people [FACT-2][FACT-3]")).toBe(
      "# Summary\n- Built X.\n- Led [[team size]] people",
    );
  });
});

describe("restoreMarkers", () => {
  const before = "Built the API [FACT-1]. Led a team of 4 [FACT-2]. Moved to Postgres [FACT-3].";

  test("an untouched text gets every marker back", () => {
    expect(restoreMarkers({ before, edited: cleanForEdit(before) })).toBe(before);
  });

  test("reordered sentences keep their own markers", () => {
    expect(restoreMarkers({ before, edited: "Moved to Postgres. Built the API. Led a team of 4." })).toBe(
      "Moved to Postgres [FACT-3]. Built the API [FACT-1]. Led a team of 4 [FACT-2].",
    );
  });

  test("an edited sentence loses its markers, the rest keep theirs", () => {
    expect(restoreMarkers({ before, edited: "Built the API. Led a team of 5. Moved to Postgres." })).toBe(
      "Built the API [FACT-1]. Led a team of 5. Moved to Postgres [FACT-3].",
    );
  });

  test("a deleted sentence takes its markers with it", () => {
    expect(restoreMarkers({ before, edited: "Built the API. Moved to Postgres." })).toBe(
      "Built the API [FACT-1]. Moved to Postgres [FACT-3].",
    );
  });

  test("an added sentence gets no markers", () => {
    expect(restoreMarkers({ before, edited: "Built the API. I like Go. Led a team of 4. Moved to Postgres." })).toBe(
      "Built the API [FACT-1]. I like Go. Led a team of 4 [FACT-2]. Moved to Postgres [FACT-3].",
    );
  });

  test("Markdown lines keep their prefix and get their markers back", () => {
    const md = "# Summary\n- Built the API [FACT-1]\n- Led a team of 4 [FACT-2]";
    expect(restoreMarkers({ before: md, edited: "# Summary\n- Led a team of 4\n- Built the API\n- New line" })).toBe(
      "# Summary\n- Led a team of 4 [FACT-2]\n- Built the API [FACT-1]\n- New line",
    );
  });

  test("a marker in the middle of a sentence comes back where it was", () => {
    expect(restoreMarkers({ before: "Built X [FACT-1] and Y [FACT-2].", edited: "Intro. Built X and Y." })).toBe(
      "Intro. Built X [FACT-1] and Y [FACT-2].",
    );
  });

  test("a repeated sentence takes each original once, in order", () => {
    expect(restoreMarkers({ before: "- Done [FACT-1]\n- Done [FACT-2]", edited: "- Done\n- Done\n- Done" })).toBe(
      "- Done [FACT-1]\n- Done [FACT-2]\n- Done",
    );
  });

  test("spacing differences inside a sentence still match", () => {
    expect(restoreMarkers({ before: "Built the API [FACT-1].", edited: "Built  the API." })).toBe(
      "Built the API [FACT-1].",
    );
  });

  test("blanks in an unchanged sentence stay", () => {
    expect(restoreMarkers({ before: "Led [[team size]] people [FACT-2].", edited: "Led [[team size]] people." })).toBe(
      "Led [[team size]] people [FACT-2].",
    );
  });
});

describe("fillBlanks", () => {
  const check = '[[Check this: "Led 40 engineers" is not backed by your facts]]';
  const checkBlank = 'Check this: "Led 40 engineers" is not backed by your facts';

  test("a missing-info blank takes the value", () => {
    expect(
      fillBlanks({
        body: "- Worked at [[Employer for the 2019 role]] [FACT-1]",
        answers: [{ blank: "Employer for the 2019 role", value: "Acme" }],
        remove: [],
      }),
    ).toBe("- Worked at Acme [FACT-1]");
  });

  test("a Check this blank is replaced whole by the user's sentence", () => {
    expect(
      fillBlanks({
        body: `Built X [FACT-1]. ${check} Shipped Y [FACT-2].`,
        answers: [{ blank: checkBlank, value: "Led 4 engineers." }],
        remove: [],
      }),
    ).toBe("Built X [FACT-1]. Led 4 engineers. Shipped Y [FACT-2].");
  });

  test("remove drops the blank and its trailing space", () => {
    expect(fillBlanks({ body: `Built X [FACT-1]. ${check} Shipped Y.`, answers: [], remove: [checkBlank] })).toBe(
      "Built X [FACT-1]. Shipped Y.",
    );
  });

  test("remove at the end of a line drops the space before it instead", () => {
    expect(fillBlanks({ body: `Built X. ${check}\nNext.`, answers: [], remove: [checkBlank] })).toBe("Built X.\nNext.");
  });

  test("every copy of the same blank is filled", () => {
    expect(
      fillBlanks({ body: "[[city]] and [[city]]", answers: [{ blank: "city", value: "Manila" }], remove: [] }),
    ).toBe("Manila and Manila");
  });

  test("other blanks stay", () => {
    expect(fillBlanks({ body: "[[a]] [[b]]", answers: [{ blank: "a", value: "A" }], remove: [] })).toBe("A [[b]]");
  });

  test("a value is one line, trimmed, with no markers", () => {
    expect(
      fillBlanks({ body: "At [[x]].", answers: [{ blank: "x", value: "  Acme\nCorp [FACT-9] " }], remove: [] }),
    ).toBe("At Acme Corp.");
  });

  test("a value with $ patterns is inserted as written", () => {
    expect(fillBlanks({ body: "Pay [[pay]].", answers: [{ blank: "pay", value: "$& $1" }], remove: [] })).toBe(
      "Pay $& $1.",
    );
  });
});
