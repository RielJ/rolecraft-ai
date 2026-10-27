import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OutputId, TaskDto } from "@shared/api";
import { ApplicationSessionId, ExtensionOutputDto, FieldDescriptor, PairingId, ScanNonce } from "@shared/extension";
import { AnswerReferenceDto, type QuestionAnswerDto } from "@shared/extension-answers";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import type { PanelReply, PanelRequest, PanelResult } from "../src/messages";
import { QuestionAnswers, type QuestionAnswersProps } from "../src/panel/QuestionAnswers";

const sessionId = ApplicationSessionId.parse("11111111-1111-4111-8111-111111111111");
const nonce = ScanNonce.parse("22222222-2222-4222-8222-222222222222");
const outputId = OutputId.parse("33333333-3333-4333-8333-333333333333");
const field = FieldDescriptor.parse({
  fieldId: "question-1",
  control: "textarea",
  label: "Why would you like to join Acme?",
  autocomplete: null,
  name: null,
  required: true,
  options: [],
  adapterCategory: null,
});
const reference = AnswerReferenceDto.parse({
  id: "44444444-4444-4444-8444-444444444444",
  question: "Why would you like to join Acme?",
  body: "I like Acme's developer tools.",
  company: "Acme",
  updatedAt: "2026-10-22T00:00:00.000Z",
});
const reply = (result: PanelResult): PanelReply => ({
  status: {
    kind: "paired",
    endpoint: "http://localhost:3000",
    pairingId: PairingId.parse("55555555-5555-4555-8555-555555555555"),
  },
  error: null,
  result,
});
const question = (overrides: Partial<QuestionAnswerDto> = {}): QuestionAnswerDto => ({
  fieldId: field.fieldId,
  question: field.label,
  answer: null,
  references: [],
  ...overrides,
});
const output = ExtensionOutputDto.parse({
  id: outputId,
  kind: "answer",
  question: field.label,
  included: true,
  mustAnswer: null,
  generatedAt: null,
  editedAt: null,
  reviewedAt: null,
  outdated: false,
});
const task = TaskDto.parse({
  id: "66666666-6666-4666-8666-666666666666",
  kind: "draft",
  status: "running",
  step: "Checking facts",
  error: null,
  createdAt: "2026-10-22T00:00:00.000Z",
  finishedAt: null,
});

let window: Window;
let root: Root;
let container: HTMLElement;
const previous = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
  window = new Window();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React uses native DOM objects at runtime; create the host through the installed document.
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  previous.clear();
});

function setup({
  questions = [question()],
  fields = [field],
  disabled = false,
  respond,
}: {
  questions?: QuestionAnswerDto[];
  fields?: FieldDescriptor[];
  disabled?: boolean;
  respond?: (request: PanelRequest) => Promise<PanelReply>;
} = {}) {
  const requests: PanelRequest[] = [];
  const connections: PanelReply[] = [];
  const props: QuestionAnswersProps = {
    sessionId,
    tabId: 7,
    nonce,
    fields,
    disabled,
    onConnection: (value) => {
      connections.push(value);
    },
    send: async (request) => {
      requests.push(request);
      if (request.kind === "questions_lookup") return reply({ kind: "questions", data: { questions } });
      if (respond) return respond(request);
      throw new Error(`Unexpected request ${request.kind}`);
    },
  };
  const render = async (changes: Partial<QuestionAnswersProps> = {}, strict = false) => {
    Object.assign(props, changes);
    await act(async () =>
      root.render(
        strict
          ? createElement(StrictMode, {}, createElement(QuestionAnswers, props))
          : createElement(QuestionAnswers, props),
      ),
    );
  };
  return { requests, connections, render };
}
function button(text: string, index = 0): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).filter((item) => item.textContent === text)[index];
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
function textarea(index = 0): HTMLTextAreaElement {
  const found = container.querySelectorAll("textarea")[index];
  if (!found) throw new Error("Missing textarea");
  return found;
}
async function click(text: string, index = 0) {
  await act(async () => button(text, index).click());
}
async function edit(text: string, index = 0) {
  await act(async () => {
    const input = textarea(index);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing textarea setter");
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("custom question answers", () => {
  test("lookup is read-only and runs once under StrictMode; refs require selection and a separate fill click", async () => {
    const ui = setup({
      questions: [question({ references: [reference] })],
      respond: async (request) => {
        expect(request.kind).toBe("fill");
        return reply({ kind: "filled", result: { nonce, filled: [field.fieldId], skipped: [] } });
      },
    });
    await ui.render({}, true);
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup"]);
    expect(container.textContent).toContain("From Acme");
    expect(container.textContent).toContain(reference.question);
    expect(textarea().value).toBe("");
    expect(button("Fill this answer").disabled).toBe(true);
    await click("Use as starting point");
    expect(textarea().value).toBe(reference.body);
    expect(ui.requests).toHaveLength(1);
    await click("Fill this answer");
    expect(ui.requests[1]).toEqual({
      kind: "fill",
      tabId: 7,
      plan: { nonce, entries: [{ fieldId: field.fieldId, value: { kind: "text", text: reference.body } }] },
    });
    expect(container.textContent).toContain("Answer filled");
  });

  test("reading a typed answer never saves until the explicit Save reference click", async () => {
    const ui = setup({
      respond: async (request) =>
        request.kind === "answer_read"
          ? reply({ kind: "answer_read", fieldId: field.fieldId, body: "My typed answer" })
          : reply({ kind: "answer_reference", reference: { ...reference, body: "My typed answer" } }),
    });
    await ui.render();
    await click("Read from form");
    expect(textarea().value).toBe("My typed answer");
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "answer_read"]);
    await click("Save reference");
    expect(ui.requests[2]).toEqual({
      kind: "answer_reference_save",
      sessionId,
      input: { field, body: "My typed answer" },
    });
    expect(container.textContent).toContain("Reference saved");
    expect(ui.requests.some((request) => request.kind === "fill")).toBe(false);
  });

  test("outdated bodies and placeholders block fill until edited", async () => {
    const ui = setup({ questions: [question({ answer: { outputId, body: "Old answer", outdated: true } })] });
    await ui.render();
    expect(button("Fill this answer").disabled).toBe(true);
    await edit("My [[detail]]");
    expect(textarea().value).toBe("My [[detail]]");
    expect(button("Fill this answer").disabled).toBe(true);
    await edit("My verified detail");
    expect(button("Fill this answer").disabled).toBe(false);
  });

  test("disabled prevents lookup and all subsequent actions", async () => {
    const ui = setup({ disabled: true });
    await ui.render();
    expect(ui.requests).toHaveLength(0);
    await ui.render({ disabled: false });
    await ui.render({ disabled: true });
    for (const item of container.querySelectorAll("button")) expect(item.disabled).toBe(true);
    await click("Read from form");
    expect(ui.requests).toHaveLength(1);
  });

  test("shared policy excludes sensitive/pay/standard fields", async () => {
    const ui = setup({
      fields: [
        field,
        { ...field, fieldId: FieldDescriptor.shape.fieldId.parse("salary"), label: "Expected salary" },
        { ...field, fieldId: FieldDescriptor.shape.fieldId.parse("private"), label: "What is your passport number?" },
        {
          ...field,
          fieldId: FieldDescriptor.shape.fieldId.parse("standard"),
          label: "Email address",
          adapterCategory: "email",
        },
      ],
    });
    await ui.render();
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(ui.requests[0]).toEqual({ kind: "questions_lookup", sessionId, input: { fields: [field] } });
  });

  test("manual factual questions support saving but never offer generation", async () => {
    const factual = { ...field, label: "What is your current employer?" };
    const ui = setup({ fields: [factual] });
    await ui.render();
    expect(button("Read from form").disabled).toBe(false);
    expect(container.textContent).not.toContain("Generate draft");
    await edit("My employer");
    expect(button("Save reference").disabled).toBe(false);
  });

  test("generation polls once, refreshes only its answer and preserves another field's edit", async () => {
    const other = {
      ...field,
      fieldId: FieldDescriptor.shape.fieldId.parse("question-2"),
      label: "Describe your ideal role",
    };
    const questions = [question(), question({ fieldId: other.fieldId, question: other.label })];
    const ui = setup({
      fields: [field, other],
      questions,
      respond: async (request) => {
        if (request.kind === "question_create") return reply({ kind: "output", output });
        if (request.kind === "draft_start") return reply({ kind: "task", task });
        if (request.kind === "task_poll") {
          questions.splice(0, 1, question({ answer: { outputId, body: "A grounded draft", outdated: false } }));
          return reply({ kind: "task", task: { ...task, status: "done" } });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      },
    });
    await ui.render();
    await edit("Keep my edits", 1);
    await click("Generate draft");
    expect(container.textContent).toContain("Checking facts");
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "question_create", "draft_start"]);
    expect(ui.requests[2]).toEqual({ kind: "draft_start", sessionId, outputId, confirmOverCap: false });
    await act(async () => {
      await Bun.sleep(2100);
    });
    expect(ui.requests.map((request) => request.kind)).toEqual([
      "questions_lookup",
      "question_create",
      "draft_start",
      "task_poll",
      "questions_lookup",
    ]);
    expect(ui.requests[4]).toEqual({ kind: "questions_lookup", sessionId, input: { fields: [field] } });
    expect(textarea().value).toBe("A grounded draft");
    expect(textarea(1).value).toBe("Keep my edits");
    expect(container.textContent).toContain("Regenerate draft (replaces answer)");
    expect(ui.requests.some((request) => request.kind === "fill")).toBe(false);
  });

  test("over-cap errors are visible, duplicate clicks do not restart and spending is never auto-approved", async () => {
    const pending = Promise.withResolvers<PanelReply>();
    const ui = setup({
      respond: async (request) =>
        request.kind === "question_create"
          ? pending.promise
          : reply({ kind: "failed", code: "over_cap", message: "Your AI budget cap is reached." }),
    });
    await ui.render();
    await act(async () => {
      button("Generate draft").click();
      button("Generate draft").click();
    });
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "question_create"]);
    await act(async () => pending.resolve(reply({ kind: "output", output })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Your AI budget cap is reached.");
    expect(ui.requests).toHaveLength(3);
    expect(ui.requests[2]).toMatchObject({ kind: "draft_start", confirmOverCap: false });
    expect(container.textContent).not.toContain("Draft anyway");
  });

  test("disabling cancels polling, even after re-enabling", async () => {
    const ui = setup({
      respond: async (request) =>
        request.kind === "question_create" ? reply({ kind: "output", output }) : reply({ kind: "task", task }),
    });
    await ui.render();
    await click("Generate draft");
    await ui.render({ disabled: true });
    await ui.render({ disabled: false });
    await act(async () => {
      await Bun.sleep(2100);
    });
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "question_create", "draft_start"]);
    expect(button("Check draft progress").disabled).toBe(false);
    await click("Check draft progress");
    await act(async () => {
      await Bun.sleep(2100);
    });
    expect(ui.requests.filter((request) => request.kind === "task_poll")).toHaveLength(1);
    expect(ui.requests.filter((request) => request.kind === "draft_start")).toHaveLength(1);
  });

  test("unmount drops late replies, including connection callbacks", async () => {
    const pending = Promise.withResolvers<PanelReply>();
    const ui = setup({ respond: async () => pending.promise });
    await ui.render();
    await click("Generate draft");
    await act(async () => root.render(null));
    const before = ui.connections.length;
    await act(async () => pending.resolve(reply({ kind: "output", output })));
    expect(ui.connections).toHaveLength(before);
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "question_create"]);
  });

  test("lost connection replies notify the parent and show an error without starting further requests", async () => {
    const lost: PanelReply = { status: { kind: "unreachable", endpoint: "http://localhost:3000" }, error: null };
    const ui = setup({ respond: async () => lost });
    await ui.render();
    await click("Generate draft");
    expect(ui.connections.at(-1)).toEqual(lost);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("isn't connected");
    expect(ui.requests).toHaveLength(2);
  });

  test("existing answers never regenerate on mount and keep an explicit replacement label after clearing", async () => {
    const ui = setup({ questions: [question({ answer: { outputId, body: "My existing answer", outdated: false } })] });
    await ui.render();
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup"]);
    expect(button("Regenerate draft (replaces answer)").disabled).toBe(false);
    await edit("");
    expect(button("Regenerate draft (replaces answer)").disabled).toBe(false);
    expect(ui.requests).toHaveLength(1);
  });

  test("failed drafting shows the task error and never refreshes or fills", async () => {
    const ui = setup({
      respond: async (request) =>
        request.kind === "question_create"
          ? reply({ kind: "output", output })
          : reply({ kind: "task", task: { ...task, status: "failed", error: "No confirmed facts available" } }),
    });
    await ui.render();
    await click("Generate draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("No confirmed facts available");
    expect(ui.requests.map((request) => request.kind)).toEqual(["questions_lookup", "question_create", "draft_start"]);
    expect(textarea().value).toBe("");
  });

  test("fill skip reasons and failures remain visible", async () => {
    let fail = false;
    const ui = setup({
      questions: [question({ answer: { outputId, body: "Reviewed answer", outdated: false } })],
      respond: async () =>
        fail
          ? reply({ kind: "failed", code: "bad_response", message: "Try scanning again" })
          : reply({
              kind: "filled",
              result: { nonce, filled: [], skipped: [{ fieldId: field.fieldId, reason: "not_empty" }] },
            }),
    });
    await ui.render();
    await click("Fill this answer");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Already had a value");
    fail = true;
    await click("Fill this answer");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try scanning again");
  });
});
