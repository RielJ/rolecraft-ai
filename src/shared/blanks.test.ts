import { describe, expect, test } from "bun:test";
import { parseBlank } from "./blanks";

describe("parseBlank", () => {
  test("a Check this placeholder gives back its quoted sentence", () => {
    const blank = 'Check this: "Led 40 engineers at "Acme"" is not backed by your facts';
    expect(parseBlank(blank)).toEqual({ kind: "check", blank, sentence: 'Led 40 engineers at "Acme"' });
  });

  test("anything else is missing information labelled by its text", () => {
    expect(parseBlank(" Employer for the 2019 role ")).toEqual({
      kind: "missing",
      blank: " Employer for the 2019 role ",
      label: "Employer for the 2019 role",
    });
  });
});
