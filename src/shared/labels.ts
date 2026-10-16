import type { GateBlocker, OutdatedChange, StyleHit } from "./api";
import type { ItemUsage, MustAnswer, OpportunityStatus, OpportunityType, OutputKind, ProfileItemKind } from "./enums";

export function outputKindLabel(kind: OutputKind): string {
  switch (kind) {
    case "resume":
      return "Resume";
    case "letter":
      return "Cover letter";
    case "message":
      return "Short message";
    case "answer":
      return "Answer";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function itemKindLabel(kind: ProfileItemKind): string {
  switch (kind) {
    case "cv":
      return "CV";
    case "experience":
      return "Experience";
    case "open_source":
      return "Open source";
    case "challenge":
      return "Challenge";
    case "other":
      return "Other";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function itemUsageLabel(usage: ItemUsage): string {
  switch (usage) {
    case "everywhere":
      return "Everywhere";
    case "letters_only":
      return "Letters and answers only";
    default: {
      const _exhaustive: never = usage;
      return _exhaustive;
    }
  }
}

export function mustAnswerLabel(category: MustAnswer): string {
  switch (category) {
    case "salary":
      return "Salary expectations";
    case "work_auth":
      return "Work authorization";
    case "notice":
      return "Notice period";
    case "start_date":
      return "Start date";
    case "references":
      return "References";
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

export function statusLabel({ type, status }: { type: OpportunityType; status: OpportunityStatus }): string {
  switch (status) {
    case "saved":
      return "Saved";
    case "applied":
      return type === "contract" ? "Proposal sent" : "Applied";
    case "interviewing":
      return "Interviewing";
    case "offer":
      return "Offer";
    case "closed":
      return "Closed";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** One sentence that names what blocks export and where to fix it. */
export function blockerLabel(blocker: GateBlocker): string {
  switch (blocker.kind) {
    case "must_answer":
      return `${mustAnswerLabel(blocker.category)}: "${blocker.question}" has no answer. Add one here or in your profile.`;
    case "placeholder":
      return `Fill in the placeholder: [[${blocker.text}]]`;
    case "not_drafted":
      return `${outputKindLabel(blocker.outputKind)} is empty. Write it, or untick it.`;
    case "deleted_fact":
      return `This cites ${blocker.factKey}, which you deleted. Remove the claim or cite another fact.`;
    default: {
      const _exhaustive: never = blocker;
      return _exhaustive;
    }
  }
}

/** Sentences longer than this are flagged by the style check. */
export const MAX_SENTENCE_WORDS = 35;

/** A short explanation of a hit for the editor. */
export function styleHitLabel(hit: Pick<StyleHit, "rule" | "phrase">): string {
  switch (hit.rule) {
    case "dash":
      return `Dash used as punctuation ("${hit.phrase}"). Use a full stop or a comma.`;
    case "banned_phrase":
      return `"${hit.phrase}" reads as machine-written. Say it plainly.`;
    case "adjective_triplet":
      return `Three adjectives in a row ("${hit.phrase}"). Keep the one that matters.`;
    case "long_sentence":
      return `Sentence over ${MAX_SENTENCE_WORDS} words. Split it.`;
    default: {
      const _exhaustive: never = hit.rule;
      return _exhaustive;
    }
  }
}

/** One line per changed fact in the outdated notice. */
export function outdatedLabel(change: Pick<OutdatedChange, "factKey" | "reason">): string {
  switch (change.reason) {
    case "edited":
      return `${change.factKey} changed`;
    case "deleted":
      return `${change.factKey} was deleted`;
    case "unconfirmed":
      return `${change.factKey} is no longer confirmed`;
    case "letters_only":
      return `${change.factKey} is now for letters only, so it cannot stay on a resume`;
    default: {
      const _exhaustive: never = change.reason;
      return _exhaustive;
    }
  }
}
