import { type ReactNode, type Ref, useEffect } from "react";
import type { JobId, MatchItem } from "@/shared/api";
import type { MatchLevel } from "@/shared/enums";
import { eligibilityLabel, matchLevelLabel } from "@/shared/labels";
import { cn } from "@/web/lib/utils";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

export const optionId = (id: JobId) => `match-${id}`;

const LEVEL_VARIANT = {
  strong: "default",
  possible: "secondary",
  weak: "outline",
} as const satisfies Record<MatchLevel, "default" | "secondary" | "outline">;

export function LevelBadge({ level }: { level: MatchLevel }) {
  return <Badge variant={LEVEL_VARIANT[level]}>{matchLevelLabel(level)}</Badge>;
}

/** The "Role unclear" chip (section 3.7a). */
export function RoleUnclearChip() {
  return (
    <Badge variant="outline" className="border-warning/50 text-warning-foreground">
      Role unclear
    </Badge>
  );
}

function Row({
  job,
  selected,
  onSelect,
  children,
}: {
  job: MatchItem;
  selected: boolean;
  onSelect: (id: JobId) => void;
  children: ReactNode;
}) {
  return (
    // Keyboard selection lives on the listbox (aria-activedescendant), so options take focus only
    // by click (tabIndex -1); the listbox owns the keys (section 4 keyboard model).
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the listbox, not per option.
    <div
      id={optionId(job.id)}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onClick={() => onSelect(job.id)}
      // No transition: selection changes are instant (section 4).
      className={cn(
        "relative grid cursor-default gap-1 border-b px-3 py-2.5 outline-none",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <span className="line-clamp-2 font-medium text-sm leading-snug">{job.title}</span>
      <span className="truncate text-muted-foreground text-sm">
        {job.company}
        {job.locationText && ` · ${job.locationText}`}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        <LevelBadge level={job.level} />
        {job.roleUnclear && <RoleUnclearChip />}
        <span>{eligibilityLabel(job.eligibility)}</span>
        {job.pay && <span className="tabular-nums">{job.pay}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * The Matches list: a listbox whose selection follows the keyboard (section 4). `atSelected`
 * renders inside the selected row, so the dismiss popover opens at the row.
 */
export function JobList({
  jobs,
  selected,
  onSelect,
  atSelected,
  ref,
}: {
  jobs: readonly MatchItem[];
  selected: JobId | null;
  onSelect: (id: JobId) => void;
  atSelected?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  // Keep the selected row in view. Instant: keyboard selection never animates.
  useEffect(() => {
    if (selected) document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Matches"
      tabIndex={0}
      aria-activedescendant={selected ? optionId(selected) : undefined}
      aria-keyshortcuts="j k ArrowDown ArrowUp Home End Enter o s d z v / e a ?"
      className="min-h-0 overflow-y-auto overscroll-contain rounded-md border-t outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      {jobs.map((job) => (
        <Row key={job.id} job={job} selected={job.id === selected} onSelect={onSelect}>
          {job.id === selected && atSelected}
        </Row>
      ))}
    </div>
  );
}

/** Loading rows at the real row height. */
export function JobListSkeleton() {
  return (
    <div aria-hidden className="grid border-t">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="grid gap-1.5 border-b px-3 py-2.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}
