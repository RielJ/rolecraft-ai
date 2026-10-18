import type { FieldMatch, FillSkipReason, UnresolvedReason } from "@shared/extension";
import { useState } from "react";
import type { ItemStatus, LeftBlank, PanelEvent, ReviewItem } from "./state";

// The review list: what each field would get, where the answer came from and how sure the match
// is. Sensitive items are not here; SensitiveChecklist shows them.

export function provenanceText(match: FieldMatch): string {
  switch (match.provenance.kind) {
    case "profile":
      return "From your profile";
    case "job_preference":
      return "Saved for this job";
    case "global_preference":
      return "Your default";
    case "generated":
      return match.needsReview ? "Drafted answer, not reviewed" : "Drafted answer";
    default: {
      const exhaustive: never = match.provenance;
      return exhaustive;
    }
  }
}

export function confidenceText(match: FieldMatch): string {
  return match.confidence === "high" ? "Exact match" : "Likely match";
}

export function unresolvedText(reason: UnresolvedReason): string {
  switch (reason) {
    case "unknown_label":
      return "No saved answer fits this question";
    case "low_confidence":
      return "Not sure what this asks";
    case "no_value":
      return "Nothing saved for this yet";
    case "salary":
      return "Pay question, never filled";
    case "file_field":
      return "File upload, attach it from Files";
    case "no_matching_option":
      return "None of the options match your answer";
    case "unsupported_control":
      return "Type-ahead dropdown or other field the extension can't fill, answer it on the page";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function skipText(reason: FillSkipReason): string {
  switch (reason) {
    case "not_empty":
      return "Already had a value, left as is";
    case "hidden":
      return "Hidden on the page";
    case "disabled":
      return "Disabled on the page";
    case "read_only":
      return "Read-only on the page";
    case "stale":
      return "The page changed, scan again";
    case "missing":
      return "No longer on the page, scan again";
    case "salary":
      return "Pay question, never filled";
    case "file_field":
      return "File upload, attach it from Files";
    case "no_matching_option":
      return "None of the options match your answer";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function leftBlankText(item: LeftBlank): string {
  switch (item.kind) {
    case "unresolved":
      return unresolvedText(item.reason);
    case "skipped":
      return skipText(item.reason);
    case "not_selected":
      return "Not selected";
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function labelOf(item: ReviewItem): string {
  const label = item.field?.label.trim() ?? "";
  return label === "" ? "Unlabeled field" : label;
}

function Row({
  item,
  dispatch,
  disabled,
}: {
  item: ReviewItem;
  dispatch: (event: PanelEvent) => void;
  disabled: boolean;
}) {
  const { match, decision } = item;
  const [editing, setEditing] = useState(false);
  const value = decision.edit ?? match.displayText;
  const editable = match.value.kind === "text";
  const label = labelOf(item);

  return (
    <li className="flex gap-3 px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        aria-label={`Fill ${label}`}
        checked={item.status === "ready"}
        disabled={disabled}
        onChange={(e) => dispatch({ kind: "accept_toggled", fieldId: match.fieldId, accepted: e.target.checked })}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium break-words">{label}</p>
        {editing ? (
          <textarea
            className="min-h-16 rounded-control border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={`Answer for ${label}`}
            value={value}
            disabled={disabled}
            onChange={(e) => dispatch({ kind: "edited", fieldId: match.fieldId, text: e.target.value })}
          />
        ) : (
          <p className="line-clamp-4 text-sm break-words whitespace-pre-wrap text-foreground/90">{value}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {provenanceText(match)} · {confidenceText(match)}
          {decision.edit !== null && decision.edit !== match.displayText ? " · edited" : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {editable && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              disabled={disabled}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Done" : "Edit"}
            </button>
          )}
          {match.provenance.kind === "generated" && match.needsReview && match.value.kind === "text" && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              disabled={disabled}
              onClick={() => dispatch({ kind: "mark_reviewed_clicked", fieldId: match.fieldId })}
            >
              Mark reviewed
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

const GROUPS: readonly { status: Exclude<ItemStatus, "needs_checklist">; title: string; hint: string | null }[] = [
  {
    status: "needs_ok",
    title: "Check these first",
    hint: "Likely matches and unreviewed drafts fill only if you tick them.",
  },
  { status: "ready", title: "Will fill", hint: null },
  { status: "off", title: "Turned off", hint: null },
];

export function FieldReview({
  items,
  unresolved,
  dispatch,
  disabled,
}: {
  items: readonly ReviewItem[];
  unresolved: readonly LeftBlank[];
  dispatch: (event: PanelEvent) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(({ status, title, hint }) => {
        const group = items.filter((i) => i.status === status && !i.match.needsConfirmation);
        if (group.length === 0) return null;
        return (
          <section key={status} className="flex flex-col gap-1.5" aria-label={title}>
            <h3 className="text-sm font-semibold">
              {title} <span className="font-normal text-muted-foreground tabular-nums">{group.length}</span>
            </h3>
            {hint !== null && <p className="text-xs text-muted-foreground">{hint}</p>}
            <ul className="divide-y divide-border rounded-control border border-border">
              {group.map((item) => (
                <Row key={item.match.fieldId} item={item} dispatch={dispatch} disabled={disabled} />
              ))}
            </ul>
          </section>
        );
      })}
      {unresolved.length > 0 && <LeftBlankList title="Left blank" items={unresolved} />}
    </div>
  );
}

export function LeftBlankList({ title, items }: { title: string; items: readonly LeftBlank[] }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h3 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span>
      </h3>
      <ul className="divide-y divide-border rounded-control border border-border">
        {items.map((item) => (
          <li key={`${item.kind}:${item.fieldId}`} className="flex flex-col gap-0.5 px-3 py-2">
            <span className="text-sm break-words">{item.label}</span>
            <span className="text-xs text-muted-foreground">{leftBlankText(item)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
