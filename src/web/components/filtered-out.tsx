import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import type { FilteredGroup, JobId } from "@/shared/api";
import { errorMessage } from "../api";
import { useSettled } from "../lib/use-settled";
import { cn } from "../lib/utils";
import { useFiltered, useOverrideEligibility } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AddJobDialog } from "./add-job-dialog";

/**
 * The Board's "Filtered out" section (decision 53): what eligibility and the role filter kept out
 * of Matches, grouped by reason. Collapsed by default; it opens to a search box and the groups,
 * each with its newest 50. A working screen, so it stays flat (decision 50).
 */
export function FilteredOut() {
  const headingId = useId();
  const panelId = useId();
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useSettled(search.trim(), 250);
  const filtered = useFiltered(open ? q : "");
  // Excluded jobs moved to Matches leave at once, before the server answers.
  const [gone, setGone] = useState<ReadonlySet<JobId>>(new Set());
  const override = useOverrideEligibility();
  const [adding, setAdding] = useState<string | null>(null);

  const total = filtered.data?.total ?? 0;
  if (!filtered.data || total === 0) return null;

  function showInMatches(jobId: JobId, title: string) {
    setGone((g) => new Set(g).add(jobId));
    override.mutate(jobId, {
      onSuccess: () => toast.success(`"${title}" now shows in Matches.`),
      onError: (error) => {
        setGone((g) => {
          const next = new Set(g);
          next.delete(jobId);
          return next;
        });
        toast.error(`Could not move "${title}" to Matches. ${errorMessage(error)}`);
      },
    });
  }

  const groups = filtered.data.groups.map((g) => withoutGone(g, gone)).filter((g): g is FilteredGroup => g !== null);
  // Only what this answer still lists: once the server has the override, it leaves the total itself.
  const pending = filtered.data.groups.flatMap((g) =>
    g.kind === "excluded" ? g.items.filter((i) => gone.has(i.jobId)) : [],
  ).length;
  const shownTotal = total - pending;

  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t pt-4">
      <h2 id={headingId} className="text-base">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 inline-flex items-center gap-1.5 rounded-md px-1 font-medium text-sm hover:text-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-150 ease-out",
              open && "rotate-90",
            )}
          />
          Filtered out
          <span className="font-normal text-muted-foreground tabular-nums">{shownTotal}</span>
        </button>
      </h2>
      <div id={panelId} hidden={!open} className="grid gap-4">
        {open && (
          <>
            <div className="relative max-w-sm">
              <Label htmlFor={searchId} className="sr-only">
                Search filtered out by title or company
              </Label>
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                placeholder="Search title or company"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8"
              />
            </div>
            {groups.length === 0 ? (
              <p className="text-muted-foreground text-sm" role="status">
                Nothing filtered out matches “{q}”.
              </p>
            ) : (
              groups.map((group) => (
                <Group
                  key={`${group.kind}:${group.reason}`}
                  group={group}
                  onShow={showInMatches}
                  onAdd={(url) => setAdding(url)}
                />
              ))
            )}
          </>
        )}
      </div>
      {adding !== null && (
        <AddJobDialog
          key={adding}
          open
          initialUrl={adding}
          onOpenChange={(o) => {
            if (!o) setAdding(null);
          }}
        />
      )}
    </section>
  );
}

/** The group less the jobs just moved to Matches, or null when none are left. */
function withoutGone(group: FilteredGroup, gone: ReadonlySet<JobId>): FilteredGroup | null {
  if (group.kind !== "excluded") return group;
  const items = group.items.filter((i) => !gone.has(i.jobId));
  const count = group.count - (group.items.length - items.length);
  return count > 0 ? { ...group, count, items } : null;
}

function Group({
  group,
  onShow,
  onAdd,
}: {
  group: FilteredGroup;
  onShow: (jobId: JobId, title: string) => void;
  onAdd: (url: string) => void;
}) {
  const headingId = useId();
  const more = group.count - group.items.length;
  return (
    <section aria-labelledby={headingId} className="grid gap-1">
      <h3 id={headingId} className="flex items-baseline gap-2 font-medium text-sm">
        {group.reason}
        <span className="font-normal text-muted-foreground tabular-nums">{group.count}</span>
      </h3>
      <ul className="divide-y rounded-lg border">
        {group.kind === "excluded"
          ? group.items.map((item) => (
              <Row
                key={item.jobId}
                title={item.title}
                detail={item.company}
                note={item.phrase}
                action={(titleId) => (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-describedby={titleId}
                    onClick={() => onShow(item.jobId, item.title)}
                  >
                    Show in Matches
                  </Button>
                )}
              />
            ))
          : group.items.map((item) => (
              <Row
                key={`${item.sourceId}:${item.externalId}`}
                title={item.title}
                detail={`${item.company} · ${item.source}`}
                note={null}
                action={(titleId) => (
                  <Button size="xs" variant="outline" aria-describedby={titleId} onClick={() => onAdd(item.url)}>
                    Add by link
                  </Button>
                )}
              />
            ))}
      </ul>
      {more > 0 && (
        <p className="text-muted-foreground text-xs tabular-nums">
          Showing the newest {group.items.length} of {group.count}. Search to find the rest.
        </p>
      )}
    </section>
  );
}

/** One item. The action's name stays short; the row's title describes which item it acts on. */
function Row({
  title,
  detail,
  note,
  action,
}: {
  title: string;
  detail: string;
  note: string | null;
  action: (titleId: string) => ReactNode;
}) {
  const titleId = useId();
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="truncate text-sm">
          {title}
        </p>
        <p className="truncate text-muted-foreground text-xs">
          {detail}
          {note && <span title={note}> · “{note}”</span>}
        </p>
      </div>
      {action(titleId)}
    </li>
  );
}
