import { describe, expect, test } from "bun:test";
import { postingBlocks } from "@/shared/posting-blocks";

describe("postingBlocks: plain posting text into paragraphs, headings and lists", () => {
  test("blank lines split paragraphs; single newlines inside one stay as line breaks", () => {
    expect(postingBlocks("We build tools.\nFor designers.\n\nJoin us at Figma!")).toEqual([
      { kind: "paragraph", text: "We build tools.\nFor designers." },
      { kind: "paragraph", text: "Join us at Figma!" },
    ]);
  });

  test("a short line ending in a colon is a heading, and the bullets after it a list", () => {
    const text = "What you'll do at Figma:\n\n- Build Dev Mode\n- Mentor peers\n\n• Ship\n* Learn";
    expect(postingBlocks(text)).toEqual([
      { kind: "heading", text: "What you'll do at Figma" },
      { kind: "list", ordered: false, items: ["Build Dev Mode", "Mentor peers"] },
      { kind: "list", ordered: false, items: ["Ship", "Learn"] },
    ]);
  });

  test("a heading line directly above its bullets, numbered lists, and a short title line", () => {
    expect(postingBlocks("Requirements\n1. Go\n2) TypeScript\n\nNice to have:\n– Rust")).toEqual([
      { kind: "heading", text: "Requirements" },
      { kind: "list", ordered: true, items: ["Go", "TypeScript"] },
      { kind: "heading", text: "Nice to have" },
      { kind: "list", ordered: false, items: ["Rust"] },
    ]);
  });

  test("text after a list in the same block is its own paragraph; a wrapped bullet keeps going", () => {
    expect(postingBlocks("- Build APIs\n  in Go and Rust\n- Own on-call\nWe pay well.")).toEqual([
      { kind: "list", ordered: false, items: ["Build APIs in Go and Rust", "Own on-call"] },
      { kind: "paragraph", text: "We pay well." },
    ]);
  });

  test("sentences stay paragraphs: punctuation at the end, or too long for a heading", () => {
    const long = "We are an equal opportunity employer and value diversity at our company";
    expect(postingBlocks(`Remote, worldwide.\n\n${long}\n\nJoin us!`)).toEqual([
      { kind: "paragraph", text: "Remote, worldwide." },
      { kind: "paragraph", text: long },
      { kind: "paragraph", text: "Join us!" },
    ]);
  });

  test("Windows line endings, stray spaces and empty input", () => {
    expect(postingBlocks("About us:\r\n\r\n   Hello there.  \r\n")).toEqual([
      { kind: "heading", text: "About us" },
      { kind: "paragraph", text: "Hello there." },
    ]);
    expect(postingBlocks("  \n\n ")).toEqual([]);
  });
});
