import type { GateBlocker } from "./api";
import type { MustAnswer, OpportunityStatus, OpportunityType, OutputKind } from "./enums";

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
