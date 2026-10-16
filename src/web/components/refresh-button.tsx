import { useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { RefreshResult } from "@/shared/api";
import { sourceStatusLabel } from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { keys, useRefresh, useStartRefresh } from "../queries";
import { Button } from "../ui/button";

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
  return [`${counts.join(", ")}.`, ...problems].join(" ");
}

/**
 * Starts a refresh and shows its step while it runs. When it finishes, the job list and the
 * sources page reload and a toast sums it up. A second press while one runs says so.
 */
export function RefreshButton() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  const start = useStartRefresh();
  const task = refresh.data?.task ?? null;
  const running = task?.status === "running";
  // The task this tab started or saw running; its finish is announced once. State, not a ref:
  // a quick refresh can be done before the POST's answer sets it, and setting it must re-run
  // the effect so that finish is still announced.
  const [watching, setWatching] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    if (task.status === "running") {
      setWatching(task.id);
      return;
    }
    if (watching !== task.id) return;
    setWatching(null);
    void qc.invalidateQueries({ queryKey: keys.jobs });
    void qc.invalidateQueries({ queryKey: keys.sources });
    void qc.invalidateQueries({ queryKey: keys.board });
    if (task.status === "done" && refresh.data?.result) toast(`Refresh done. ${summary(refresh.data.result)}`);
    else if (task.status === "failed") toast.error(`Refresh failed. ${task.error ?? ""}`.trim());
  }, [task, watching, refresh.data?.result, qc]);

  function run() {
    start.mutate(undefined, {
      onSuccess: (started) => setWatching(started.id),
      onError: (error) => {
        if (error instanceof ApiError && error.code === "refresh_running") toast("A refresh is already running.");
        else toast.error(errorMessage(error));
      },
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={run} disabled={running || start.isPending} aria-live="polite">
      <RefreshCwIcon aria-hidden className={running ? "animate-spin motion-reduce:animate-none" : undefined} />
      {running ? <span className="max-w-56 truncate">Refreshing · {task.step}</span> : "Refresh"}
    </Button>
  );
}
