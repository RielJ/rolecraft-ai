import type { ChangeStatus, ChangeView, Contact, FactKey, RequirementMap, TailoringDto } from "@/shared/api";
import { type BaseLine, type BaseSection, coverage, projectEntries, renderLines } from "./base-cv";
import { checkLine, stripMarkers } from "./citations";
import { type DraftProject, ownershipClaim, parseProjectHead, projectHead, projectHeadPlain } from "./draft-projects";
import { requirementGaps } from "./requirements";
import { checkStyle } from "./style";

/*
 * Tailoring a resume from the base CV (decision 75): the model proposes bounded edits to numbered
 * base lines, the domain keeps only edits the CV and the facts back, and the body is the base with
 * every change the user has not undone.
 */

export type TailorOp =
  | { op: "summary"; text: string; facts: FactKey[]; reasons: string[]; note: string | null }
  | { op: "order"; parent: string; lines: string[]; reasons: string[]; note: string | null }
  | { op: "reword"; line: string; text: string; facts: FactKey[]; reasons: string[]; note: string | null }
  | { op: "remove"; line: string; reasons: string[]; note: string | null }
  | { op: "add"; after: string; text: string; facts: FactKey[]; reasons: string[]; note: string | null }
  | {
      op: "project";
      /** The `PROJECT-n` of a project the CV lacks (decision 82). */
      project: string;
      lines: { text: string; facts: FactKey[] }[];
      reasons: string[];
      note: string | null;
    };

/** A kept `project` op, with the head and whose project it is as they were when it was made. */
export type ProjectChange = Extract<TailorOp, { op: "project" }> & {
  head: string;
  role: DraftProject["role"];
};

export type TailorChange = (Exclude<TailorOp, { op: "project" }> | ProjectChange) & {
  id: string;
  status: ChangeStatus;
};

/** What an output keeps of one tailoring: the base it was read against and the changes. */
export type Tailoring = {
  baseHash: string;
  base: BaseLine[];
  changes: TailorChange[];
  dropped: number;
  /** The requirement map the changes' reasons refer to, as it was when they were made. */
  map: RequirementMap | null;
};

export type DropReason =
  | "bad_target"
  | "unknown_fact"
  | "uncited"
  | "wrong_role"
  | "wrong_project"
  | "claims_contribution"
  | "unsupported"
  | "pronoun"
  | "protected"
  | "only_description"
  | "duplicate"
  | "cap"
  | "no_change";

export type DroppedOp = { op: TailorOp; reason: DropReason; detail: string };

/** Drops a retry can fix; `no_change`, `cap` and `only_description` lose nothing worth another call. */
export function worthRetry(dropped: readonly DroppedOp[]): boolean {
  return dropped.some((d) => d.reason !== "no_change" && d.reason !== "cap" && d.reason !== "only_description");
}

/** At most this many rewords and adds are kept; the rest are dropped as `cap`. */
export const MAX_REWORDS = 12;
export const MAX_ADDS = 6;
export const MAX_PROJECTS = 2;
/** A project op writes 1 to this many lines. */
export const MAX_PROJECT_LINES = 3;
/** An add that says this much of a line in its role repeats it. */
const DUPLICATE_COVERAGE = 0.8;

type TailorFact = { key: FactKey; text: string; roleKey?: string | null; projectKey?: string | null };

const clean = (text: string) => stripMarkers(text).replace(/\s+/g, " ").trim();

/** Bullets of a role line, or the text lines of a skills heading: what an `order` may permute. */
export function orderChildren({ base, parent }: { base: readonly BaseLine[]; parent: string }): string[] | null {
  const at = base.findIndex((l) => l.id === parent);
  const line = base[at];
  if (line === undefined) return null;
  if (line.kind === "role") return base.filter((l) => l.role === parent && l.kind === "bullet").map((l) => l.id);
  if (line.kind === "heading" && line.section === "skills") {
    const out: string[] = [];
    for (const next of base.slice(at + 1)) {
      if (next.kind === "heading") break;
      if (next.kind === "text") out.push(next.id);
    }
    return out;
  }
  return null;
}

/** Lines a `reword` or `remove` may target: bullets, and skills lines. */
const editable = (line: BaseLine) => line.kind === "bullet" || (line.kind === "text" && line.section === "skills");

/**
 * Keep the ops the base and the facts back (decision 75). An op that fails a rule is dropped with
 * its reason, never quarantined: the CV line it would change stays as the user wrote it.
 * - Targets must exist and be of the right kind; headings, role headers and contact are never edited.
 * - New text cites allowed facts of the line's own role and adds no number, tool or name the CV
 *   line and those facts lack (`checkLine`), and no pronoun.
 * - A line holding a REQUIRED fact (decision 74) can't be removed, nor a project's last description
 *   (decision 77: a project always shows its name, link and what it is); an add can't repeat a line.
 * - A project op adds a listed project the CV lacks, from that project's facts only, never claiming
 *   a contribution as the candidate's own (decision 82).
 * - One change per line, one order per parent, one summary, one op per project; at most
 *   `MAX_REWORDS`, `MAX_ADDS` and `MAX_PROJECTS`.
 * Reasons keep only requirement ids in the map. Pure.
 */
export function validateEdits({
  base,
  ops,
  facts,
  protectedKeys,
  requirementIds,
  posting,
  contact,
  projects = [],
}: {
  base: readonly BaseLine[];
  ops: readonly TailorOp[];
  facts: readonly TailorFact[];
  /** Projects the CV lacks, which a project op may add (decision 82). */
  projects?: readonly DraftProject[];
  protectedKeys: ReadonlySet<FactKey>;
  requirementIds: ReadonlySet<string>;
  posting: { company: string; title: string };
  contact: Contact;
}): { changes: TailorChange[]; dropped: DroppedOp[] } {
  const byId = new Map(base.map((l) => [l.id, l]));
  const factByKey = new Map(facts.map((f) => [f.key, f]));
  const touched = new Set<string>();
  const changes: TailorChange[] = [];
  const dropped: DroppedOp[] = [];
  const count = { reword: 0, add: 0, summary: 0, project: 0 };
  const projectByKey = new Map(projects.map((p) => [p.key, p]));
  const drop = (op: TailorOp, reason: DropReason, detail: string) => dropped.push({ op, reason, detail });
  // Each project's bullets still in it, by bullet id: a remove may not take the last one.
  const projectOf = new Map<string, { title: BaseLine; left: Set<string> }>();
  for (const entry of projectEntries(base)) {
    const project = { title: entry.title, left: new Set(entry.bullets) };
    for (const bullet of entry.bullets) projectOf.set(bullet, project);
  }

  /** Cited facts, or the reason they can't be used under `roleKey` (undefined: any role). */
  const cite = (
    keys: readonly FactKey[],
    roleKey: string | null | undefined,
  ): { facts: TailorFact[] } | { reason: "unknown_fact" | "wrong_role"; detail: string } => {
    const found: TailorFact[] = [];
    for (const key of keys) {
      const fact = factByKey.get(key);
      if (fact === undefined) return { reason: "unknown_fact", detail: key };
      if (roleKey !== undefined && (fact.roleKey ?? null) !== roleKey) return { reason: "wrong_role", detail: key };
      found.push(fact);
    }
    return { facts: found };
  };
  /** The reason new text fails, or null. */
  const textProblem = (text: string, evidence: readonly string[]) => {
    const tokens = checkLine({ text, evidence, posting, contact });
    if (tokens.length > 0) return { reason: "unsupported" as const, detail: tokens.join(", ") };
    const pronoun = checkStyle({ body: text, kind: "resume" }).find((h) => h.rule === "pronoun");
    if (pronoun) return { reason: "pronoun" as const, detail: pronoun.phrase };
    return null;
  };

  for (const raw of ops) {
    const op: TailorOp = { ...raw, reasons: raw.reasons.filter((r) => requirementIds.has(r)) };
    switch (op.op) {
      case "order": {
        const children = orderChildren({ base, parent: op.parent });
        if (children === null || touched.has(`order:${op.parent}`)) {
          drop(op, "bad_target", op.parent);
          break;
        }
        const same = children.length === op.lines.length && [...children].sort().join() === [...op.lines].sort().join();
        if (!same) {
          drop(op, "bad_target", `${op.parent} has lines ${children.join(", ")}`);
          break;
        }
        if (children.join() === op.lines.join()) {
          drop(op, "no_change", op.parent);
          break;
        }
        touched.add(`order:${op.parent}`);
        changes.push({ ...op, id: "", status: "accepted" });
        break;
      }
      case "remove": {
        const line = byId.get(op.line);
        if (line === undefined || !editable(line) || touched.has(op.line)) {
          drop(op, "bad_target", op.line);
          break;
        }
        const required = line.facts.filter((k) => protectedKeys.has(k));
        if (required.length > 0) {
          drop(op, "protected", required.join(", "));
          break;
        }
        const project = projectOf.get(op.line);
        if (project && project.left.size === 1) {
          drop(op, "only_description", project.title.text);
          break;
        }
        project?.left.delete(op.line);
        touched.add(op.line);
        changes.push({ ...op, id: "", status: "accepted" });
        break;
      }
      case "reword": {
        const line = byId.get(op.line);
        if (line === undefined || !editable(line) || touched.has(op.line)) {
          drop(op, "bad_target", op.line);
          break;
        }
        const text = clean(op.text);
        if (text === clean(line.text)) {
          drop(op, "no_change", op.line);
          break;
        }
        if (count.reword >= MAX_REWORDS) {
          drop(op, "cap", op.line);
          break;
        }
        const cited = cite(op.facts, line.roleKey);
        if ("reason" in cited) {
          drop(op, cited.reason, cited.detail);
          break;
        }
        const own = line.facts.flatMap((k) => factByKey.get(k)?.text ?? []);
        const problem = textProblem(text, [line.text, ...own, ...cited.facts.map((f) => f.text)]);
        if (problem) {
          drop(op, problem.reason, problem.detail);
          break;
        }
        touched.add(op.line);
        count.reword++;
        changes.push({ ...op, text, id: "", status: "accepted" });
        break;
      }
      case "add": {
        const anchor = byId.get(op.after);
        const inRole =
          anchor !== undefined && (anchor.kind === "role" || (anchor.kind === "bullet" && anchor.role !== null));
        if (!inRole) {
          drop(op, "bad_target", op.after);
          break;
        }
        if (count.add >= MAX_ADDS) {
          drop(op, "cap", op.after);
          break;
        }
        if (op.facts.length === 0) {
          drop(op, "uncited", op.after);
          break;
        }
        const cited = cite(op.facts, anchor.roleKey);
        if ("reason" in cited) {
          drop(op, cited.reason, cited.detail);
          break;
        }
        const text = clean(op.text);
        const roleId = anchor.kind === "role" ? anchor.id : anchor.role;
        const repeats = base.find(
          (l) =>
            l.role === roleId && l.kind === "bullet" && coverage({ fact: text, line: l.text }) >= DUPLICATE_COVERAGE,
        );
        if (repeats) {
          drop(op, "duplicate", repeats.id);
          break;
        }
        const problem = textProblem(
          text,
          cited.facts.map((f) => f.text),
        );
        if (problem) {
          drop(op, problem.reason, problem.detail);
          break;
        }
        count.add++;
        changes.push({ ...op, text, id: "", status: "accepted" });
        break;
      }
      case "project": {
        const project = projectByKey.get(op.project);
        if (project === undefined || touched.has(`project:${op.project}`) || op.lines.length === 0) {
          drop(op, "bad_target", op.project);
          break;
        }
        if (count.project >= MAX_PROJECTS) {
          drop(op, "cap", op.project);
          break;
        }
        const lines: { text: string; facts: FactKey[] }[] = [];
        let failed: { reason: DropReason; detail: string } | null = null;
        for (const line of op.lines.slice(0, MAX_PROJECT_LINES)) {
          if (line.facts.length === 0) {
            failed = { reason: "uncited", detail: op.project };
            break;
          }
          const cited = cite(line.facts, undefined);
          if ("reason" in cited) {
            failed = cited;
            break;
          }
          const other = cited.facts.find((f) => (f.projectKey ?? null) !== op.project);
          if (other) {
            failed = { reason: "wrong_project", detail: other.key };
            break;
          }
          const text = clean(line.text);
          const claim = project.role === "contribution" ? ownershipClaim({ sentence: text, name: project.name }) : null;
          const problem = claim
            ? { reason: "claims_contribution" as const, detail: claim }
            : textProblem(text, [
                project.name,
                ...(project.role === "own" ? project.stack : []),
                ...cited.facts.map((f) => f.text),
              ]);
          if (problem) {
            failed = problem;
            break;
          }
          lines.push({ text, facts: [...line.facts] });
        }
        if (failed) {
          drop(op, failed.reason, failed.detail);
          break;
        }
        touched.add(`project:${op.project}`);
        count.project++;
        changes.push({ ...op, lines, head: projectHead(project), role: project.role, id: "", status: "accepted" });
        break;
      }
      case "summary": {
        if (count.summary > 0) {
          drop(op, "bad_target", "a second summary");
          break;
        }
        if (op.facts.length === 0) {
          drop(op, "uncited", "summary");
          break;
        }
        const cited = cite(op.facts, undefined);
        if ("reason" in cited) {
          drop(op, cited.reason, cited.detail);
          break;
        }
        const text = clean(op.text);
        const own = base.filter((l) => l.section === "summary" && l.kind === "text").map((l) => l.text);
        if (own.length > 0 && text === clean(own.join(" "))) {
          drop(op, "no_change", "summary");
          break;
        }
        const roleLines = base.filter((l) => l.kind === "role").map((l) => l.text);
        const problem = textProblem(text, [...own, ...roleLines, ...cited.facts.map((f) => f.text)]);
        if (problem) {
          drop(op, problem.reason, problem.detail);
          break;
        }
        count.summary++;
        changes.push({ ...op, text, id: "", status: "accepted" });
        break;
      }
    }
  }
  return { changes: changes.map((c, i) => ({ ...c, id: `C${i + 1}` })), dropped };
}

/**
 * The projects a project op may add (decision 82): those the CV lacks. A project is in the CV when
 * one of its facts is on a CV line, or a line outside Summary, Skills, Experience and Education
 * says its name. Pure.
 */
export function projectsMissingFromCv<P extends Pick<DraftProject, "key" | "name">>({
  base,
  projects,
  facts,
}: {
  base: readonly BaseLine[];
  projects: readonly P[];
  facts: readonly { key: FactKey; projectKey?: string | null }[];
}): P[] {
  const onLine = new Set(base.flatMap((l) => l.facts));
  const loose = base
    .filter((l) => l.kind !== "contact" && (l.section === "projects" || l.section === "other"))
    .map((l) => clean(l.text).toLowerCase());
  return projects.filter((p) => {
    if (facts.some((f) => f.projectKey === p.key && onLine.has(f.key))) return false;
    const name = p.name.trim().toLowerCase();
    if (name === "") return true;
    const word = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    return !loose.some((text) => word.test(text));
  });
}

type Line = Pick<BaseLine, "id" | "kind" | "text" | "facts" | "section">;

/** Cited facts plus the line's own, in order, once each. */
const union = (a: readonly FactKey[], b: readonly FactKey[]) => [...new Set([...a, ...b])];

/**
 * The lines after applying every accepted change: orders first, then the summary and rewords,
 * then adds (after their anchor, even one that is later removed), then removals. Pure.
 */
export function applyLines({ base, changes }: { base: readonly BaseLine[]; changes: readonly TailorChange[] }): {
  lines: Line[];
  changed: Set<string>;
} {
  const active = changes.filter((c) => c.status === "accepted");
  let lines: Line[] = base.map((l) => ({
    id: l.id,
    kind: l.kind,
    text: l.text,
    facts: [...l.facts],
    section: l.section,
  }));
  const changed = new Set<string>();

  for (const c of active) {
    if (c.op !== "order") continue;
    const slots = lines.flatMap((l, i) => (c.lines.includes(l.id) ? [i] : []));
    const moved = c.lines.map((id) => lines.find((l) => l.id === id)).filter((l): l is Line => l !== undefined);
    if (moved.length !== slots.length) continue;
    const next = [...lines];
    slots.forEach((slot, i) => {
      const line = moved[i];
      if (line) next[slot] = line;
    });
    lines = next;
  }
  for (const c of active) {
    if (c.op === "reword") {
      lines = lines.map((l) => (l.id === c.line ? { ...l, text: c.text, facts: union(l.facts, c.facts) } : l));
      changed.add(c.line);
    }
    if (c.op === "summary") {
      const id = `${c.id}:summary`;
      const line: Line = { id, kind: "text", text: c.text, facts: [...c.facts], section: "summary" };
      const first = lines.findIndex((l) => l.section === "summary" && l.kind === "text");
      if (first >= 0) {
        lines = lines.filter((l, i) => i === first || !(l.section === "summary" && l.kind === "text"));
        lines[first] = line;
      } else {
        const heading = lines.findIndex((l) => l.section === "summary" && l.kind === "heading");
        const at =
          heading >= 0
            ? heading + 1
            : Math.max(
                0,
                lines.findIndex((l) => l.kind === "heading"),
              );
        const insert: Line[] =
          heading >= 0
            ? [line]
            : [{ id: `${c.id}:heading`, kind: "heading", text: "Summary", facts: [], section: "summary" }, line];
        lines = [...lines.slice(0, at), ...insert, ...lines.slice(at)];
      }
      changed.add(id);
    }
  }
  for (const c of active) {
    if (c.op !== "add") continue;
    let at = lines.findIndex((l) => l.id === c.after);
    if (at < 0) continue;
    // After the anchor and any adds already placed after it, so adds keep their order.
    while (lines[at + 1]?.id.startsWith("C")) at++;
    const line: Line = {
      id: c.id,
      kind: "bullet",
      text: c.text,
      facts: [...c.facts],
      section: lines[at]?.section ?? null,
    };
    lines = [...lines.slice(0, at + 1), line, ...lines.slice(at + 1)];
    changed.add(c.id);
  }
  for (const c of active) {
    if (c.op !== "project") continue;
    lines = insertProject({ lines, change: c });
    for (let i = 1; i <= c.lines.length; i++) changed.add(`${c.id}:${i}`);
  }
  const removed = new Set(active.flatMap((c) => (c.op === "remove" ? [c.line] : [])));
  return { lines: lines.filter((l) => !removed.has(l.id)), changed };
}

const CONTRIBUTIONS_HEADING = /open[\s-]*source|contribution/i;

/** Where the section a project goes in ends: before the heading after `heading`, or the end. */
function sectionEnd(lines: readonly Line[], heading: number): number {
  const next = lines.findIndex((l, i) => i > heading && l.kind === "heading");
  return next < 0 ? lines.length : next;
}

/**
 * Your own project's lines as one paragraph (decision 83). Each sentence keeps its own markers: the
 * last one's ride on the line, the others' stay inline.
 */
function ownParagraph({ change, section }: { change: ProjectChange & { id: string }; section: BaseSection }): Line {
  const last = change.lines.at(-1);
  const text = change.lines
    .map((l) => (l === last ? l.text : `${l.text}${l.facts.map((k) => ` [${k}]`).join("")}`))
    .join(" ");
  return { id: `${change.id}:1`, kind: "text", text, facts: [...(last?.facts ?? [])], section };
}

/**
 * A project's head and lines at the end of its section (decision 82): your own under the Projects
 * heading, a contribution under one that says open source or contributions. A missing heading is
 * added after the section it follows: Experience for Projects, Projects for contributions.
 */
function insertProject({ lines, change }: { lines: Line[]; change: ProjectChange & { id: string } }): Line[] {
  const own = change.role === "own";
  const isTarget = (l: Line) =>
    l.kind === "heading" &&
    (own ? l.section === "projects" && !CONTRIBUTIONS_HEADING.test(l.text) : CONTRIBUTIONS_HEADING.test(l.text));
  const section: BaseSection = own ? "projects" : "other";
  const head: Line = { id: `${change.id}:head`, kind: "role", text: change.head, facts: [], section };
  const entry: Line[] = own
    ? [head, ownParagraph({ change, section })]
    : [
        head,
        ...change.lines.map(
          (l, i): Line => ({ id: `${change.id}:${i + 1}`, kind: "bullet", text: l.text, facts: [...l.facts], section }),
        ),
      ];
  const target = lines.findIndex(isTarget);
  if (target >= 0) {
    const at = sectionEnd(lines, target);
    return [...lines.slice(0, at), ...entry, ...lines.slice(at)];
  }
  const after = (test: (l: Line) => boolean) => {
    const at = lines.findIndex((l) => l.kind === "heading" && test(l));
    return at < 0 ? null : sectionEnd(lines, at);
  };
  const at =
    (own ? null : after((l) => l.section === "projects" && !CONTRIBUTIONS_HEADING.test(l.text))) ??
    after((l) => l.section === "experience") ??
    lines.length;
  const heading: Line = {
    id: `${change.id}:heading`,
    kind: "heading",
    text: own ? "Projects" : "Open Source Contributions",
    facts: [],
    section,
  };
  return [...lines.slice(0, at), heading, ...entry, ...lines.slice(at)];
}

/** The body for a tailoring: the base with every accepted change applied (decision 75). Pure. */
export function applyEdits(input: { base: readonly BaseLine[]; changes: readonly TailorChange[] }): string {
  return renderLines(applyLines(input).lines);
}

/** The changed and added lines' text, so style warnings count only words the user did not write. */
export function changedText(input: { base: readonly BaseLine[]; changes: readonly TailorChange[] }): string {
  const { lines, changed } = applyLines(input);
  return renderLines(lines.filter((l) => changed.has(l.id)).map((l) => ({ ...l, kind: "bullet" as const })));
}

// ---------- The review list ----------

/** The review list a resume shows (decision 75): its changes, the gaps and whether the CV changed since. Pure. */
export function tailoringView({
  tailoring,
  currentBaseHash,
}: {
  tailoring: Tailoring;
  /** Hash of the CV as it is now; null when there is none. */
  currentBaseHash: string | null;
}): TailoringDto {
  const { map } = tailoring;
  return {
    changes: changeViews({ tailoring, map }),
    dropped: tailoring.dropped,
    baseChanged: currentBaseHash !== null && currentBaseHash !== tailoring.baseHash,
    gaps: map ? requirementGaps(map).map(({ id, text, weight }) => ({ id, text, weight })) : [],
  };
}

/** One row per change for the review list, in the order the model gave them. Pure. */
export function changeViews({
  tailoring,
  map,
}: {
  tailoring: Pick<Tailoring, "base" | "changes">;
  map: RequirementMap | null;
}): ChangeView[] {
  const base = tailoring.base;
  const byId = new Map(base.map((l) => [l.id, l]));
  const text = (id: string) => clean(byId.get(id)?.text ?? "");
  const reqText = new Map((map?.requirements ?? []).map((r) => [r.id, r.text]));
  /** The role header or heading a line sits under (the line itself when it is one). */
  const whereOf = (id: string): string | null => {
    for (let i = base.findIndex((l) => l.id === id); i >= 0; i--) {
      const line = base[i];
      if (line?.kind === "role")
        return line.text
          .replace(/^###\s+/, "")
          .split(" | ")
          .slice(0, 2)
          .join(", ");
      if (line?.kind === "heading") return line.text;
    }
    return null;
  };
  return tailoring.changes.map((c): ChangeView => {
    const common = {
      id: c.id,
      op: c.op,
      status: c.status,
      reasons: c.reasons.flatMap((id) => (reqText.has(id) ? [{ id, text: reqText.get(id) ?? "" }] : [])),
      note: c.note,
      beforeList: null,
      afterList: null,
    };
    if (c.op === "summary") {
      const own = base.filter((l) => l.section === "summary" && l.kind === "text").map((l) => clean(l.text));
      return { ...common, before: own.length > 0 ? own.join(" ") : null, after: c.text, where: "Summary" };
    }
    if (c.op === "reword") return { ...common, before: text(c.line), after: c.text, where: whereOf(c.line) };
    if (c.op === "remove") return { ...common, before: text(c.line), after: null, where: whereOf(c.line) };
    if (c.op === "add") return { ...common, before: null, after: c.text, where: whereOf(c.after) };
    if (c.op === "project") {
      const head = parseProjectHead(c.head);
      return {
        ...common,
        before: null,
        after: null,
        afterList: [head ? projectHeadPlain(head) : c.head, ...c.lines.map((l) => l.text)],
        where: c.role === "own" ? "Projects" : "Open Source Contributions",
      };
    }
    const children = orderChildren({ base, parent: c.parent }) ?? [];
    return {
      ...common,
      before: null,
      after: null,
      beforeList: children.map(text),
      afterList: c.lines.map(text),
      where: whereOf(c.parent),
    };
  });
}
