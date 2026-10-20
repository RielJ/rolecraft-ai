import { describe, expect, test } from "bun:test";
import { diffFacts, dropRepeats } from "./facts-diff";

const existing = [
  { id: 1, text: "Built a payments API in Go", status: "confirmed" as const },
  { id: 2, text: "Led a team of 4 engineers", status: "confirmed" as const },
  { id: 3, text: "Wrote the on-call runbook", status: "pending" as const },
  { id: 4, text: "Moved the job queue to Postgres", status: "pending" as const },
];

describe("diffFacts", () => {
  test("re-import with edited lines: unchanged kept, new pending, vanished pending removed, vanished confirmed listed", () => {
    const diff = diffFacts({
      existing,
      candidates: [
        "Built a payments API in Go",
        "Led a team of 5 engineers",
        "Wrote the on-call runbook and the incident guide",
        "Moved the job queue to Postgres",
      ],
    });
    expect(diff).toEqual({
      unchanged: [1, 4],
      added: ["Led a team of 5 engineers", "Wrote the on-call runbook and the incident guide"],
      removed: [3],
      vanished: [2],
    });
  });

  test("case, whitespace and punctuation changes match the same fact", () => {
    const diff = diffFacts({
      existing,
      candidates: ["built a payments  API in Go.", "LED A TEAM OF 4 ENGINEERS", "Wrote the on-call runbook!"],
    });
    expect(diff.unchanged).toEqual([1, 2, 3]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([4]);
    expect(diff.vanished).toEqual([]);
  });

  test("duplicate and blank candidates are added once, trimmed", () => {
    const diff = diffFacts({ existing: [], candidates: ["  Shipped v2 ", "shipped v2", "", " ... "] });
    expect(diff).toEqual({ unchanged: [], added: ["Shipped v2"], removed: [], vanished: [] });
  });

  test("an empty split keeps confirmed facts and removes pending ones", () => {
    const diff = diffFacts({ existing, candidates: [] });
    expect(diff).toEqual({ unchanged: [], added: [], removed: [3, 4], vanished: [1, 2] });
  });
});

describe("dropRepeats", () => {
  test("a new fact the add-on's own facts already say is dropped", () => {
    const out = dropRepeats({
      candidates: [
        "Recipe planner for carinderias.",
        "Prices each dish from the day's market costs.",
        "A recipe planner for carinderias, written in Go.",
      ],
      others: ["Recipe planner for carinderias."],
    });
    expect(out).toEqual({
      kept: ["Prices each dish from the day's market costs.", "A recipe planner for carinderias, written in Go."],
      repeats: ["Recipe planner for carinderias."],
    });
  });

  test("a later fact of the same read that an earlier one says is dropped; a new number is not a repeat", () => {
    const out = dropRepeats({
      candidates: [
        "Plans jeepney trips across 42 routes from the city's open data.",
        "Plans jeepney trips across 42 routes.",
        "Plans jeepney trips across 43 routes.",
      ],
      others: [],
    });
    expect(out.kept).toEqual([
      "Plans jeepney trips across 42 routes from the city's open data.",
      "Plans jeepney trips across 43 routes.",
    ]);
    expect(out.repeats).toEqual(["Plans jeepney trips across 42 routes."]);
  });
});
