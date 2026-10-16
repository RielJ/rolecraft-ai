import { describe, expect, test } from "bun:test";
import { classifyQuestion } from "./must-answer";

describe("classifyQuestion", () => {
  const cases: [string, ReturnType<typeof classifyQuestion>][] = [
    ["What are your salary expectations?", "salary"],
    ["What is your expected rate for this contract?", "salary"],
    ["Please share your compensation requirements", "salary"],
    ["What is your pay expectation?", "salary"],
    ["Will you now or in the future require visa sponsorship?", "work_auth"],
    ["Are you authorized to work in the United States?", "work_auth"],
    ["Are you authorised to work in the UK?", "work_auth"],
    ["Do you have the right to work in Canada?", "work_auth"],
    ["Do you hold a valid work permit?", "work_auth"],
    ["What is your notice period?", "notice"],
    ["What is your earliest start date?", "start_date"],
    ["When can you start?", "start_date"],
    ["Can you provide two references?", "references"],
    ["Please list your referees", "references"],
    ["Why do you want to work at Acme?", null],
    ["Describe a hard bug you fixed", null],
    ["Tell us about a project that paid off", null],
  ];

  for (const [question, expected] of cases) {
    test(`${question} -> ${expected ?? "null"}`, () => {
      expect(classifyQuestion(question)).toBe(expected);
    });
  }
});
