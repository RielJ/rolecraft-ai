import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { RefreshResult } from "@/shared/api";
import { jobCountLabel, refreshedLabel, sourceStatusLabel } from "@/shared/labels";
import { useMinuteClock } from "../lib/use-minute-clock";
import { keys, useRefresh } from "../queries";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { setWatched, subscribeWatched, useRunRefresh, watchedTask } from "./run-refresh";
import { SourcesPanel } from "./setup-checklist";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 new, 1 closed. Jobicy: Rate limited." */
function summary(result: RefreshResult): string {
  const total = (pick: (s: RefreshResult["sources"][number]) => number) =>
    result.sources.reduce((sum, s) => sum + pick(s), 0);
  const counts = [
    `${total((s) => s.added)} new`,
    total((s) => s.updated) > 0 && `${total((s) => s.updated)} updated`,
    total((s) => s.closed) > 0 && `${total((s) => s.closed)} closed`,
    total((s) => s.reopened) > 0 && `${total((s) => s.reopened)} reopened`,
    result.pruned > 0 && `${plural(result.pruned, "old job")} removed`,
  ].filter(Boolean);
  const problems = result.sources
    .filter((s) => s.status !== "ok" && s.status !== "skipped")
    .map((s) => `${s.label}: ${sourceStatusLabel(s.status)}.`);
  return [`${counts.join(", ")}.`, aiPassSummary(result.aiPass), ...problems].filter(Boolean).join(" ");
}

/** The AI eligibility pass in one sentence, or "" when it did not run or had nothing to read. */
function aiPassSummary(pass: RefreshResult["aiPass"]): string {
  switch (pass.kind) {
    case "not_run":
      return "";
    case "skipped":
      return "AI eligibility check skipped: it would go over your monthly cap.";
    case "ran": {
      if (pass.checked === 0 && pass.stopped === null) return "";
      const read = `AI placed ${pass.decided} of ${plural(pass.checked, "unclear job")}.`;
      return pass.stopped ? `${read} It stopped early: ${pass.stopped.message}` : read;
    }
    default: {
      const _exhaustive: never = pass;
      return _exhaustive;
    }
  }
}

const FINISHED = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

/**
 * "Refreshed 3 days ago" next to the button, so a stale feed is visible (decision 11). It reads the
 * newest refresh that finished, so it moves on as soon as a running one is done.
 */
function RefreshAge({ at }: { at: string | null }) {
  const now = useMinuteClock();
  const className = "hidden whitespace-nowrap text-muted-foreground text-xs tabular-nums lg:inline";
  if (at === null) return <span className={className}>{refreshedLabel({ at: null, now })}</span>;
  const finished = new Date(at);
  return (
    <time dateTime={at} title={`Last refresh finished ${FINISHED.format(finished)}`} className={className}>
      {refreshedLabel({ at: finished, now })}
    </time>
  );
}

/** How many jobs Matches can show, beside the refresh age. A link, so it doubles as a way there. */
function JobCount({ count }: { count: number }) {
  return (
    <Link
      to="/"
      title="Open jobs in Matches, not counting excluded ones"
      className="hidden whitespace-nowrap rounded-sm text-muted-foreground text-xs tabular-nums transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:inline"
    >
      {jobCountLabel(count)}
    </Link>
  );
}

/**
 * Starts a refresh and shows its step while it runs. When it finishes, the job list and the
 * sources page reload and a toast sums it up. A second press while one runs says so.
 *
 * Before any refresh has ever run, the button opens the sources panel instead (section 4, Setup
 * checklist): the five built-in boards as switches above their own Refresh button, so the user
 * can turn some off before the first sync.
 */
export function RefreshButton() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  const { run, pending } = useRunRefresh();
  const watching = useSyncExternalStore(subscribeWatched, watchedTask);
  const [panelOpen, setPanelOpen] = useState(false);
  const task = refresh.data?.task ?? null;
  const running = task?.status === "running";
  const neverRefreshed = refresh.data !== undefined && refresh.data.task === null;

  useEffect(() => {
    if (!task) return;
    if (task.status === "running") {
      if (watching !== task.id) setWatched(task.id);
      return;
    }
    if (watching !== task.id) return;
    setWatched(null);
    void qc.invalidateQueries({ queryKey: keys.matches });
    void qc.invalidateQueries({ queryKey: keys.sources });
    void qc.invalidateQueries({ queryKey: keys.board });
    void qc.invalidateQueries({ queryKey: keys.setup });
    // A Refresh ends by filling exchange rates (decision 67).
    void qc.invalidateQueries({ queryKey: keys.settings });
    if (task.status === "done" && refresh.data?.result) toast(`Refresh done. ${summary(refresh.data.result)}`);
    else if (task.status === "failed") toast.error(`Refresh failed. ${task.error ?? ""}`.trim());
  }, [task, watching, refresh.data?.result, qc]);

  const button = (
    <Button
      size="sm"
      variant="outline"
      // Before any refresh the popover trigger opens the panel instead; see below.
      onClick={neverRefreshed ? undefined : () => run()}
      // Until the newest refresh is known, a click could skip the first-run panel.
      disabled={running || pending || refresh.isPending}
      aria-live="polite"
    >
      <RefreshCwIcon aria-hidden />
      {running ? <span className="max-w-56 truncate">Refreshing · {task.step}</span> : "Refresh"}
    </Button>
  );

  // Nothing until the newest refresh is known, so a loading bar never reads "Not refreshed yet".
  const age = refresh.data && (
    <>
      <RefreshAge at={refresh.data.lastRefreshedAt} />
      <JobCount count={refresh.data.openJobs} />
    </>
  );
  if (!neverRefreshed) {
    return (
      <>
        {age}
        {button}
      </>
    );
  }
  return (
    <>
      {age}
      <Popover open={panelOpen} onOpenChange={setPanelOpen}>
        <PopoverTrigger asChild>{button}</PopoverTrigger>
        <PopoverContent aria-label="First refresh" align="end" className="w-96">
          <PopoverHeader className="mb-1">
            <PopoverTitle>Your first refresh</PopoverTitle>
            <PopoverDescription>Refresh reads every board that is on. Turn off any you don't want.</PopoverDescription>
          </PopoverHeader>
          <SourcesPanel onClose={() => setPanelOpen(false)} />
        </PopoverContent>
      </Popover>
    </>
  );
}
