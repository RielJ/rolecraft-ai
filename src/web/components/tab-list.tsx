import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/web/lib/utils";

export type Tab<T extends string> = { value: T; label: ReactNode };

/** The ids that tie a tab to its panel: `tab-<value>` and `panel-<value>`, prefixed when given. */
export const tabId = (value: string, prefix = "") => `${prefix}tab-${value}`;
export const panelId = (value: string, prefix = "") => `${prefix}panel-${value}`;

const VARIANT = {
  /** Page-level: text with an underline under the selected tab. */
  line: {
    list: "flex gap-6 border-b",
    tab: "-mb-px flex items-center gap-2 border-transparent border-b-2 pt-1 pb-2.5 font-medium text-muted-foreground text-sm hover:text-foreground aria-selected:border-primary aria-selected:text-foreground",
  },
  /** Nested inside a page tab: a segmented control, so it never reads as a second page level. */
  pill: {
    list: "flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/60 p-1",
    tab: "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground text-sm hover:text-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm",
  },
} as const;

/**
 * An ARIA tab list. One tab is in the Tab order; the arrow keys, Home and End move between tabs
 * and select them as they go (automatic activation). The caller renders the panels with
 * `panelId(value)` and `aria-labelledby={tabId(value)}`.
 */
export function TabList<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idPrefix = "",
  variant = "line",
}: {
  label: string;
  tabs: readonly Tab<T>[];
  value: T;
  onChange: (value: T) => void;
  idPrefix?: string;
  variant?: keyof typeof VARIANT;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.findIndex((t) => t.value === value);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    onChange(tab.value);
    document.getElementById(tabId(tab.value, idPrefix))?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={VARIANT[variant].list} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={tabId(t.value, idPrefix)}
          aria-selected={t.value === value}
          aria-controls={panelId(t.value, idPrefix)}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cn(
            "transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            VARIANT[variant].tab,
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
