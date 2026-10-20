import type { FactKey, RequirementMap } from "@/shared/api";
import type { RequirementWeight } from "@/shared/enums";
import type { DraftPosting, Prompt, PromptFact } from "./prompts";
import { type DraftRole, rolePromptLine } from "./work-roles";

// ---------- The requirement map (decision 73) ----------

/** Output budget for one map call. The cap estimate uses the same number. */
export const REQUIREMENTS_MAX_TOKENS = 2000;

/** At most this many requirements are kept, in the posting's order of importance. */
export const MAX_REQUIREMENTS = 16;

/** Bump when the prompt or the reply's meaning changes, so stored maps are rebuilt. */
const MAP_VERSION = 2;

const REQUIREMENTS_REPLY =
  'Reply with JSON only: {"role": "...", "requirements": [{"text": "...", "weight": "must" | "duty" | "nice", "facts": ["FACT-1", ...]}, ...], "context": [{"role": "ROLE-1", "fact": "FACT-1"}, ...]}';

/**
 * The call that reads a posting before anything is drafted: what it requires, and which confirmed
 * facts prove each requirement. Facts are listed with their `(ROLE-n)`, so the model can also pick,
 * for each role, the fact that says what the role was.
 */
export function buildRequirementsPrompt({
  posting,
  facts,
  roles,
}: {
  posting: DraftPosting;
  facts: readonly PromptFact[];
  roles: readonly DraftRole[];
}): Prompt {
  const system = [
    "You read a job posting for one candidate and list what it requires, then match each requirement to the candidate's confirmed facts.",
    "",
    "Rules:",
    `- At most ${MAX_REQUIREMENTS} requirements, most important first. Merge requirements that ask for the same thing.`,
    "- Read every list in the posting: qualifications, responsibilities or impact, the tech stack, and the nice-to-haves. A responsibility is a requirement too.",
    '- When one item names several qualities, such as "performance, scale, security, and maintainability", list each quality as its own requirement.',
    '- Write each requirement in a few words, close to the posting\'s wording, for example "5+ years building backend systems" or "TypeScript and Node.js".',
    '- weight is "must" for what the posting asks for outright, "duty" for a main part of the job, and "nice" for a plus or bonus.',
    "- facts lists every fact that proves the requirement: the work itself, a tool named in it, or a skills line that names it. A fact can prove more than one requirement. Be thorough: a missed fact is left out of the resume.",
    "- A fact proves a requirement through what the work shows, even in other words: cutting build or query time proves performance; deployment pipelines, health checks and rollbacks prove reliability; authentication, roles, permissions and auth tests prove security; migrations, refactors and typed contracts prove maintainability; payment and billing work proves e-commerce; leading or mentoring engineers proves technical guidance.",
    "- Never list a fact that only shares a word with the requirement. If no fact proves a requirement, give it an empty facts list. Do not stretch.",
    "- context: for every ROLE, the one fact marked with that role that best says what the product or company was and what the candidate did there.",
    '- role: the job\'s role in a few words, for example "Senior backend engineer".',
  ].join("\n");
  const factLines = facts.map((f) => `${f.key}: ${f.text}${f.roleKey ? ` (${f.roleKey})` : ""}`);
  const user = [
    "JOB POSTING",
    `Title: ${posting.title}`,
    `Company: ${posting.company}`,
    "Description:",
    "<<<",
    posting.description.trim(),
    ">>>",
    "",
    ...(roles.length > 0 ? ["ROLES", ...roles.map(rolePromptLine), ""] : []),
    "FACTS",
    ...(factLines.length > 0 ? factLines : ["(none yet)"]),
    "",
    "TASK",
    "List the posting's requirements and the facts that prove each.",
    REQUIREMENTS_REPLY,
  ].join("\n");
  return { system, messages: [{ role: "user", content: user }] };
}

/** The one retry after a map reply that was not the JSON asked for. */
export function buildRequirementsRetryPrompt({ prompt, reply }: { prompt: Prompt; reply: string }): Prompt {
  return {
    system: prompt.system,
    messages: [
      ...prompt.messages,
      { role: "assistant", content: reply },
      { role: "user", content: `That reply could not be read. ${REQUIREMENTS_REPLY}` },
    ],
  };
}

/** A map reply as the model sent it, already read as JSON of this shape (`parseRequirementsReply`). */
export type RequirementsReply = {
  role: string;
  requirements: { text: string; weight: RequirementWeight; facts: string[] }[];
  context: { role: string; fact: string }[];
};

/**
 * Validate a map reply against the facts it was read with. Fact keys that aren't among `facts` are
 * dropped, so a requirement whose keys were all unknown becomes a gap. A context fact counts only
 * when it belongs to the role it was given for.
 */
export function toRequirementMap({
  reply,
  facts,
}: {
  reply: RequirementsReply;
  facts: readonly Pick<PromptFact, "key" | "roleKey">[];
}): RequirementMap {
  const roleOf = new Map<string, string | null>(facts.map((f) => [f.key, f.roleKey ?? null]));
  const keyOf = new Map<string, FactKey>(facts.map((f) => [f.key, f.key]));
  const known = (key: string): FactKey | null => keyOf.get(key.trim()) ?? null;
  const requirements = reply.requirements
    .map((r) => ({ text: r.text.replace(/\s+/g, " ").trim(), weight: r.weight, facts: r.facts }))
    .filter((r) => r.text !== "")
    .slice(0, MAX_REQUIREMENTS)
    .map((r, i) => ({
      id: `R${i + 1}`,
      text: r.text,
      weight: r.weight,
      facts: [...new Set(r.facts.flatMap((k) => known(k) ?? []))],
    }));
  const context = [
    ...new Set(
      reply.context.flatMap(({ role, fact }) => {
        const key = known(fact);
        return key !== null && roleOf.get(key) === role.trim() ? [key] : [];
      }),
    ),
  ];
  return { role: reply.role.replace(/\s+/g, " ").trim(), requirements, context };
}

/** Requirements no confirmed fact proves. Shown to the candidate, never written into a draft. */
export function requirementGaps(map: RequirementMap): RequirementMap["requirements"] {
  return map.requirements.filter((r) => r.facts.length === 0);
}

/**
 * The text a stored map's key is hashed from: the posting and every fact the map was read against,
 * with each fact's text and role. Any change to either means the map is read again.
 */
export function requirementMapSource({
  posting,
  facts,
}: {
  posting: DraftPosting;
  facts: readonly Pick<PromptFact, "key" | "text" | "roleKey">[];
}): string {
  return JSON.stringify({
    v: MAP_VERSION,
    posting: [posting.title, posting.company, posting.description],
    facts: facts.map((f) => [f.key, f.text, f.roleKey ?? null]),
  });
}

// ---------- Drafting from the map ----------

/**
 * The map as one kind may use it: fact keys the kind can't cite (a resume never cites a
 * `letters_only` fact) are dropped, so the prompt never points at a fact the check would reject.
 */
export function restrictRequirementMap({
  map,
  allowedKeys,
}: {
  map: RequirementMap;
  allowedKeys: ReadonlySet<FactKey>;
}): RequirementMap {
  return {
    ...map,
    requirements: map.requirements.map((r) => ({ ...r, facts: r.facts.filter((k) => allowedKeys.has(k)) })),
    context: map.context.filter((k) => allowedKeys.has(k)),
  };
}

/**
 * The facts a resume is drafted from (decision 74, replacing 73's per-fact cut). A role that proves
 * any requirement keeps all its facts: facts are atomic, so a role's strongest bullet is often several
 * of them combined, and the map can miss one. A role that proves nothing keeps only its context fact
 * (or its first fact), so the work history has no holes. A project (decision 82) is the same, except
 * one that proves nothing is left out whole: a resume lists only projects that prove something.
 * Facts with neither all stay.
 */
export function selectResumeFacts<F extends Pick<PromptFact, "key" | "roleKey" | "projectKey">>({
  map,
  facts,
}: {
  map: RequirementMap;
  facts: readonly F[];
}): F[] {
  const proving = new Set(map.requirements.flatMap((r) => r.facts));
  const context = new Set(map.context);
  const keep = new Set(facts.filter((f) => !f.roleKey && !f.projectKey).map((f) => f.key));
  const projects = [...new Set(facts.flatMap((f) => (f.projectKey ? [f.projectKey] : [])))];
  for (const project of projects) {
    const own = facts.filter((f) => f.projectKey === project);
    if (own.some((f) => proving.has(f.key))) for (const f of own) keep.add(f.key);
  }
  const roles = [...new Set(facts.flatMap((f) => (f.roleKey ? [f.roleKey] : [])))];
  for (const role of roles) {
    const own = facts.filter((f) => f.roleKey === role);
    if (own.some((f) => proving.has(f.key))) {
      for (const f of own) keep.add(f.key);
      continue;
    }
    const pick = own.find((f) => context.has(f.key)) ?? own[0];
    if (pick) keep.add(pick.key);
  }
  return facts.filter((f) => keep.has(f.key));
}

/** A fact with a measured result or a count: "28 minutes", "40-66%", "3 engineers". */
const MEASURED = /\d/;

/**
 * The role facts a resume must cite (decision 74): every one that proves a requirement, and every
 * one with a number, in a role that proves something. The draft is retried once when it leaves one
 * out, so the strongest evidence can't be dropped for brevity.
 */
export function requiredResumeFacts<F extends Pick<PromptFact, "key" | "roleKey" | "text">>({
  map,
  facts,
}: {
  map: RequirementMap;
  facts: readonly F[];
}): FactKey[] {
  const proving = new Set<string>(map.requirements.flatMap((r) => r.facts));
  const matching = new Set(facts.flatMap((f) => (f.roleKey && proving.has(f.key) ? [f.roleKey] : [])));
  return facts
    .filter((f) => f.roleKey && matching.has(f.roleKey) && (proving.has(f.key) || MEASURED.test(f.text)))
    .map((f) => f.key);
}

/** For each fact key, the ids of the requirements it proves, in map order. */
export function requirementsByFact(map: RequirementMap): Map<FactKey, string[]> {
  const out = new Map<FactKey, string[]>();
  for (const r of map.requirements) for (const key of r.facts) out.set(key, [...(out.get(key) ?? []), r.id]);
  return out;
}

/** The map as the draft prompt shows it: one line per requirement, gaps named as such. */
export function requirementLines(map: RequirementMap): string[] {
  return map.requirements.map(
    (r) =>
      `${r.id} (${r.weight}): ${r.text}${r.facts.length > 0 ? ` <- ${r.facts.join(", ")}` : " <- no fact (a gap: never mention it)"}`,
  );
}
