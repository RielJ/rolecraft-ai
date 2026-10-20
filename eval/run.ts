import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { checkDraft, type DraftViolation, factKey } from "@/domain/citations";
import { acceptAiVerdict, classifyEligibility } from "@/domain/eligibility";
import {
  allowedFacts,
  buildDraftPrompt,
  buildEligibilityPrompt,
  buildRetryPrompt,
  cleanModelText,
  DRAFT_MAX_TOKENS,
  ELIGIBILITY_MAX_TOKENS,
  type Prompt,
  type PromptFact,
} from "@/domain/prompts";
import { createAnthropicClient } from "@/server/adapters/ai/anthropic";
import { createOpenAiClient } from "@/server/adapters/ai/openai";
import { createPiClient, PI_THINKING_LEVELS } from "@/server/adapters/ai/pi";
import { costUsd } from "@/server/adapters/ai/pricing";
import type { AiProviderClient } from "@/server/adapters/ai/types";
import { parseEligibilityReply } from "@/server/services/ai-replies";
import { Contact } from "@/shared/api";
import { AiTier, Eligibility, ItemUsage, OpportunityType, OutputKind } from "@/shared/enums";
import { type GithubOutcome, githubLine, loadGithubCases, runGithubCase } from "./github";

/*
 * The evaluation set (decision 30, PLAN.md slice 10). Usage:
 *
 *   bun run eval --tier light --model <id> [--via key|pi]
 *   bun run eval --tier light --github [--model <id>] [--via key|pi]
 *
 * `--github` runs only the GitHub set (eval/github.ts). With HB_AI=pi and no --via or --model, it
 * runs through pi with HB_PI_MODEL_LIGHT (claude-haiku-5-5 by default), so it never needs a key.
 *
 * Eligibility: each posting goes through the app's rules first. Postings the rules leave unclear
 * go to the model with the app's prompt, and its answer counts only through the app's own
 * verbatim-phrase check. A posting expected `excluded` that ends anything else is a missed exclusion.
 *
 * Drafting: each fact set is drafted with the app's prompt and checked with the app's `checkDraft`.
 * Like the app, a failing draft gets one retry with the violations listed. What still fails after
 * that retry is counted as invented claims.
 *
 * It exits 1 on any missed exclusion, invented claim or failed call; 2 on bad arguments.
 * It reads only the JSON files under eval/ and never opens the app's database.
 */

// ---------- Cases ----------

const EligibilityCase = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  locationText: z.string(),
  description: z.string(),
  expected: Eligibility,
  why: z.string(),
});
export type EligibilityCase = z.infer<typeof EligibilityCase>;
const EligibilityFile = z.object({ about: z.string(), cases: z.array(EligibilityCase) });

const DraftingCase = z.object({
  id: z.string().min(1),
  kind: OutputKind,
  opportunityType: OpportunityType,
  posting: z.object({ title: z.string(), company: z.string(), description: z.string() }),
  question: z.string().nullable().default(null),
  facts: z
    .array(
      z.object({
        text: z.string().min(1),
        usage: ItemUsage.default("everywhere"),
        link: z.string().nullable().default(null),
      }),
    )
    .min(1),
  tempts: z.string(),
});
const DraftingFile = z.object({ about: z.string(), candidate: Contact, cases: z.array(DraftingCase) });
export type DraftingCase = z.infer<typeof DraftingCase> & { candidate: Contact };

export type EvalSets = { eligibility: EligibilityCase[]; drafting: DraftingCase[] };

async function jsonFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(dir, n));
}

/** Every case under `eval/eligibility` and `eval/drafting`. Ids must be unique per set. */
export async function loadSets(root: string = import.meta.dir): Promise<EvalSets> {
  const eligibility: EligibilityCase[] = [];
  for (const path of await jsonFiles(join(root, "eligibility"))) {
    eligibility.push(...EligibilityFile.parse(await Bun.file(path).json()).cases);
  }
  const drafting: DraftingCase[] = [];
  for (const path of await jsonFiles(join(root, "drafting"))) {
    const file = DraftingFile.parse(await Bun.file(path).json());
    drafting.push(...file.cases.map((c) => ({ ...c, candidate: file.candidate })));
  }
  for (const [set, ids] of [
    ["eligibility", eligibility.map((c) => c.id)],
    ["drafting", drafting.map((c) => c.id)],
  ] as const) {
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new Error(`Two ${set} cases share the id "${dup}".`);
  }
  return { eligibility, drafting };
}

// ---------- Running ----------

export type EligibilityOutcome = {
  id: string;
  expected: Eligibility;
  /** What the rules said. */
  rule: Eligibility;
  /** The verdict the app would store: the rule's, or the model's accepted one, or unclear. */
  final: Eligibility;
  /** Where the final verdict came from; `none` when the model was asked and nothing was accepted. */
  by: "rule" | "ai" | "none";
  phrase: string | null;
  /** The model's raw reply, when it was asked. */
  reply: string | null;
  missedExclusion: boolean;
  error: string | null;
};

export type DraftingOutcome = {
  id: string;
  kind: OutputKind;
  /** Violations in the first draft, before the app's retry. */
  firstDraft: DraftViolation[];
  /** Violations still there after the retry: the invented claims. */
  invented: DraftViolation[];
  body: string;
  error: string | null;
};

export type EvalReport = {
  model: string;
  tier: AiTier;
  via: string;
  eligibility: EligibilityOutcome[];
  drafting: DraftingOutcome[];
  missedExclusions: number;
  inventedClaims: number;
  errors: number;
  /** Null when a call had no price (model not in pricing.ts and the runner reported none). */
  costUsd: number | null;
};

type Call = (prompt: Prompt, maxOutputTokens: number) => Promise<string>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runEligibility(call: Call, c: EligibilityCase): Promise<EligibilityOutcome> {
  const rule = classifyEligibility({ description: c.description, locationText: c.locationText, structured: null });
  const base = { id: c.id, expected: c.expected, rule: rule.verdict };
  const done = (o: Omit<EligibilityOutcome, keyof typeof base | "missedExclusion">): EligibilityOutcome => ({
    ...base,
    ...o,
    missedExclusion: c.expected === "excluded" && o.final !== "excluded",
  });
  if (rule.verdict !== "unclear") {
    return done({ final: rule.verdict, by: "rule", phrase: rule.phrase, reply: null, error: null });
  }
  let reply: string;
  try {
    reply = await call(buildEligibilityPrompt({ posting: c }), ELIGIBILITY_MAX_TOKENS);
  } catch (error) {
    return done({ final: "unclear", by: "none", phrase: null, reply: null, error: errorText(error) });
  }
  const answer = parseEligibilityReply(reply);
  const accepted = answer && acceptAiVerdict({ answer, description: c.description });
  return accepted
    ? done({ final: accepted.verdict, by: "ai", phrase: accepted.phrase, reply, error: null })
    : done({ final: "unclear", by: "none", phrase: null, reply, error: null });
}

async function runDrafting(call: Call, c: DraftingCase): Promise<DraftingOutcome> {
  const facts: PromptFact[] = c.facts.map((f, i) => ({ key: factKey(i + 1), ...f }));
  const allowed = allowedFacts({ kind: c.kind, facts });
  const prompt = buildDraftPrompt({
    kind: c.kind,
    opportunityType: c.opportunityType,
    posting: c.posting,
    candidateName: c.candidate.fullName,
    facts: allowed,
    question: c.question,
  });
  const check = (body: string) =>
    checkDraft({
      body,
      facts: allowed,
      allowedKeys: allowed.map((f) => f.key),
      posting: { company: c.posting.company, title: c.posting.title },
      contact: c.candidate,
    });
  const base = { id: c.id, kind: c.kind };
  try {
    const maxTokens = DRAFT_MAX_TOKENS[c.kind];
    let body = cleanModelText(await call(prompt, maxTokens));
    const first = check(body);
    if (first.ok) return { ...base, firstDraft: [], invented: [], body, error: null };
    body = cleanModelText(
      await call(buildRetryPrompt({ prompt, draft: body, violations: first.violations }), maxTokens),
    );
    const second = check(body);
    return { ...base, firstDraft: first.violations, invented: second.ok ? [] : second.violations, body, error: null };
  } catch (error) {
    return { ...base, firstDraft: [], invented: [], body: "", error: errorText(error) };
  }
}

/** Run both sets against one model. Calls run one at a time, in file order. */
export async function runEval({
  client,
  key = "",
  model,
  tier,
  via,
  sets,
  onCase = () => {},
}: {
  client: AiProviderClient;
  key?: string;
  model: string;
  tier: AiTier;
  via: string;
  sets: EvalSets;
  onCase?: (event: { set: "eligibility" | "drafting"; line: string }) => void;
}): Promise<EvalReport> {
  let cost: number | null = 0;
  const call: Call = async (prompt, maxOutputTokens) => {
    const completion = await client.complete({
      key,
      model,
      tier,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens,
    });
    const spent =
      completion.costUsd ??
      costUsd({ model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens });
    cost = cost === null || spent === null ? null : cost + spent;
    return completion.text;
  };

  const eligibility: EligibilityOutcome[] = [];
  for (const c of sets.eligibility) {
    const outcome = await runEligibility(call, c);
    eligibility.push(outcome);
    onCase({ set: "eligibility", line: eligibilityLine(outcome) });
  }
  const drafting: DraftingOutcome[] = [];
  for (const c of sets.drafting) {
    const outcome = await runDrafting(call, c);
    drafting.push(outcome);
    onCase({ set: "drafting", line: draftingLine(outcome) });
  }
  return {
    model,
    tier,
    via,
    eligibility,
    drafting,
    missedExclusions: eligibility.filter((o) => o.missedExclusion).length,
    inventedClaims: drafting.reduce((n, o) => n + o.invented.length, 0),
    errors: [...eligibility, ...drafting].filter((o) => o.error !== null).length,
    costUsd: cost,
  };
}

/** 0 only when nothing was missed, nothing was invented and every call answered. */
export function exitCode(report: Pick<EvalReport, "missedExclusions" | "inventedClaims" | "errors">): 0 | 1 {
  return report.missedExclusions + report.inventedClaims + report.errors === 0 ? 0 : 1;
}

// ---------- Report ----------

const quote = (s: string, max = 100) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;

function eligibilityLine(o: EligibilityOutcome): string {
  const tag = o.error ? "ERROR " : o.missedExclusion ? "MISSED" : o.final === o.expected ? "ok    " : "differs";
  const head = `  ${tag} ${o.id.padEnd(22)} expected ${o.expected.padEnd(9)} got ${o.final.padEnd(9)} (${o.by})`;
  if (o.error) return `${head}\n           ${o.error}`;
  const why = o.phrase ? quote(o.phrase) : o.reply !== null ? `reply ${quote(o.reply.replace(/\s+/g, " "))}` : "";
  return why ? `${head}\n           ${why}` : head;
}

function violationText(v: DraftViolation): string {
  switch (v.kind) {
    case "unknown_fact":
      return `cites ${v.factKey}, which is not a fact here: ${quote(v.sentence)}`;
    case "unknown_role":
      return `writes ${v.roleKey}, which is not a role here: ${quote(v.sentence)}`;
    case "wrong_role":
      return `${v.factKeys.join(", ")} under ${v.roleKey ?? "Experience, before any role"}: ${quote(v.sentence)}`;
    default:
      return `${v.tokens.join(", ")} in ${quote(v.sentence)}`;
  }
}

function draftingLine(o: DraftingOutcome): string {
  if (o.error) return `  ERROR  ${o.id.padEnd(22)} ${o.kind}\n           ${o.error}`;
  if (o.invented.length === 0) {
    const fixed = o.firstDraft.length ? ` (first draft had ${o.firstDraft.length}, fixed on retry)` : "";
    return `  ok     ${o.id.padEnd(22)} ${o.kind}${fixed}`;
  }
  const lines = o.invented.map((v) => `           ${violationText(v)}`);
  return [`  INVENTED ${o.id.padEnd(20)} ${o.kind}: ${o.invented.length} after the retry`, ...lines].join("\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The per-model summary printed after the case lines. */
export function summaryLine(report: EvalReport): string {
  const cost = report.costUsd === null ? "cost unknown" : `$${report.costUsd.toFixed(4)}`;
  const parts = [
    plural(report.missedExclusions, "missed exclusion"),
    plural(report.inventedClaims, "invented claim"),
    plural(report.errors, "failed call"),
  ];
  return `${report.model} (${report.tier}, via ${report.via}): ${parts.join(", ")}, ${cost}. ${exitCode(report) === 0 ? "PASS" : "FAIL"}`;
}

// ---------- GitHub set ----------

export type GithubReport = {
  model: string;
  tier: AiTier;
  via: string;
  cases: GithubOutcome[];
  inventedClaims: number;
  injectedFacts: number;
  errors: number;
  costUsd: number | null;
};

export function githubExitCode(report: Pick<GithubReport, "inventedClaims" | "injectedFacts" | "errors">): 0 | 1 {
  return report.inventedClaims + report.injectedFacts + report.errors === 0 ? 0 : 1;
}

export function githubSummaryLine(report: GithubReport): string {
  const cost = report.costUsd === null ? "cost unknown" : `$${report.costUsd.toFixed(4)}`;
  const parts = [
    plural(report.inventedClaims, "invented claim"),
    plural(report.injectedFacts, "injected fact"),
    plural(report.errors, "failed case"),
  ];
  return `${report.model} (${report.tier}, via ${report.via}): ${parts.join(", ")}, ${cost}. ${githubExitCode(report) === 0 ? "PASS" : "FAIL"}`;
}

/** Run the GitHub set against one model, one case at a time. */
export async function runGithubEval({
  client,
  key = "",
  model,
  tier,
  via,
  root = import.meta.dir,
  onCase = () => {},
}: {
  client: AiProviderClient;
  key?: string;
  model: string;
  tier: AiTier;
  via: string;
  root?: string;
  onCase?: (line: string) => void;
}): Promise<GithubReport> {
  let cost: number | null = 0;
  const call = async (prompt: Prompt, maxOutputTokens: number) => {
    const completion = await client.complete({
      key,
      model,
      tier,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens,
    });
    const spent =
      completion.costUsd ??
      costUsd({ model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens });
    cost = cost === null || spent === null ? null : cost + spent;
    return completion.text;
  };
  const cases: GithubOutcome[] = [];
  for (const c of await loadGithubCases(root)) {
    const outcome = await runGithubCase({ call, model, c });
    cases.push(outcome);
    onCase(githubLine(outcome));
  }
  return {
    model,
    tier,
    via,
    cases,
    inventedClaims: cases.reduce((n, o) => n + o.invented.length, 0),
    injectedFacts: cases.reduce((n, o) => n + o.injected.length, 0),
    errors: cases.filter((o) => o.error !== null).length,
    costUsd: cost,
  };
}

// ---------- CLI ----------

const Args = z.object({
  tier: AiTier.default("light"),
  model: z.string().min(1, "Pass --model <id>, for example --model claude-haiku-5-5."),
  via: z.enum(["key", "pi"]).default("key"),
  provider: z.enum(["anthropic", "openai"]).optional(),
  /** pi's provider id. Only the subscription sign-ins: a model with no API key bill. */
  piProvider: z.enum(["anthropic", "openai-codex"]).optional(),
});

function providerOf(model: string): "anthropic" | "openai" | null {
  if (model.startsWith("claude")) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt)/.test(model)) return "openai";
  return null;
}

/** The pi provider for a run through pi: `--pi-provider`, else the one that serves the model. */
export function piProviderFor(args: {
  model: string;
  piProvider?: "anthropic" | "openai-codex" | undefined;
}): "anthropic" | "openai-codex" | null {
  if (args.piProvider) return args.piProvider;
  const provider = providerOf(args.model);
  if (provider === null) return null;
  return provider === "anthropic" ? "anthropic" : "openai-codex";
}

type Client = { client: AiProviderClient; key: string; via: string };

async function clientFor(args: z.infer<typeof Args>): Promise<Client | string> {
  if (args.via === "pi") {
    const piProvider = piProviderFor(args);
    if (!piProvider) {
      return `Cannot tell pi's provider for "${args.model}". Pass --pi-provider anthropic or --pi-provider openai-codex.`;
    }
    const Thinking = z.enum(PI_THINKING_LEVELS);
    const pi = createPiClient({
      bin: process.env.HB_PI_BIN || "pi",
      piProvider,
      thinking: {
        light: Thinking.catch("off").parse(process.env.HB_PI_THINKING_LIGHT ?? "off"),
        writing: Thinking.catch("low").parse(process.env.HB_PI_THINKING_WRITING ?? "low"),
      },
    });
    if (!(await pi.authReady())) return `pi is not signed in to ${piProvider}. Run \`pi\`, then /login, and try again.`;
    return { client: pi, key: "", via: `pi (${piProvider})` };
  }
  const provider = args.provider ?? providerOf(args.model);
  if (!provider) return `Cannot tell the provider of "${args.model}". Pass --provider anthropic or --provider openai.`;
  const name = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const key = process.env[name]?.trim();
  if (!key) return `Set ${name} to run the eval with a key, or pass --via pi.`;
  return { client: provider === "anthropic" ? createAnthropicClient() : createOpenAiClient(), key, via: provider };
}

const stdout = (line: string) => void process.stdout.write(`${line}\n`);

/** The CLI. Returns the exit code; `out` receives every printed line. */
export async function main(argv: readonly string[], out: (line: string) => void = stdout): Promise<number> {
  let raw: ReturnType<typeof parseArgs>["values"];
  try {
    raw = parseArgs({
      args: [...argv],
      options: {
        tier: { type: "string" },
        model: { type: "string" },
        via: { type: "string" },
        provider: { type: "string" },
        "pi-provider": { type: "string" },
        github: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (error) {
    out(errorText(error));
    return 2;
  }
  const { "pi-provider": piProvider, github, ...rest } = raw;
  // The GitHub set follows HB_AI=pi (decision 48): pi and its light model unless told otherwise.
  const viaPi = github === true && process.env.HB_AI === "pi";
  const args = Args.safeParse({
    ...rest,
    piProvider,
    via: raw.via ?? (viaPi ? "pi" : undefined),
    model: raw.model ?? (viaPi ? process.env.HB_PI_MODEL_LIGHT || "claude-haiku-5-5" : ""),
  });
  if (!args.success) {
    out(z.prettifyError(args.error));
    return 2;
  }
  const client = await clientFor(args.data);
  if (typeof client === "string") {
    out(client);
    return 2;
  }
  if (github === true) {
    out(`Eval: ${args.data.model}, ${args.data.tier} tier, via ${client.via}`);
    const cases = await loadGithubCases(import.meta.dir);
    out(`GitHub: ${cases.length} recorded repos`);
    const report = await runGithubEval({ ...client, model: args.data.model, tier: args.data.tier, onCase: out });
    out("");
    out(githubSummaryLine(report));
    return githubExitCode(report);
  }
  const sets = await loadSets();
  const asked = sets.eligibility.filter(
    (c) =>
      classifyEligibility({ description: c.description, locationText: c.locationText, structured: null }).verdict ===
      "unclear",
  ).length;
  out(`Eval: ${args.data.model}, ${args.data.tier} tier, via ${client.via}`);
  out(`Eligibility: ${sets.eligibility.length} cases, ${asked} need the model`);
  let drafting = false;
  const report = await runEval({
    ...client,
    model: args.data.model,
    tier: args.data.tier,
    sets,
    onCase: ({ set, line }) => {
      if (set === "drafting" && !drafting) {
        drafting = true;
        out(`Drafting: ${sets.drafting.length} cases`);
      }
      out(line);
    },
  });
  out("");
  out(summaryLine(report));
  return exitCode(report);
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
