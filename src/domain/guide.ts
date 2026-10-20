import type { OpportunityType, OutputKind } from "@/shared/enums";
import guideText from "./drafting-guide.md" with { type: "text" };

/** Sections every draft prompt carries, in this order (decision 72). */
const SHARED_SECTIONS = [
  "Facts and limits",
  "Tailoring to the posting",
  "Shared rules",
  "Sounds like a person",
] as const;

/** The section for one kind of output. A job message and a contract proposal differ. */
function kindSection({ kind, opportunityType }: { kind: OutputKind; opportunityType: OpportunityType }): string {
  switch (kind) {
    case "resume":
      return "Resume";
    case "letter":
      return "Cover letter";
    case "message":
      return opportunityType === "contract" ? "Short message (contract proposal)" : "Short message (job)";
    case "answer":
      return "Application answer";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Every `## ` section of a guide, by heading, with its body (sub-headings included). */
export function guideSectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null) sections.set(heading, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1] ?? "";
      body = [];
    } else if (heading !== null) body.push(line);
  }
  flush();
  return sections;
}

/** Drop the guide's source references, `([TIH][tih], [Job200][j200])`, which mean nothing to the model. */
export function stripSourceRefs(text: string): string {
  return text.replace(/ ?\((?:\[[^\]]+\]\[[a-z0-9]+\](?:, )?)+\)/g, "");
}

/** The headings one kind's prompt needs, in order. */
export function guideHeadings(input: { kind: OutputKind; opportunityType: OpportunityType }): string[] {
  return [...SHARED_SECTIONS, kindSection(input)];
}

/**
 * The guide text one draft prompt carries: the shared sections and the kind's own, each under its
 * heading, without source references. Throws when a heading is missing, so a renamed section can
 * never send an empty guide.
 */
export function guideFor(
  input: { kind: OutputKind; opportunityType: OpportunityType },
  text: string = guideText,
): string {
  return sectionsText(guideHeadings(input), text);
}

/** The section only a resume tailored from the base CV gets (decision 75). */
export const TAILOR_SECTION = "Editing a base resume";

/** The headings the tailor prompt carries: a resume's, then the editing rules. */
export function tailorGuideHeadings(): string[] {
  return [...guideHeadings({ kind: "resume", opportunityType: "job" }), TAILOR_SECTION];
}

/** The guide text for the tailor prompt (decision 75). Throws like `guideFor`. */
export function tailorGuide(text: string = guideText): string {
  return sectionsText(tailorGuideHeadings(), text);
}

function sectionsText(headings: readonly string[], text: string): string {
  const sections = guideSectionsOf(text);
  return headings
    .map((heading) => {
      const body = sections.get(heading);
      if (body === undefined || body === "") throw new Error(`The drafting guide has no "## ${heading}" section.`);
      return `## ${heading}\n\n${stripSourceRefs(body)}`;
    })
    .join("\n\n");
}
