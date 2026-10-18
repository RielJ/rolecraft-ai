import { type ReactNode, type Ref, useEffect, useRef } from "react";
import type { JobId, MatchItem } from "@/shared/api";
import type { Eligibility, MatchLevel } from "@/shared/enums";
import { matchLevelLabel } from "@/shared/labels";
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

/**
 * Who can apply, short enough for a row. Places you can apply from read in full color, unknowns
 * stay muted, and a job that leaves out the Philippines reads in red.
 */
function whoCanApply(verdict: Eligibility): { text: string; tone: string } {
  switch (verdict) {
    case "ph":
      return { text: "Open to PH", tone: "text-foreground" };
    case "worldwide":
      return { text: "Worldwide", tone: "text-foreground" };
    case "apac":
      return { text: "APAC", tone: "text-foreground" };
    case "americas":
      return { text: "Americas", tone: "text-muted-foreground" };
    case "excluded":
      return { text: "Excludes PH", tone: "text-destructive" };
    case "unclear":
      return { text: "Region unclear", tone: "text-muted-foreground" };
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

const DAY = 86_400_000;

/** How long ago the job was first seen: "today", "3d", "2w", "4mo". */
export function seenAgo({ iso, now }: { iso: string; now: number }): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function Row({
  job,
  selected,
  now,
  onSelect,
  children,
}: {
  job: MatchItem;
  selected: boolean;
  now: number;
  onSelect: (id: JobId) => void;
  children: ReactNode;
}) {
  const who = whoCanApply(job.eligibility);
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
        "relative grid cursor-default gap-0.5 border-border/60 border-b px-4 py-3 outline-none [-webkit-tap-highlight-color:transparent]",
        selected
          ? "bg-accent text-accent-foreground group-focus-visible/list:ring-1 group-focus-visible/list:ring-primary/50 group-focus-visible/list:ring-inset"
          : "pointer-fine:hover:bg-muted/50 active:bg-muted/50",
      )}
    >
      <span className="flex items-baseline gap-3">
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-sm leading-snug">{job.title}</span>
        <time dateTime={job.firstSeenAt} className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {seenAgo({ iso: job.firstSeenAt, now })}
        </time>
      </span>
      <span className="truncate text-muted-foreground text-sm">
        {job.company}
        {job.locationText && ` · ${job.locationText}`}
      </span>
      <span className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
        <span className={who.tone}>{who.text}</span>
        {job.pay && <span className="text-muted-foreground tabular-nums">{job.pay}</span>}
        {job.skills.asked > 0 && (
          <span className="text-muted-foreground tabular-nums">
            {job.skills.matched} of {job.skills.asked} skills
          </span>
        )}
        {job.roleUnclear && <span className="text-warning-foreground">Role unclear</span>}
      </span>
      {children}
    </div>
  );
}

const LEVEL_ORDER: readonly MatchLevel[] = ["strong", "possible", "weak"];

/**
 * The Matches list: a listbox whose selection follows the keyboard (section 4), grouped by level
 * under sticky headers, so the level is read once per group instead of on every row. The server
 * already sorts by level. `atSelected` renders inside the selected row, so the dismiss popover
 * opens at the row.
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
  // Keep the selected row in view where the list scrolls on its own (wide screens). Instant:
  // keyboard selection never animates. On phones the page scrolls, and a tap is already in view.
  const ownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = ownRef.current;
    if (!selected || !list || list.scrollHeight <= list.clientHeight) return;
    document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const now = Date.now();
  const groups = LEVEL_ORDER.map((level) => ({ level, jobs: jobs.filter((j) => j.level === level) })).filter(
    (g) => g.jobs.length > 0,
  );
  return (
    <div
      ref={(el) => {
        ownRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      role="listbox"
      aria-label="Matches"
      tabIndex={0}
      aria-activedescendant={selected ? optionId(selected) : undefined}
      aria-keyshortcuts="j k ArrowDown ArrowUp Home End Enter o s d z v / e a ?"
      className="group/list min-h-0 outline-none md:overflow-y-auto md:overscroll-contain"
    >
      {groups.map((g) => (
        // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"; a fieldset is for form controls.
        <div key={g.level} role="group" aria-label={`${matchLevelLabel(g.level)}, ${g.jobs.length}`}>
          <div
            aria-hidden
            className="top-0 z-10 flex md:sticky items-baseline justify-between border-border/60 border-b bg-card px-4 py-1.5 font-medium text-muted-foreground text-xs"
          >
            <span className={cn(g.level === "strong" && "text-primary")}>{matchLevelLabel(g.level)}</span>
            <span className="tabular-nums">{g.jobs.length}</span>
          </div>
          {g.jobs.map((job) => (
            <Row key={job.id} job={job} selected={job.id === selected} now={now} onSelect={onSelect}>
              {job.id === selected && atSelected}
            </Row>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Loading rows at the real row height. */
export function JobListSkeleton() {
  return (
    <div aria-hidden className="grid">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="grid gap-1.5 border-border/60 border-b px-4 py-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
