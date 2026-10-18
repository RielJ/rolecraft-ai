import type { PrefillCategory } from "@shared/extension";
import { type FieldHint, labelText, radioChoices, type ScanTarget, selectChoices } from "../content/scan";

// Helpers shared by the ATS adapters. Adapters only read the page: they return labels and
// category hints, never values, and nothing they read leaves the content script except as a hint.

/** Lowercase letters, digits and single spaces: the form labels are compared in. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Text of a question title, without the trailing required marker ("*" or Lever's "✱"). */
export function titleText(element: Element | null): string {
  return element === null ? "" : labelText(element).replace(/\s*[✱*]+\s*$/, "");
}

/** A text box asking for one of the standard profile links, by its exact (normalized) label. */
const LINK_LABELS: readonly { pattern: RegExp; category: PrefillCategory }[] = [
  { pattern: /^linkedin(?: profile)?(?: url| link)?$/, category: "linkedin" },
  { pattern: /^github(?: profile)?(?: url| link)?$/, category: "github" },
  { pattern: /^portfolio(?: url| link| website)?$/, category: "portfolio" },
  { pattern: /^(?:personal |other )?website(?: url)?$/, category: "website" },
];

export function linkCategory(label: string): PrefillCategory | null {
  const normalized = normalize(label);
  return LINK_LABELS.find((l) => l.pattern.test(normalized))?.category ?? null;
}

/** Hint for a typed text box only (never a select, radio, checkbox or file). */
export function textHint(target: ScanTarget, category: PrefillCategory | null): FieldHint | null {
  if (category === null || (target.kind !== "text" && target.kind !== "textarea")) return null;
  return { adapterCategory: category };
}

/** The options (as the scan reports them, placeholder aside) are exactly "Yes" and "No". */
export function isYesNo(target: ScanTarget): boolean {
  const choices =
    target.kind === "radio"
      ? radioChoices(target.elements)
      : target.kind === "select"
        ? selectChoices(target.element).filter((c) => c.element.value !== "")
        : [];
  const labels = choices.map((c) => normalize(c.option.label));
  return labels.length === 2 && labels.includes("yes") && labels.includes("no");
}

/**
 * Standard work-authorization and sponsorship wording only. Anything looser ("...three days a
 * week?", "...in the LA area?") stays a custom question for the generic label match.
 */
const WORK_AUTHORIZATION =
  /^are you (?:legally |currently )?(?:authorized|eligible) to work in (?:the united states|the u s|the us|the country (?:for which|in which|where) you are applying)$/;
const SPONSORSHIP =
  /^(?:will|do) you (?:now or in the future )?require (?:visa )?sponsorship(?: for employment visa status)?(?: e g h 1b(?: visa)?(?: status)?(?: etc)?)?(?: to work in (?:the united states|the u s|the us))?$/;

/** work_authorization / requires_sponsorship for a Yes/No question with standard wording. */
export function yesNoCategory(target: ScanTarget, question: string): PrefillCategory | null {
  if (!isYesNo(target)) return null;
  const normalized = normalize(question);
  if (WORK_AUTHORIZATION.test(normalized)) return "work_authorization";
  if (SPONSORSHIP.test(normalized)) return "requires_sponsorship";
  return null;
}
