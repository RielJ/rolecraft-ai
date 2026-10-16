import { describe, expect, test } from "bun:test";
import { contentHash, descriptionKey, normalize, sha256Hex, tokens } from "./text";

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
