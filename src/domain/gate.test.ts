import { describe, expect, test } from "bun:test";
import { FactKey, OutputId } from "@/shared/api";
import { checkGate, type GateOutput } from "./gate";

const id = (n: number) => OutputId.parse(`00000000-0000-4000-8000-00000000000${n}`);
const key = (n: number) => FactKey.parse(`FACT-${n}`);

function file(over: Partial<GateOutput> & Pick<GateOutput, "id">): GateOutput {
  return {
    kind: "resume",
    included: true,
    question: null,
    mustAnswer: null,
    body: "Built things [FACT-1].",
    citations: [],
    ...over,
  };
}

describe("checkGate", () => {
  test("passes when every included output is written and clean", () => {
    expect(
      checkGate({
        outputs: [file({ id: id(1) }), file({ id: id(2), kind: "letter", body: "Hello." })],
        standardAnswers: {},
      }),
    ).toEqual({ ok: true });
  });

  test("an unanswered must-answer question blocks", () => {
    const q = file({
      id: id(1),
      kind: "answer",
      question: "What are your salary expectations?",
      mustAnswer: "salary",
      body: null,
    });
    expect(checkGate({ outputs: [q], standardAnswers: {} })).toEqual({
      ok: false,
      blockers: [
        {
          kind: "must_answer",
          outputId: id(1),
          question: "What are your salary expectations?",
          category: "salary",
        },
      ],
    });
  });

  test("the profile's standard answer clears a must-answer question", () => {
    const q = file({ id: id(1), kind: "answer", question: "Salary?", mustAnswer: "salary", body: null });
    expect(checkGate({ outputs: [q], standardAnswers: { salary: "PHP 150,000 a month" } })).toEqual({
      ok: true,
    });
  });

  test("a whitespace-only answer or override still blocks", () => {
    const q = file({ id: id(1), kind: "answer", question: "Salary?", mustAnswer: "salary", body: "  " });
    const result = checkGate({ outputs: [q], standardAnswers: { salary: "PHP 150,000" } });
    expect(result.ok).toBe(false);

    const q2 = file({ id: id(2), kind: "answer", question: "Notice?", mustAnswer: "notice", body: null });
    expect(checkGate({ outputs: [q2], standardAnswers: { notice: " " } }).ok).toBe(false);
  });

  test("a per-job override answers it without a profile answer", () => {
    const q = file({ id: id(1), kind: "answer", question: "Salary?", mustAnswer: "salary", body: "USD 3k" });
    expect(checkGate({ outputs: [q], standardAnswers: {} })).toEqual({ ok: true });
  });

  test("a placeholder in an included body blocks, and unticking clears it", () => {
    const letter = file({ id: id(2), kind: "letter", body: "I led [[team size]] people." });
    expect(checkGate({ outputs: [file({ id: id(1) }), letter], standardAnswers: {} })).toEqual({
      ok: false,
      blockers: [{ kind: "placeholder", outputId: id(2), text: "team size" }],
    });
    expect(checkGate({ outputs: [file({ id: id(1) }), { ...letter, included: false }], standardAnswers: {} })).toEqual({
      ok: true,
    });
  });

  test("an included file with no body, or a blank body, is not drafted", () => {
    expect(
      checkGate({
        outputs: [file({ id: id(1), body: null }), file({ id: id(2), kind: "message", body: "\n " })],
        standardAnswers: {},
      }),
    ).toEqual({
      ok: false,
      blockers: [
        { kind: "not_drafted", outputId: id(1), outputKind: "resume" },
        { kind: "not_drafted", outputId: id(2), outputKind: "message" },
      ],
    });
  });

  test("suggested questions that were not added do not count", () => {
    const suggested = file({
      id: id(1),
      kind: "answer",
      included: false,
      question: "Salary?",
      mustAnswer: "salary",
      body: null,
    });
    expect(checkGate({ outputs: [suggested], standardAnswers: {} })).toEqual({ ok: true });
  });

  test("a citation of a deleted fact blocks", () => {
    const resume = file({
      id: id(1),
      citations: [
        { factKey: key(1), deleted: false },
        { factKey: key(12), deleted: true },
      ],
    });
    expect(checkGate({ outputs: [resume], standardAnswers: {} })).toEqual({
      ok: false,
      blockers: [{ kind: "deleted_fact", outputId: id(1), factKey: key(12) }],
    });
  });

  test("lists every blocker, one per problem", () => {
    const result = checkGate({
      outputs: [
        file({ id: id(1), body: "[[a]] and [[b]]" }),
        file({ id: id(2), kind: "answer", question: "Visa?", mustAnswer: "work_auth", body: null }),
      ],
      standardAnswers: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toEqual(["placeholder", "placeholder", "must_answer"]);
  });
});
