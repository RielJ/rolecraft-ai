import { estimateTokens } from "@/domain/prompts";
import { splitFacts } from "@/domain/split";
import { sentenceSpans } from "@/domain/text";
import { type AiCompletion, type AiCompletionRequest, AiError, type AiProviderClient } from "./types";

/** A queued reply: text, a function of the request, or an error to throw. */
export type FakeReply = string | AiError | ((request: AiCompletionRequest) => string);

export type FakeAi = AiProviderClient & {
  /** Queue replies. Each call takes the next one; an empty queue falls back to the default writer. */
  queue(...replies: FakeReply[]): void;
  /** Every request seen, oldest first. */
  readonly calls: AiCompletionRequest[];
  reset(): void;
};

const FACT_LINE = /^(FACT-[1-9]\d*): (.*?)(?: \(([^)]*)\))?$/gm;

/** Cite each sentence of a fact with its own key, so the default draft always passes checkDraft. */
function citedSentences(key: string, text: string): string[] {
  return sentenceSpans(text).map((s) => `${s.text.replace(/[.!?]+$/, "")} [${key}].`);
}

/** A plausible draft built only from the prompt's fact lines. */
function defaultDraft(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const name = /^CANDIDATE: (.*)$/m.exec(prompt)?.[1] ?? "[[your name]]";
  const facts = Array.from(prompt.matchAll(FACT_LINE), (m) => citedSentences(m[1] ?? "", m[2] ?? "")).flat();
  if (facts.length === 0) return "[[your experience for this role]]";
  if (/one-page resume/.test(prompt)) {
    return [`# ${name}`, "## Experience", ...facts.map((f) => `- ${f}`)].join("\n");
  }
  return [facts.join(" "), "", name].join("\n");
}

/** Echo each numbered sentence back, so the default style rewrite changes nothing. */
function defaultRewrite(request: AiCompletionRequest): string {
  const prompt = request.messages.at(-1)?.content ?? "";
  const sentences = Array.from(prompt.matchAll(/^\d+\. (.*)$/gm), (m) => m[1] ?? "");
  return JSON.stringify({ rewrites: sentences });
}

/** Split the item text between `<<<` and `>>>` by rule, so the default split equals the rule splitter. */
function defaultSplit(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const text = /^<<<\n([\s\S]*?)\n>>>$/m.exec(prompt)?.[1] ?? "";
  return JSON.stringify({ facts: splitFacts({ text }).map((t) => ({ text: t })) });
}

/** The posting text between `<<<` and `>>>`. */
function postingText(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  return /^<<<\n([\s\S]*?)\n>>>$/m.exec(prompt)?.[1] ?? "";
}

/** Every sentence of the posting that ends in a question mark, as asked. */
function defaultQuestions(request: AiCompletionRequest): string {
  const questions = sentenceSpans(postingText(request))
    .map((s) => s.text.trim())
    .filter((s) => s.endsWith("?"));
  return JSON.stringify({ questions });
}

/** The body of the `<<< LABEL` data block, or "". */
function dataBlock(prompt: string, label: string): string {
  const start = prompt.indexOf(`\n<<< ${label}`);
  if (start < 0) return "";
  const body = prompt.slice(prompt.indexOf("\n", start + 1) + 1);
  const end = body.indexOf("\n>>>");
  return end < 0 ? body : body.slice(0, end);
}

/** GitHub picks: the first two tree paths not read yet that are not tests or docs. */
function defaultGithubPicks(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const already = new Set((/^Already read: (.*)$/m.exec(prompt)?.[1] ?? "").split(", "));
  const files = dataBlock(prompt, "TREE")
    .split("\n")
    .filter((p) => p !== "" && !already.has(p) && !/(^|\/)(test|tests|docs)\//.test(p) && !/\.md$/i.test(p))
    .slice(0, 2);
  return JSON.stringify({ files });
}

/**
 * GitHub facts: one per commit (its subject, citing its sha), plus the README's first plain
 * sentence citing the README. Everything comes from the data, so every fact passes the checks.
 */
function defaultGithubFacts(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const user = /^PERSON: (.*)$/m.exec(prompt)?.[1] ?? "";
  const commits = dataBlock(prompt, `COMMITS BY ${user}`)
    .split("\n")
    .flatMap((line) => {
      const m = /^([0-9a-f]{7,40}) (.+)$/.exec(line);
      return m ? [{ text: m[2] ?? "", evidence: m[1] ?? "" }] : [];
    });
  const readmeLabel = /^<<< (FILE README[^\n(]*?)(?: \(cut short\))?$/m.exec(prompt)?.[1];
  const readme = readmeLabel ? dataBlock(prompt, readmeLabel) : "";
  const line = readme.split("\n").find((l) => l.trim() !== "" && !/^[#>!<[|`-]/.test(l.trim()));
  const first = line ? sentenceSpans(line)[0]?.text.trim() : undefined;
  const facts = [...(first && readmeLabel ? [{ text: first, evidence: readmeLabel.slice(5) }] : []), ...commits];
  return JSON.stringify({ facts });
}

/** Which default writer answers a request, from what its last message asks for. */
function defaultReply(request: AiCompletionRequest): string {
  const last = request.messages.at(-1)?.content ?? "";
  // Eligibility: the fake never guesses, so a job the rules left unclear stays unclear.
  if (last.includes('{"verdict"')) return JSON.stringify({ verdict: "unclear", phrase: null });
  if (last.includes('{"questions"')) return defaultQuestions(request);
  if (last.includes('{"rewrites"')) return defaultRewrite(request);
  if (last.includes('{"files"')) return defaultGithubPicks(request);
  // Before the split check: the GitHub facts reply shape also starts with {"facts".
  if (last.includes('"evidence"')) return defaultGithubFacts(request);
  if (last.includes('{"facts"')) return defaultSplit(request);
  return defaultDraft(request);
}

/**
 * The `HB_AI=fake` provider for tests and Playwright. Keys containing "bad" are rejected.
 */
export function createFakeAi(): FakeAi {
  const replies: FakeReply[] = [];
  const calls: AiCompletionRequest[] = [];

  async function complete(request: AiCompletionRequest): Promise<AiCompletion> {
    calls.push(request);
    await Promise.resolve();
    if (request.key.includes("bad")) throw new AiError({ kind: "rejected_key", message: "Fake: key rejected." });
    const reply = replies.shift();
    if (reply instanceof AiError) throw reply;
    const text = reply === undefined ? defaultReply(request) : typeof reply === "string" ? reply : reply(request);
    const input = [request.system, ...request.messages.map((m) => m.content)].join("\n");
    return { text, inputTokens: estimateTokens(input), outputTokens: estimateTokens(text), model: request.model };
  }

  return {
    complete,
    async checkKey({ key }) {
      await Promise.resolve();
      if (key.includes("bad")) throw new AiError({ kind: "rejected_key", message: "Fake: key rejected." });
    },
    queue(...more) {
      replies.push(...more);
    },
    calls,
    reset() {
      replies.length = 0;
      calls.length = 0;
    },
  };
}
