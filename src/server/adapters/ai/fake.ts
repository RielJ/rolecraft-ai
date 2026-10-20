import { estimateTokens } from "@/domain/prompts";
import { splitSections } from "@/domain/split";
import { sentenceSpans } from "@/domain/text";
import { type AiCompletion, type AiCompletionRequest, AiError, type AiProviderClient } from "./types";

/** A queued reply: text, a function of the request, or an error to throw. */
export type FakeReply = string | AiError | ((request: AiCompletionRequest) => string);

export type FakeAi = AiProviderClient & {
  /** Queue replies. Each call takes the next one; an empty queue falls back to the default writer. */
  queue(...replies: FakeReply[]): void;
  /**
   * Queue requirement-map replies (decision 73). Map calls take only from this queue, so tests that
   * queue draft replies keep working when a draft first reads the map.
   */
  queueMap(...replies: FakeReply[]): void;
  /** Queue tailor replies (decision 75). Tailor calls take only from this queue; the default reorders one role and shortens one bullet. */
  queueTailor(...replies: FakeReply[]): void;
  /** Every request seen except requirement-map and tailor requests, oldest first. */
  readonly calls: AiCompletionRequest[];
  /** Requirement-map requests, oldest first (decision 73). */
  readonly mapCalls: AiCompletionRequest[];
  /** Tailor requests, retries included, oldest first (decision 75). */
  readonly tailorCalls: AiCompletionRequest[];
  reset(): void;
};

const FACT_LINE = /^(FACT-[1-9]\d*): (.*?)(?: \((ROLE-[1-9]\d*)\))?(?: \[R[1-9]\d*(?:, R[1-9]\d*)*\])?$/gm;
const ROLE_LINE = /^(ROLE-[1-9]\d*): /gm;

/** A fact line's text without its `(link)`, and the role it is marked with. */
function factLine(m: RegExpMatchArray): { key: string; text: string; role: string | null } {
  return { key: m[1] ?? "", text: (m[2] ?? "").replace(/ \([^)]*\)$/, ""), role: m[3] ?? null };
}

// A role header as CVs write it: "Title  Start – End" over "Company (Location)" or "COMPANY, LOCATION".
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?,? \\d{4}";
const DATE = `(?:${MONTH}|\\d{4}|Present|Current)`;
const TITLE_DATES = new RegExp(`^(.+?)\\s+(${DATE})\\s*[–—-]\\s*(${DATE})$`);

type FakeRole = { title: string; company: string; location: string | null; start: string; end: string; line: number };

/** The roles a careful reader finds in a CV text, with the line their company sits on. */
export function fakeRoles(text: string): FakeRole[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  return lines.flatMap((line, i) => {
    const head = TITLE_DATES.exec(line);
    const next = lines[i + 1] ?? "";
    if (!head || next === "") return [];
    const paren = /^(.+?)\s*\((.+)\)$/.exec(next);
    const comma = /^([^,]+),\s*(.+)$/.exec(next);
    const [company, location] = paren ? [paren[1], paren[2]] : comma ? [comma[1], comma[2]] : [next, null];
    return [
      {
        title: head[1] ?? "",
        company: (company ?? "").trim(),
        location: location?.trim() ?? null,
        start: head[2] ?? "",
        end: head[3] ?? "",
        line: i + 1,
      },
    ];
  });
}

/** Roles as JSON, read from the item text between `<<<` and `>>>`. */
function defaultRoles(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const text = /^<<<\n([\s\S]*?)\n>>>$/m.exec(prompt)?.[1] ?? "";
  return JSON.stringify({ roles: fakeRoles(text).map(({ line: _line, ...role }) => role) });
}

/** Cite each sentence of a fact with its own key, so the default draft always passes checkDraft. */
function citedSentences(key: string, text: string): string[] {
  return sentenceSpans(text).map((s) => `${s.text.replace(/[.!?]+$/, "")} [${key}].`);
}

/** A plausible draft built only from the prompt's fact lines. */
function defaultDraft(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const name = /^CANDIDATE: (.*)$/m.exec(prompt)?.[1] ?? "[[your name]]";
  const lines = Array.from(prompt.matchAll(FACT_LINE), factLine);
  const facts = lines.flatMap((f) => citedSentences(f.key, f.text));
  if (facts.length === 0) return "[[your experience for this role]]";
  if (/Write a resume tailored/.test(prompt)) {
    // Facts with no role in a Summary, then under Experience each role's key and its own facts.
    // No name heading: the app adds the contact header (decision 72).
    const roles = Array.from(prompt.matchAll(ROLE_LINE), (m) => m[1] ?? "");
    const bullets = (role: string | null) =>
      lines.filter((f) => f.role === role).flatMap((f) => citedSentences(f.key, f.text).map((t) => `- ${t}`));
    const grouped = roles.flatMap((role) => [`[${role}]`, ...bullets(role)]);
    if (roles.length === 0) return ["## Experience", ...bullets(null)].join("\n");
    return ["## Summary", ...bullets(null), "## Experience", ...grouped].join("\n");
  }
  return [facts.join(" "), "", name].join("\n");
}

/** Echo each numbered sentence back, so the default style rewrite changes nothing. */
function defaultRewrite(request: AiCompletionRequest): string {
  const prompt = request.messages.at(-1)?.content ?? "";
  const sentences = Array.from(prompt.matchAll(/^\d+\. (.*)$/gm), (m) => m[1] ?? "");
  return JSON.stringify({ rewrites: sentences });
}

/**
 * A CV's text as a careful reader sees it: a lone "•" joined to the line after it, a bullet's
 * wrapped second line joined back, and a blank line before each role header so the rule
 * splitter does not run the header into the bullets above it.
 */
function tidyCv(text: string, roles: readonly FakeRole[]): string[] {
  const heads = new Set(roles.flatMap((r) => [r.line - 1, r.line]));
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  raw.forEach((line, i) => {
    const prev = out.at(-1) ?? "";
    const trimmed = line.trim();
    if (heads.has(i)) {
      if (roles.some((r) => r.line - 1 === i)) out.push("");
      out.push(trimmed);
    } else if (prev.trim() === "•") out[out.length - 1] = `• ${trimmed}`;
    else if (
      /^[•-] /.test(prev.trim()) &&
      !/[.!?]$/.test(prev) &&
      trimmed !== "" &&
      !/^[•-]/.test(trimmed) &&
      !/^[A-Z][A-Z &]+$/.test(trimmed)
    ) {
      out[out.length - 1] = `${prev} ${trimmed}`;
    } else out.push(line);
  });
  return out;
}

/**
 * Split the item text between `<<<` and `>>>` by rule, as the prompt asks: role headers are not
 * facts, and a fact under a role gets the company as its section.
 */
function defaultSplit(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const text = /^<<<\n([\s\S]*?)\n>>>$/m.exec(prompt)?.[1] ?? "";
  const roles = fakeRoles(text);
  if (roles.length === 0) return JSON.stringify({ facts: splitSections({ text }) });
  const lines = tidyCv(text, roles);
  const tidy = fakeRoles(lines.join("\n"));
  const isHeading = (l: string) => /^[A-Z][A-Z &]+$/.test(l.trim());
  const facts = splitSections({ text: lines.join("\n") }).flatMap((fact) => {
    const at = lines.findIndex((l) => l.includes(fact.text));
    const header = (r: FakeRole) =>
      at === r.line || at === r.line - 1 || fact.text.startsWith(lines[r.line - 1] ?? "\0");
    if (tidy.some(header)) return [];
    const role = tidy.filter((r) => at > r.line).at(-1);
    // A heading such as EDUCATION ends the last role's part of the text.
    const ended = role !== undefined && lines.some((l, i) => i > role.line && i < at && isHeading(l));
    return [role && !ended ? { ...fact, section: role.company } : fact];
  });
  return JSON.stringify({ facts });
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
 * Feature grouping (decision 81): commits grouped by the first word of their subject, in list
 * order, at most 3 per feature and 6 features.
 */
function defaultFeatures(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const user = /^PERSON: (.*)$/m.exec(prompt)?.[1] ?? "";
  const groups = new Map<string, string[]>();
  for (const line of dataBlock(prompt, `COMMITS BY ${user}`).split("\n")) {
    const m = /^([0-9a-f]{7,40}) \S+ \+\d+ -\d+ (\S+)/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const word = m[2].replace(/[:(].*$/, "").toLowerCase();
    const shas = groups.get(word) ?? [];
    if (shas.length < 3) shas.push(m[1]);
    groups.set(word, shas);
  }
  const features = [...groups].slice(0, 6).map(([name, commits]) => ({ name, commits }));
  return JSON.stringify({ features });
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

/** A requirement-map request: its reply shape starts with the role and the requirements. */
function isMapRequest(request: AiCompletionRequest): boolean {
  return (request.messages.at(-1)?.content ?? "").includes('{"role": "...", "requirements"');
}

/**
 * The default map: one requirement that every fact proves, and each role's first fact as its
 * context fact. Every fact stays selected, so a draft reads the same as without a map.
 */
function defaultRequirements(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const facts = Array.from(prompt.matchAll(FACT_LINE), factLine);
  const roles = [...new Set(facts.flatMap((f) => (f.role ? [f.role] : [])))];
  return JSON.stringify({
    role: /^Title: (.*)$/m.exec(prompt)?.[1] ?? "",
    requirements: [{ text: "The work this job describes", weight: "must", facts: facts.map((f) => f.key) }],
    context: roles.flatMap((role) => {
      const first = facts.find((f) => f.role === role);
      return first ? [{ role, fact: first.key }] : [];
    }),
  });
}

/**
 * The default tailor reply (decision 75), two edits the checks always keep: reverse the bullets of
 * the first role with two or more, and shorten the first bullet of another role by cutting its
 * first "by/for/with/in/on/through" clause (fewer of the line's own words). Either is left out when the CV
 * has no line for it.
 */
function defaultTailor(request: AiCompletionRequest): string {
  const prompt = request.messages[0]?.content ?? "";
  const lines = Array.from(prompt.matchAll(/^(L\d+) (role|bullet|heading|text)\b[^:\n]*: (.*)$/gm), (m) => ({
    id: m[1] ?? "",
    kind: m[2],
    text: m[3] ?? "",
  }));
  const requirement = /^(R\d+) \(/m.exec(prompt)?.[1];
  const reasons = requirement ? [requirement] : [];
  const roles = lines.flatMap((line, i) => {
    if (line.kind !== "role") return [];
    const end = lines.findIndex((next, j) => j > i && next.kind !== "bullet");
    return [{ line, bullets: lines.slice(i + 1, end === -1 ? undefined : end) }];
  });
  const ordered = roles.find((r) => r.bullets.length >= 2);
  const ops: unknown[] = [];
  if (ordered) {
    ops.push({ op: "order", parent: ordered.line.id, lines: ordered.bullets.map((b) => b.id).reverse(), reasons });
  }
  for (const role of roles) {
    const bullet = role.bullets[0];
    if (role === ordered || !bullet) continue;
    const cut = /^(.{20,}?) (?:by|for|with|in|on|through) [^,]+$/.exec(bullet.text.replace(/\.$/, ""));
    if (!cut?.[1]) continue;
    ops.push({ op: "reword", line: bullet.id, text: `${cut[1]}.`, facts: [], reasons, note: null });
    break;
  }
  return JSON.stringify({ ops });
}

/** A tailor request or its retry: both ask for the `{"ops": [...]}` reply. */
function isTailorRequest(request: AiCompletionRequest): boolean {
  return (request.messages.at(-1)?.content ?? "").includes('{"ops": [...]}');
}

/** Which default writer answers a request, from what its last message asks for. */
function defaultReply(request: AiCompletionRequest): string {
  const last = request.messages.at(-1)?.content ?? "";
  // Eligibility: the fake never guesses, so a job the rules left unclear stays unclear.
  if (last.includes('{"verdict"')) return JSON.stringify({ verdict: "unclear", phrase: null });
  if (last.includes('{"questions"')) return defaultQuestions(request);
  if (last.includes('{"rewrites"')) return defaultRewrite(request);
  if (last.includes('{"files"')) return defaultGithubPicks(request);
  if (last.includes('{"features"')) return defaultFeatures(request);
  // Before the split check: the GitHub facts reply shape also starts with {"facts".
  if (last.includes('"evidence"')) return defaultGithubFacts(request);
  if (last.includes('{"facts"')) return defaultSplit(request);
  if (last.includes('{"roles"')) return defaultRoles(request);
  return defaultDraft(request);
}

/**
 * The `HB_AI=fake` provider for tests and Playwright. Keys containing "bad" are rejected.
 */
export function createFakeAi(): FakeAi {
  const replies: FakeReply[] = [];
  const mapReplies: FakeReply[] = [];
  const tailorReplies: FakeReply[] = [];
  const calls: AiCompletionRequest[] = [];
  const mapCalls: AiCompletionRequest[] = [];
  const tailorCalls: AiCompletionRequest[] = [];
  const lanes = {
    map: { replies: mapReplies, calls: mapCalls, fallback: defaultRequirements },
    tailor: { replies: tailorReplies, calls: tailorCalls, fallback: defaultTailor },
    other: { replies, calls, fallback: defaultReply },
  };

  async function complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const lane = isMapRequest(request) ? lanes.map : isTailorRequest(request) ? lanes.tailor : lanes.other;
    lane.calls.push(request);
    await Promise.resolve();
    if (request.key.includes("bad")) throw new AiError({ kind: "rejected_key", message: "Fake: key rejected." });
    const reply = lane.replies.shift();
    if (reply instanceof AiError) throw reply;
    const fallback = lane.fallback;
    const text = reply === undefined ? fallback(request) : typeof reply === "string" ? reply : reply(request);
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
    queueMap(...more) {
      mapReplies.push(...more);
    },
    queueTailor(...more) {
      tailorReplies.push(...more);
    },
    calls,
    mapCalls,
    tailorCalls,
    reset() {
      replies.length = 0;
      mapReplies.length = 0;
      tailorReplies.length = 0;
      mapCalls.length = 0;
      tailorCalls.length = 0;
      calls.length = 0;
    },
  };
}
