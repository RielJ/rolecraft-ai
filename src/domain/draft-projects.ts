import type { ProjectRole } from "@/shared/enums";

/*
 * Projects in a drafted resume (decision 82). Like roles (decision 71), the drafter never types a
 * project's name, link or stack: it writes `[PROJECT-n]` alone on a line, and the server writes the
 * head `#### Name | https://link | Go, TypeScript`. The server also moves each project to its
 * section: your own under `## Projects`, contributions under `## Open Source Contributions`.
 */

/** A project offered to a resume draft, under the key the model writes. */
export type DraftProject = {
  key: string;
  name: string;
  /** The repo or page link, only when the project is public. */
  link: string | null;
  /** Up to 3 of the add-on's skills. */
  stack: readonly string[];
  role: ProjectRole;
};

export const PROJECT_STACK_MAX = 3;

/** What a project's head is built from: its add-on's title and skills, and its role. */
export type ProjectInfo = Pick<DraftProject, "name" | "stack" | "role">;

/**
 * Key the projects `facts` come from as PROJECT-1, PROJECT-2 in the order of their first fact, and
 * mark each fact with its project's key. `info` holds the project add-ons, by item id; facts from
 * any other item get no key. A project's link is its facts' link, and only when every one has it,
 * so a private repo's or folder's never shows. Pure.
 */
export function keyProjects<F extends { itemId: K; link: string | null; projectKey?: string | null }, K>({
  facts,
  info,
}: {
  facts: readonly F[];
  info: ReadonlyMap<K, ProjectInfo>;
}): { projects: DraftProject[]; facts: (F & { projectKey: string | null })[] } {
  const keyOf = new Map<K, string>();
  for (const f of facts)
    if (info.has(f.itemId) && !keyOf.has(f.itemId)) keyOf.set(f.itemId, `PROJECT-${keyOf.size + 1}`);
  const projects = [...keyOf].flatMap(([itemId, key]) => {
    const project = info.get(itemId);
    if (!project) return [];
    const links = facts.filter((f) => f.itemId === itemId).map((f) => f.link);
    const link = links.every((l) => l !== null && l === links[0]) ? (links[0] ?? null) : null;
    return [{ key, ...project, stack: project.stack.slice(0, PROJECT_STACK_MAX), link }];
  });
  return { projects, facts: facts.map((f) => ({ ...f, projectKey: keyOf.get(f.itemId) ?? null })) };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const headPart = (text: string) => squash(text.replace(/\|/g, "/"));
const isLink = (text: string) => /^https?:\/\/\S+$/i.test(text);

/** The head line a `[PROJECT-n]` becomes. Parts the project lacks are left out. */
export function projectHead(project: Pick<DraftProject, "name" | "link" | "stack">): string {
  const stack = project.stack.slice(0, PROJECT_STACK_MAX).map(headPart).filter(Boolean).join(", ");
  const link = project.link && isLink(project.link.trim()) ? project.link.trim() : null;
  return `#### ${[headPart(project.name), ...(link ? [link] : []), ...(stack ? [stack] : [])].join(" | ")}`;
}

/** A project head split into its parts; null when the line is not one. */
export type ParsedProjectHead = { name: string; link: string | null; stack: string | null };

const HEAD = /^\s*####\s+(.+?)\s*$/;

export function parseProjectHead(line: string): ParsedProjectHead | null {
  const match = HEAD.exec(line);
  if (!match) return null;
  // Empty parts are skipped: the export strips a repo's URL when it has turned private since.
  const [name, ...rest] = (match[1] ?? "")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!name || rest.length > 2) return null;
  const link = rest.find(isLink) ?? null;
  const others = rest.filter((p) => p !== link);
  if (others.length > 1) return null;
  return { name, link, stack: others[0] || null };
}

/** A link without its scheme, `www.` or trailing slash, as files show it. */
export function shownLink(link: string): string {
  return link.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
}

/** "Name · github.com/x/y · Go, TypeScript": a head as Copy text and the clean preview show it. */
export function projectHeadPlain(head: ParsedProjectHead): string {
  return [head.name, ...(head.link ? [shownLink(head.link)] : []), ...(head.stack ? [head.stack] : [])].join(" · ");
}

/** The PROJECTS block line: `PROJECT-1: Nyx (your own project)`. */
export function projectPromptLine(project: DraftProject): string {
  const what = project.role === "own" ? "your own project" : "a contribution to someone else's project";
  return `${project.key}: ${squash(project.name)} (${what})`;
}

/** A `[PROJECT-n]` line the model wrote, alone or after a heading mark. */
const PROJECT_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?\[(PROJECT-[1-9]\d*)\](?:\*\*)?[ \t]*$/gm;

/** Any `[PROJECT-n]` token, wherever it sits. */
export const PROJECT_TOKEN = /\[(PROJECT-[1-9]\d*)\]/g;

/**
 * Replace each `[PROJECT-n]` line with its project's head. A key that is not in `projects` stays as
 * written, so `checkDraft` reports it.
 */
export function expandProjects({ body, projects }: { body: string; projects: readonly DraftProject[] }): string {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  return body.replace(PROJECT_LINE, (line, key: string) => {
    const project = byKey.get(key);
    return project ? projectHead(project) : line;
  });
}

export const PROJECTS_HEADING = "## Projects";
export const CONTRIBUTIONS_HEADING = "## Open Source Contributions";

/** Which project section a `#` or `##` heading opens, or null for any other heading. */
export function projectSectionOf(line: string): ProjectRole | null {
  const match = /^\s*#{1,2}\s+(.*)$/.exec(line);
  if (!match) return null;
  const text = (match[1] ?? "").toLowerCase();
  if (/\bcontributions?\b/.test(text)) return "contribution";
  if (/\bprojects?\b/.test(text)) return "own";
  return null;
}

const SECTION_HEADING = /^\s*#{1,2}\s/;
/** Sections a new Projects section goes before when the draft has none: the resume's tail. */
const TAIL_SECTION = /^\s*#{1,2}\s+.*\b(?:skills|education|certifications?|awards|languages|interests)\b/i;

/**
 * Move each project, from its head to the next head or heading, to the end of its section: your own
 * under `## Projects`, contributions under `## Open Source Contributions`. A missing section is
 * added: Contributions right after Projects, Projects right before Contributions, and otherwise
 * before Skills or Education, or at the end. A section left empty by the move is removed. Projects
 * already in place stay in their order. Pure.
 */
export function placeProjects({ body, projects }: { body: string; projects: readonly DraftProject[] }): string {
  const roleOf = new Map(projects.map((p) => [projectHead(p).trim(), p.role]));
  const lines = body.split("\n");

  // Cut the misplaced blocks out, noting each line's section as we go.
  const kept: string[] = [];
  const moved: Record<ProjectRole, string[][]> = { own: [], contribution: [] };
  let section: ProjectRole | null = null;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    if (SECTION_HEADING.test(line)) section = projectSectionOf(line);
    const role = roleOf.get(line.trim());
    if (role === undefined || role === section) {
      kept.push(line);
      i++;
      continue;
    }
    const block = [line];
    i++;
    while (i < lines.length && !isBoundary({ line: lines[i] ?? "", roleOf })) block.push(lines[i++] ?? "");
    moved[role].push(trimBlank(block));
  }
  if (moved.own.length === 0 && moved.contribution.length === 0) return body;

  let out = kept;
  for (const role of ["own", "contribution"] as const) {
    if (moved[role].length > 0) out = appendToSection({ lines: out, role, blocks: moved[role] });
  }
  const placed = dropEmptySections(out)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return body.endsWith("\n") ? `${placed}\n` : placed;
}

function isBoundary({ line, roleOf }: { line: string; roleOf: ReadonlyMap<string, ProjectRole> }): boolean {
  return SECTION_HEADING.test(line) || /^\s*###\s/.test(line) || roleOf.has(line.trim());
}

function trimBlank(block: string[]): string[] {
  const out = [...block];
  while (out.length > 0 && (out.at(-1) ?? "").trim() === "") out.pop();
  return out;
}

/** Add `blocks` at the end of the `role` section, adding the section when there is none. */
function appendToSection({
  lines,
  role,
  blocks,
}: {
  lines: string[];
  role: ProjectRole;
  blocks: string[][];
}): string[] {
  const body = blocks.flatMap((b) => ["", ...b]);
  const start = lines.findIndex((l) => SECTION_HEADING.test(l) && projectSectionOf(l) === role);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !SECTION_HEADING.test(lines[end] ?? "")) end++;
    while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    return [...lines.slice(0, end), ...body, "", ...lines.slice(end)];
  }
  const heading = role === "own" ? PROJECTS_HEADING : CONTRIBUTIONS_HEADING;
  const section = [heading, ...body, ""];
  const other = role === "own" ? "contribution" : "own";
  const otherStart = lines.findIndex((l) => SECTION_HEADING.test(l) && projectSectionOf(l) === other);
  let at: number;
  if (otherStart >= 0 && role === "own") at = otherStart;
  else if (otherStart >= 0) {
    at = otherStart + 1;
    while (at < lines.length && !SECTION_HEADING.test(lines[at] ?? "")) at++;
  } else {
    const tail = lines.findIndex((l) => TAIL_SECTION.test(l));
    at = tail >= 0 ? tail : lines.length;
  }
  const before = lines.slice(0, at);
  const lead = before.length > 0 && (before.at(-1) ?? "").trim() !== "" ? [""] : [];
  return [...before, ...lead, ...section, ...lines.slice(at)];
}

/** Remove a Projects or Contributions heading with nothing but blank lines under it. */
function dropEmptySections(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (SECTION_HEADING.test(line) && projectSectionOf(line) !== null) {
      let next = i + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
      if (next >= lines.length || SECTION_HEADING.test(lines[next] ?? "")) {
        i = next - 1;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}
