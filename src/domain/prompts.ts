import type { FactKey, StyleHit } from "@/shared/api";
import type { ItemUsage, OpportunityType, OutputKind } from "@/shared/enums";
import type { DraftViolation } from "./citations";
import { styleHitLabel, VOICE_RULES } from "./style";

/** A confirmed fact as drafting sees it. */
export type PromptFact = { key: FactKey; text: string; link: string | null; usage: ItemUsage };

export type PromptMessage = { role: "user" | "assistant"; content: string };
export type Prompt = { system: string; messages: [PromptMessage, ...PromptMessage[]] };

export type DraftPosting = { title: string; company: string; description: string };

/** Output budget per kind. The estimate for the cap check uses the same numbers. */
export const DRAFT_MAX_TOKENS: Record<OutputKind, number> = {
  resume: 3000,
  letter: 1500,
  message: 1000,
  answer: 800,
};

/** Facts a kind may cite. Resumes leave out facts whose item is `letters_only` (section 3.4). */
export function allowedFacts<F extends Pick<PromptFact, "usage">>({
  kind,
  facts,
}: {
  kind: OutputKind;
  facts: readonly F[];
}): F[] {
  return kind === "resume" ? facts.filter((f) => f.usage !== "letters_only") : [...facts];
}

const FORMAT_RULES = [
  "Every sentence about the candidate ends with the [FACT-n] markers of the facts that support it, for example: I built the payments API in Go [FACT-3].",
  "Use only what the facts say. Do not add numbers, years, dates, employers, tools, links or titles that are not in the facts you cite.",
  "When something is needed but is not in the facts, write [[what is missing]] instead of guessing.",
  "Never mention salary, pay, rates, visa or work authorization, notice period, start date or references. The candidate answers those separately.",
  "Output plain Markdown using only # and ## headings, - bullets and **bold**. No tables, links, code blocks or preamble.",
];

function taskFor({
  kind,
  opportunityType,
  question,
}: {
  kind: OutputKind;
  opportunityType: OpportunityType;
  question: string | null;
}): string {
  switch (kind) {
    case "resume":
      return "Write a one-page resume tailored to this job. Start with # and the candidate's name, then ## sections such as Summary, Experience, Projects and Skills. Lead with the facts that matter most for this job. Bullets are short and concrete.";
    case "letter":
      return "Write a cover letter for this job in three or four short paragraphs. Say why this role, then what the candidate has done that fits it. End with a plain sign-off and the candidate's name.";
    case "message":
      return opportunityType === "contract"
        ? "Write a short proposal for this contract, under 200 words. Open with the client's problem in one sentence, then the relevant work the candidate has done, then how they would start."
        : "Write a short message to the hiring team, under 120 words, that the candidate can send through the job site or by email.";
    case "answer":
      return `Answer this application question in the candidate's voice, in under 150 words:\n${question ?? ""}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function factLines(facts: readonly PromptFact[]): string {
  if (facts.length === 0) return "(none yet)";
  return facts.map((f) => `${f.key}: ${f.text}${f.link ? ` (${f.link})` : ""}`).join("\n");
}

function systemPrompt(): string {
  return [
    "You write job application material for one candidate, using only facts they have confirmed.",
    "",
    "Rules:",
    ...FORMAT_RULES.map((r) => `- ${r}`),
    "",
    "Voice:",
    ...VOICE_RULES.map((r) => `- ${r}`),
  ].join("\n");
}

/**
 * The drafting prompt (section 3.4, step 2). Every confirmed fact the kind may cite is listed as
 * `FACT-n: text (link)`; the caller filters with `allowedFacts` first.
 */
export function buildDraftPrompt({
  kind,
  opportunityType,
  posting,
  candidateName,
  facts,
  question = null,
}: {
  kind: OutputKind;
  opportunityType: OpportunityType;
  posting: DraftPosting;
  candidateName: string;
  facts: readonly PromptFact[];
  question?: string | null;
}): Prompt {
  const user = [
    "JOB POSTING",
    `Title: ${posting.title}`,
    `Company: ${posting.company}`,
    "Description:",
    posting.description.trim(),
    "",
    `CANDIDATE: ${candidateName.trim() || "[[your name]]"}`,
    "",
    "FACTS",
    factLines(facts),
    "",
    "TASK",
    taskFor({ kind, opportunityType, question }),
    "Return only the text.",
  ].join("\n");
  return { system: systemPrompt(), messages: [{ role: "user", content: user }] };
}

function describeViolation(v: DraftViolation): string {
  switch (v.kind) {
    case "unknown_fact":
      return `"${v.sentence}" cites ${v.factKey}, which is not in the fact list.`;
    case "unsupported_token":
      return `"${v.sentence}" says ${v.tokens.map((t) => `"${t}"`).join(", ")}, which the facts it cites do not say.`;
    case "uncited_claim":
      return `"${v.sentence}" says ${v.tokens.map((t) => `"${t}"`).join(", ")} without a [FACT-n] marker.`;
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}

/** The one retry: the first prompt, the failed draft, and the violations to fix (section 3.4, step 4). */
export function buildRetryPrompt({
  prompt,
  draft,
  violations,
}: {
  prompt: Prompt;
  draft: string;
  violations: readonly DraftViolation[];
}): Prompt {
  const fix = [
    "Some sentences are not backed by the facts:",
    ...violations.map((v) => `- ${describeViolation(v)}`),
    "",
    "Rewrite the whole text. Remove or fix those sentences, using [[what is missing]] where a fact is needed. Return only the text.",
  ].join("\n");
  return {
    system: prompt.system,
    messages: [...prompt.messages, { role: "assistant", content: draft }, { role: "user", content: fix }],
  };
}

/**
 * The one style rewrite (section 3.4, step 4a): only the flagged sentences, each with what to fix.
 * The reply is JSON `{ "rewrites": string[] }`, one entry per sentence, in order.
 */
export function buildStyleRewritePrompt({
  sentences,
  facts,
}: {
  sentences: readonly { sentence: string; hits: readonly Pick<StyleHit, "rule" | "phrase">[] }[];
  facts: readonly PromptFact[];
}): Prompt {
  const user = [
    "FACTS",
    factLines(facts),
    "",
    "Rewrite each numbered sentence to fix the problems named under it. Keep its meaning, its [FACT-n] markers and any [[...]] placeholders. Add nothing the facts do not say.",
    "",
    ...sentences.flatMap((s, i) => [`${i + 1}. ${s.sentence}`, ...s.hits.map((h) => `   - ${styleHitLabel(h)}`)]),
    "",
    `Reply with JSON only: {"rewrites": ["sentence 1", ...]} with exactly ${sentences.length} strings, in the same order.`,
  ].join("\n");
  return { system: systemPrompt(), messages: [{ role: "user", content: user }] };
}

/** Model replies sometimes come wrapped in a code fence or with stray whitespace. */
export function cleanModelText(text: string): string {
  const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/** A rough token count (about four characters per token) for estimates before a call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function promptText(prompt: Prompt): string {
  return [prompt.system, ...prompt.messages.map((m) => m.content)].join("\n");
}

// ---------- Splitting an item into facts (section 3.3, step 2) ----------

/** Output budget for one split call. The cap estimate uses the same number. */
export const SPLIT_MAX_TOKENS = 3000;

export type SplitItem = { kindLabel: string; title: string; body: string; skills: readonly string[] };

const SPLIT_REPLY = 'Reply with JSON only: {"facts": [{"text": "..."}, ...]}';

/**
 * The light-tier split prompt. The item's text sits between `<<<` and `>>>`; the skills field is
 * context only, and every fact is later checked against the text alone.
 */
export function buildSplitPrompt({ item }: { item: SplitItem }): Prompt {
  const system = [
    "You turn one person's CV or profile entry into a list of short facts they can confirm.",
    "",
    "Rules:",
    "- One claim per fact: one thing they did, built, led, learned or achieved, with its result if the text gives one.",
    "- Keep their own words. Keep every number, name, tool, date and link exactly as written.",
    "- Add nothing the text does not say. Do not infer skills, years, titles or employers.",
    "- Skip headings and contact details (name, email, phone, address).",
    "- Write each fact as a plain sentence or phrase, without bullets or numbering.",
  ].join("\n");
  const skills = item.skills.length ? item.skills.join(", ") : "(none)";
  const user = [
    "ITEM",
    `Kind: ${item.kindLabel}`,
    `Title: ${item.title}`,
    `Skills the person listed (context only; a fact must still come from the text): ${skills}`,
    "Text:",
    "<<<",
    item.body.trim(),
    ">>>",
    "",
    "TASK",
    "Split the text into facts.",
    SPLIT_REPLY,
  ].join("\n");
  return { system, messages: [{ role: "user", content: user }] };
}

/** The one retry after a reply that was not the JSON asked for. */
export function buildSplitRetryPrompt({ prompt, reply }: { prompt: Prompt; reply: string }): Prompt {
  return {
    system: prompt.system,
    messages: [
      ...prompt.messages,
      { role: "assistant", content: reply },
      { role: "user", content: `That reply could not be read. ${SPLIT_REPLY}` },
    ],
  };
}

// ---------- AI eligibility (section 3.1 step 8, decision 31) ----------

/** Output budget for one eligibility call. The cap estimate uses the same number. */
export const ELIGIBILITY_MAX_TOKENS = 300;

/** Long postings are cut here; the phrase must still come from the text the model saw. */
export const ELIGIBILITY_DESCRIPTION_CHARS = 20_000;

export type EligibilityPosting = { title: string; company: string; locationText: string; description: string };

/**
 * The light-tier eligibility prompt, for jobs the rules left `unclear`. The answer is accepted
 * only when its phrase is copied word for word from the posting (`acceptAiVerdict`).
 */
export function buildEligibilityPrompt({ posting }: { posting: EligibilityPosting }): Prompt {
  const system = [
    "You decide whether a person living in the Philippines can be hired for a job posting.",
    "",
    "Verdicts:",
    "- ph: the posting names the Philippines (or a Philippine city) as a place it hires from.",
    "- worldwide: it hires from any country.",
    "- apac: it hires across Asia-Pacific or works on Asian time zones.",
    "- americas: it hires in the Americas or needs most of the day on American time zones.",
    "- excluded: it limits hiring to countries, states, regions, entities, citizenships, work permits or clearances that leave out the Philippines.",
    "- unclear: the posting does not say.",
    "",
    "Rules:",
    "- Decide only from the posting. Do not guess from the company's name or size.",
    '- "phrase" is the sentence or clause that decides it, copied exactly from the description, character for character. No paraphrase, no ellipsis.',
    "- If no part of the posting decides it, the verdict is unclear and the phrase is null.",
  ].join("\n");
  const description = posting.description.trim().slice(0, ELIGIBILITY_DESCRIPTION_CHARS);
  const user = [
    "JOB POSTING",
    `Title: ${posting.title}`,
    `Company: ${posting.company}`,
    `Location: ${posting.locationText.trim() || "(not given)"}`,
    "Description:",
    "<<<",
    description,
    ">>>",
    "",
    'Reply with JSON only: {"verdict": "ph" | "worldwide" | "apac" | "americas" | "excluded" | "unclear", "phrase": "..." | null}',
  ].join("\n");
  return { system, messages: [{ role: "user", content: user }] };
}

// ---------- Suggest questions (section 3.4) ----------

/** Output budget for one question-finding call. */
export const QUESTIONS_MAX_TOKENS = 800;

/** At most this many suggestions are kept from one reply. */
export const MAX_SUGGESTED_QUESTIONS = 15;

/** The light-tier prompt that finds application questions in a posting's text (decision 23). */
export function buildQuestionsPrompt({ posting }: { posting: DraftPosting }): Prompt {
  const system = [
    "You find the questions a job posting asks applicants to answer when they apply.",
    "",
    "Rules:",
    "- Only questions the posting itself asks or tells applicants to address, such as 'Tell us about a project you are proud of' or 'Include your salary expectations'.",
    "- Write each one as a question, close to the posting's wording.",
    "- Do not invent interview questions, and skip anything the posting does not ask.",
    "- Include questions about salary, visa or work authorization, notice period, start date and references when the posting asks them.",
    "- If the posting asks nothing, return an empty list.",
  ].join("\n");
  const user = [
    "JOB POSTING",
    `Title: ${posting.title}`,
    `Company: ${posting.company}`,
    "Description:",
    "<<<",
    posting.description.trim(),
    ">>>",
    "",
    'Reply with JSON only: {"questions": ["...", ...]}',
  ].join("\n");
  return { system, messages: [{ role: "user", content: user }] };
}
