import { describe, expect, test } from "bun:test";
import {
  contentHash,
  descriptionKey,
  htmlToText,
  normalize,
  sentenceSpans,
  sentencesOf,
  sha256Hex,
  tokens,
  wordCount,
} from "./text";

describe("normalize", () => {
  test("lowercases, drops punctuation, collapses whitespace", () => {
    expect(normalize("  Led a TEAM,   of 4!\n")).toBe("led a team of 4");
  });
  test("keeps non-Latin letters and digits", () => {
    expect(normalize("Café — Ñandú 2023")).toBe("café ñandú 2023");
  });
});

describe("tokens", () => {
  test("splits normalized text into words", () => {
    expect(tokens("Sr. Frontend-Engineer")).toEqual(["sr", "frontend", "engineer"]);
  });
});

describe("sha256Hex", () => {
  test("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(sha256Hex("Ñandú")).toBe(new Bun.CryptoHasher("sha256").update("Ñandú").digest("hex"));
  });
});

describe("descriptionKey", () => {
  test("ignores case, spacing, URLs and dates", () => {
    const a = "Build APIs.\nApply at https://x.com/jobs?utm_source=a  Posted 2026-10-01";
    const b = "build   apis. apply at https://y.com/other posted 2026-09-12";
    expect(descriptionKey(a)).toBe(descriptionKey(b));
  });
  test("differs when the words differ", () => {
    expect(descriptionKey("Build APIs")).not.toBe(descriptionKey("Build UIs"));
  });
});

describe("contentHash", () => {
  test("changes when any field changes", () => {
    const base = { title: "Engineer", company: "Acme", locationText: "", description: "x", payPhrase: null };
    expect(contentHash(base)).toBe(contentHash({ ...base }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, payPhrase: "$5k" }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, title: "Engineer II" }));
  });
});

describe("sentenceSpans", () => {
  test("splits prose at sentence ends and keeps markers with their sentence", () => {
    const body = "I build APIs [FACT-1]. I led a team [FACT-2][FACT-3]. Then 2.5M users joined.";
    expect(sentenceSpans(body).map((s) => s.text)).toEqual([
      "I build APIs [FACT-1].",
      "I led a team [FACT-2][FACT-3].",
      "Then 2.5M users joined.",
    ]);
  });

  test("a marker after the full stop stays with the sentence", () => {
    expect(sentenceSpans("I build APIs. [FACT-1] Next one.").map((s) => s.text)).toEqual([
      "I build APIs. [FACT-1]",
      "Next one.",
    ]);
  });

  test("Markdown lines are units without their prefix, and offsets point into the body", () => {
    const body = "# Summary\n- Led a team [FACT-2]\n1. Shipped it";
    const spans = sentenceSpans(body);
    expect(spans.map((s) => s.text)).toEqual(["Summary", "Led a team [FACT-2]", "Shipped it"]);
    for (const s of spans) expect(body.slice(s.start, s.end)).toBe(s.text);
  });
});

describe("wordCount", () => {
  test("counts words, not markers or punctuation", () => {
    expect(wordCount("I built it - fast, really.")).toBe(5);
  });
});

describe("htmlToText", () => {
  test("keeps paragraph and list breaks and drops tags, scripts and styles", () => {
    const html =
      "<style>p{}</style><h2>About</h2><p>We build <b>APIs</b>.<br>Remote&nbsp;first.</p><ul><li>Go</li><li>Postgres &amp; Redis</li></ul><p>Apply now</p><script>x()</script>";
    expect(htmlToText(html)).toBe("About\n\nWe build APIs.\nRemote first.\n\n- Go\n- Postgres & Redis\n\nApply now");
  });
  test("decodes entity-escaped HTML, as JSON-LD descriptions often are", () => {
    expect(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;p&gt;Next&lt;/p&gt;")).toBe(
      "Hello & welcome\n\nNext",
    );
  });
  test("handles upper-case tags and numeric references", () => {
    expect(htmlToText("<DIV>One</DIV><DIV>Caf&#233; &#x2014; two</DIV>")).toBe("One\n\nCafé — two");
  });
});

describe("sentencesOf", () => {
  test("splits at lines and sentence ends and drops bullets", () => {
    expect(sentencesOf("Remote (US only). We pay well.\n- Must live in Canada")).toEqual([
      "Remote (US only).",
      "We pay well.",
      "Must live in Canada",
    ]);
  });
});
