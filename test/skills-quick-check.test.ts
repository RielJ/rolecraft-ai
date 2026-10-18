import { describe, expect, test } from "bun:test";
import { compileSkills, extractSkills, foldCase } from "@/domain/features";
import { CUSTOM_SKILLS, skillTexts } from "./fixtures/skill-texts";

/*
 * The quick-check (decision 68): before each regex, `extractSkills` asks whether the folded text
 * contains the pattern's literal, and skips the regex when it does not. It may only skip work:
 * with it on or off, every text must name the same skills.
 */

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Names of the user's own with letters outside ASCII, beside the fixture list. */
const NON_ASCII_SKILLS = ["Ñandú", "Straße", "Ελλάς", "Café au lait", "İzmir", "µVision", "Ångström", "Kelvin"];

const TRICKY = [
  "C++ and C# on .NET 8, ASP.NET Core, dotnet CLI",
  "We use C, not C++; c# is fine. C++/CLI too.",
  "Node.js, nodejs, Node, node.jsx, Node.JS and NODE",
  "CI/CD with GitHub Actions; ci/cd; CI / CD",
  "React/Redux, AWS/GCP, containers/Kubernetes, Power BI/Tableau, x.com/temporal",
  "Spark joy. Spark Capital and Apache Spark. spark sql",
  "Palantir Foundry; Foundry is our lab; we use Foundry daily",
  "JavaScript, JAVASCRIPT, javascript, JavaſCript, ECMAScript",
  // The Kelvin sign (U+212A) and the long s (U+017F) fold to K and s in a case-insensitive regex.
  "KUBERNETES, \u212Aubernetes, Po\u017Ftgres, Ha\u017Fura",
  "ÑANDÚ, ñandú, STRASSE, Straße, STRAẞE, ΕΛΛΆΣ, ελλάς, ΕΛΛΆΣ.",
  "CAFÉ AU LAIT, café  au\nlait, İZMİR, İzmir, izmir, µvision, μVISION, ÅNGSTRÖM, \u212Bngström",
  "Temporal, TEMPORAL, temporal-io, Temporal.io, Temporals, Hasura's, hasura_cli",
  "Zig, ZIG, zig, Elm, elm. OCaml/ocaml, tRPC TRPC, dbt Cloud, DBT CLOUD",
  "",
  "   ",
  "🚀 TypeScript🚀 Rust! Go? Swift.",
];

describe("the quick-check gives identical output", () => {
  const dicts = [compileSkills([]), compileSkills(CUSTOM_SKILLS), compileSkills(NON_ASCII_SKILLS)];

  test("on the fixture texts and the tricky strings", () => {
    const texts = [...skillTexts({ count: 200, bytes: 8192 }), ...TRICKY];
    let compared = 0;
    for (const dict of dicts) {
      for (const text of texts) {
        expect(extractSkills(text, dict)).toEqual(extractSkills(text, dict, { quickCheck: false }));
        compared++;
      }
    }
    expect(compared).toBe(dicts.length * texts.length);
  });

  test("the tricky strings name what they should", () => {
    const all = compileSkills([...CUSTOM_SKILLS, ...NON_ASCII_SKILLS]);
    const read = (text: string) => extractSkills(text, all);
    expect(read(TRICKY[0] ?? "")).toEqual(["C#", "C++", ".NET"]);
    expect(read(TRICKY[1] ?? "")).toEqual(["C#", "C++"]);
    expect(read(TRICKY[8] ?? "")).toEqual(["PostgreSQL", "Kubernetes", "Hasura"]);
    expect(read("ÑANDÚ and STRAẞE")).toEqual(["Ñandú", "Straße"]);
    expect(read("café  au\nlait")).toEqual(["Café au lait"]);
    expect(read("ΕΛΛΆΣ.")).toEqual(["Ελλάς"]);
  });

  test("each pattern's literal is in the folded text of every text it matches", () => {
    for (const dict of dicts) {
      for (const { re, literal } of dict.patterns) {
        for (const text of TRICKY) if (re.test(text)) expect(foldCase(text)).toContain(literal);
      }
    }
  });
});

describe("foldCase", () => {
  test("two characters a case-insensitive regex treats as one fold the same", () => {
    // Every code point against its upper and lower forms: where `/c/iu` matches d, both fold alike.
    // Plain toLowerCase misses 22 of them (µ, ſ, ς, ϐ, ϑ, ...), so foldCase maps those too.
    const broken: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const forms = [c.toLowerCase(), c.toUpperCase(), c.toLowerCase().toUpperCase(), c.toUpperCase().toLowerCase()];
      const others = new Set(forms.filter((d) => d !== c && [...d].length === 1));
      if (others.size === 0) continue;
      const re = new RegExp(`^${escapeRegExp(c)}$`, "iu");
      for (const d of others) if (re.test(d) && foldCase(c) !== foldCase(d)) broken.push(`U+${cp.toString(16)}`);
    }
    expect(broken).toEqual([]);
  });

  test("a final sigma folds like any sigma", () => {
    expect(foldCase("ΣΑΣ")).toBe(foldCase("σασ"));
    expect(foldCase("σας")).toBe("σασ");
  });
});
