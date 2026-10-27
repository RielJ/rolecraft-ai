import { describe, expect, test } from "bun:test";
import { FieldDescriptor } from "@/shared/extension";
import {
  AnswerField,
  canDraftField,
  DraftAnswerField,
  isReferenceField,
  questionKey,
} from "@/shared/extension-answers";

const field = (label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor =>
  FieldDescriptor.parse({
    fieldId: "field-question-123",
    control: "textarea",
    label,
    autocomplete: null,
    name: null,
    required: true,
    options: [],
    adapterCategory: null,
    ...extra,
  });

describe("custom answer boundaries", () => {
  test("new scanned questions support explicit saving and drafting", () => {
    for (const label of [
      "What is your ideal tech stack?",
      "Tell us about a project you are proud of",
      "Why do you want to work at Owner?",
    ]) {
      expect(isReferenceField(field(label))).toBe(true);
      expect(canDraftField(field(label))).toBe(true);
    }
  });
  test("personal factual fields can be references but are never drafted", () => {
    for (const label of ["Current company", "Other websites", "When are you available to start?"]) {
      expect(isReferenceField(field(label))).toBe(true);
      expect(canDraftField(field(label))).toBe(false);
      expect(DraftAnswerField.safeParse(field(label)).success).toBe(false);
    }
  });
  test("pay, sensitive, secrets and standard fields cannot be captured as generic references", () => {
    for (const label of [
      "Expected salary",
      "Hourly rate",
      "Visa sponsorship",
      "Social security number",
      "Medical history",
      "Gender identity",
      "Your password",
      "Biological sex?",
      "Are you Hispanic or Latino?",
      "Are you authorized to work in Canada?",
      "Do you have the right to work?",
      "Email",
    ]) {
      expect(AnswerField.safeParse(field(label)).success).toBe(false);
    }
    expect(isReferenceField(field("Tell us more", { name: "salary_details" }))).toBe(false);
    expect(isReferenceField(field("Tell us more", { name: "desiredSalary" }))).toBe(false);
    expect(isReferenceField(field("Tell us more", { name: "workAuthorization" }))).toBe(false);
    expect(canDraftField(field("Tell us more", { name: "currentCompany" }))).toBe(false);
    expect(isReferenceField(field("First name", { autocomplete: "given-name" }))).toBe(false);
    expect(isReferenceField(field("Explain your experience", { adapterCategory: "full_name" }))).toBe(false);
  });
  test("short trimmed labels and short Unicode labels cannot reach the database length constraint", () => {
    expect(AnswerField.safeParse(field("  abc  ")).success).toBe(false);
    expect(AnswerField.safeParse(field("😀😀😀")).success).toBe(false);
  });
  test("only plain text inputs are eligible", () => {
    for (const control of ["file", "email", "tel", "url", "combobox", "select", "radio", "checkbox"] as const) {
      expect(isReferenceField(field("Explain your experience", { control }))).toBe(false);
    }
  });
  test("reference matching preserves company names and punctuation", () => {
    expect(questionKey("  What is\nYOUR stack?  ")).toBe(questionKey("What is your stack?"));
    expect(questionKey("Why Owner?")).not.toBe(questionKey("Why Deed?"));
    expect(questionKey("Experience with C++?")).not.toBe(questionKey("Experience with C#?"));
  });
});
