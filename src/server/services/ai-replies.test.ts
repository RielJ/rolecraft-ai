import { describe, expect, test } from "bun:test";
import { createFakeAi } from "@/server/adapters/ai/fake";
import { parseTailorReply } from "./ai-replies";

describe("parseTailorReply (decision 75)", () => {
  test("reads every op shape and fills the defaults", () => {
    const reply = JSON.stringify({
      ops: [
        { op: "summary", text: "Backend engineer.", facts: ["FACT-1"], reasons: ["R1"] },
        { op: "order", parent: "L10", lines: ["L12", "L11"] },
        { op: "reword", line: "L11", text: "Built it." },
        { op: "remove", line: "L8", note: "Not asked for" },
        { op: "add", after: "L12", text: "Ran it.", facts: ["FACT-4"] },
      ],
    });
    const parsed = parseTailorReply(`\`\`\`json\n${reply}\n\`\`\``);
    expect(parsed?.unreadable).toBe(0);
    expect(parsed?.ops.map((o) => o.op)).toEqual(["summary", "order", "reword", "remove", "add"]);
    expect(parsed?.ops[2]).toEqual({
      op: "reword",
      line: "L11",
      text: "Built it.",
      facts: [],
      reasons: [],
      note: null,
    });
  });

  test("an op in no known shape is counted, not fatal", () => {
    const parsed = parseTailorReply(
      JSON.stringify({
        ops: [
          { op: "rewrite", line: "L1", text: "x" },
          { op: "reword", line: "11", text: "x" },
          { op: "add", after: "L2", text: "x", facts: ["fact 1"] },
          { op: "remove", line: "L3" },
        ],
      }),
    );
    expect(parsed?.unreadable).toBe(3);
    expect(parsed?.ops).toHaveLength(1);
  });

  test("a reply that is not {ops: [...]} is null", () => {
    expect(parseTailorReply("Here are my edits")).toBeNull();
    expect(parseTailorReply('{"edits": []}')).toBeNull();
  });
});

describe("fake AI tailor lane", () => {
  test("tailor requests use their own queue; the default with no CV lines is no edits", async () => {
    const ai = createFakeAi();
    ai.queue("a draft");
    const ask = (content: string) =>
      ai.complete({
        key: "k",
        model: "m",
        tier: "writing",
        system: "",
        messages: [{ role: "user", content }],
        maxOutputTokens: 10,
      });
    expect((await ask('Reply with JSON only: {"ops": [...]}, using these shapes:')).text).toBe('{"ops":[]}');
    ai.queueTailor('{"ops": [{"op": "remove", "line": "L3"}]}');
    expect((await ask('Reply with JSON only: {"ops": [...]}')).text).toContain("remove");
    expect(ai.tailorCalls).toHaveLength(2);
    expect(ai.calls).toHaveLength(0);
  });
});
