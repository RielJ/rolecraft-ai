import { afterEach, describe, expect, test } from "bun:test";
import { ScanNonce } from "@shared/extension";
import { Window } from "happy-dom";
import { createContentHandler } from "../src/content/index";

const nonce = ScanNonce.parse("answer-capture-nonce-00001");
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function page(label = "What is your ideal tech stack?") {
  const window = new Window({ url: "https://jobs.example/apply" });
  windows.push(window);
  window.document.write(
    `<form><label for="answer">${label}</label><textarea id="answer"></textarea><label for="other">Another question</label><textarea id="other">private unrelated text</textarea></form>`,
  );
  const document = window.document as unknown as Document;
  const handle = createContentHandler({ document, measure: () => null });
  const scanned = handle({ kind: "scan", nonce });
  if (scanned?.kind !== "scan_result") throw new Error("scan failed");
  const field = scanned.fields[0];
  if (field === undefined) throw new Error("no field");
  const input = window.document.querySelector("textarea");
  if (input === null) throw new Error("no input");
  return { handle, field, input, window };
}

describe("explicit answer capture", () => {
  test("scan never contains values; explicit read returns only the selected text", () => {
    const { handle, field, input } = page();
    input.value = "TypeScript and Postgres";
    expect(JSON.stringify(field)).not.toContain("TypeScript");
    expect(handle({ kind: "read_answer", nonce, field })).toEqual({
      kind: "answer_text",
      nonce,
      fieldId: field.fieldId,
      body: input.value,
    });
    expect(JSON.stringify(handle({ kind: "read_answer", nonce, field }))).not.toContain("private unrelated");
  });
  test("stale nonce or swapped field label cannot authorize a read", () => {
    const { handle, field } = page();
    expect(handle({ kind: "read_answer", nonce: "answer-capture-nonce-00002", field })).toMatchObject({
      kind: "answer_unavailable",
    });
    expect(handle({ kind: "read_answer", nonce, field: { ...field, label: "A different question" } })).toMatchObject({
      kind: "answer_unavailable",
    });
  });
  test("changed, readonly, hidden, removed, and oversized controls are refused", () => {
    for (const mutate of [
      (p: ReturnType<typeof page>) => p.input.setAttribute("readonly", ""),
      (p: ReturnType<typeof page>) => p.input.setAttribute("hidden", ""),
      (p: ReturnType<typeof page>) => p.input.remove(),
      (p: ReturnType<typeof page>) => {
        p.window.document.querySelector("label")?.replaceChildren("Expected salary");
      },
      (p: ReturnType<typeof page>) => {
        p.input.value = "x".repeat(10_001);
      },
    ]) {
      const p = page();
      mutate(p);
      expect(p.handle({ kind: "read_answer", nonce, field: p.field })).toMatchObject({ kind: "answer_unavailable" });
    }
  });
  test("sensitive questions and blocked hosts never disclose a value", () => {
    for (const label of ["Expected salary", "Your social security number", "Visa sponsorship details"]) {
      const { handle, field } = page(label);
      expect(handle({ kind: "read_answer", nonce, field })).toMatchObject({ kind: "answer_unavailable" });
    }
    const p = page();
    p.window.location.href = "https://www.linkedin.com/jobs/view/123";
    expect(p.handle({ kind: "read_answer", nonce, field: p.field })).toBeNull();
  });
});
