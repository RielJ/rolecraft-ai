import { useState } from "react";
import { confidenceText, provenanceText } from "./FieldReview";
import { type PanelEvent, type ReviewItem, sensitiveKey } from "./state";

// One checklist per application for work authorization, sponsorship and voluntary identity
// answers. Nothing here fills until the user ticks it and confirms. The parent remounts this on
// each scan (keyed by nonce), so the ticks start from what was already confirmed.

export function SensitiveChecklist({
  items,
  confirmed,
  dispatch,
  disabled,
}: {
  items: readonly ReviewItem[];
  confirmed: readonly string[];
  dispatch: (event: PanelEvent) => void;
  disabled: boolean;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(items.map((i) => sensitiveKey(i.match)).filter((k) => confirmed.includes(k))),
  );
  if (items.length === 0) return null;

  const keys = items.map((i) => sensitiveKey(i.match));
  const confirmedHere = keys.filter((k) => confirmed.includes(k));
  const unchanged = ticked.size === confirmedHere.length && confirmedHere.every((k) => ticked.has(k));

  function toggle(key: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <section aria-labelledby="sensitive-title" className="flex flex-col gap-2 rounded-control border border-border p-3">
      <div className="flex flex-col gap-0.5">
        <h3 id="sensitive-title" className="text-sm font-semibold">
          Sensitive answers
        </h3>
        <p className="text-xs text-muted-foreground">
          Work authorization, sponsorship and voluntary identity questions. Tick each answer you want sent with this
          application, then confirm. Unticked ones stay blank.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const key = sensitiveKey(item.match);
          const label = item.field?.label.trim() || "Unlabeled field";
          return (
            <li key={item.match.fieldId}>
              <label className="flex gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={ticked.has(key)}
                  disabled={disabled}
                  onChange={(e) => toggle(key, e.target.checked)}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">{label}</span>
                  <span className="text-sm font-medium break-words">{item.match.displayText}</span>
                  <span className="text-xs text-muted-foreground">
                    {provenanceText(item.match)} · {confidenceText(item.match)}
                    {confirmed.includes(key) ? " · confirmed" : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground tabular-nums" role="status">
          {confirmedHere.length} of {items.length} confirmed
        </p>
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled || unchanged}
          onClick={() => dispatch({ kind: "checklist_confirmed", keys: [...ticked] })}
        >
          Confirm ticked answers
        </button>
      </div>
    </section>
  );
}
