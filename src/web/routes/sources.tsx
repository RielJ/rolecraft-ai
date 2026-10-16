import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { SourceDto } from "@/shared/api";
import { sourceStatusLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { cn } from "../lib/utils";
import { useAddSource, useDeleteSource, useSources, useUpdateSource } from "../queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

const onError = (error: unknown) => toast.error(errorMessage(error));
const WHEN = new Intl.DateTimeFormat("en-PH", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Manila",
});

/** "Kept 12 of 140" from the last run's counts (section 3.7a). */
function keptLine(source: SourceDto): string | null {
  if (source.lastCount === null) return null;
  const dropped = source.lastDropped ?? 0;
  return dropped > 0
    ? `Kept ${source.lastCount} of ${source.lastCount + dropped}`
    : `${source.lastCount} ${source.lastCount === 1 ? "posting" : "postings"}`;
}

function SourceRow({ source }: { source: SourceDto }) {
  const id = useId();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const problem = source.lastStatus !== null && source.lastStatus !== "ok" && source.lastStatus !== "skipped";
  const kept = keptLine(source);
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
      <Switch
        id={`${id}-on`}
        className="mt-0.5"
        checked={source.enabled}
        aria-label={`Use ${source.label} on Refresh`}
        onCheckedChange={(enabled) => update.mutate({ id: source.id, enabled }, { onError })}
      />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-on`} className="font-medium">
            {source.label}
          </Label>
          <span className="text-muted-foreground text-xs">
            {source.builtin ? "Built-in board" : `Greenhouse · ${source.board}`}
          </span>
          {source.lastStatus && (
            <Badge variant={problem ? "destructive" : "secondary"}>{sourceStatusLabel(source.lastStatus)}</Badge>
          )}
        </div>
        <p className="text-muted-foreground text-sm">
          {source.lastRunAt ? `Last run ${WHEN.format(new Date(source.lastRunAt))}` : "Not run yet"}
          {kept && ` · ${kept}`}
        </p>
        {source.lastError && (
          <p className={cn("text-sm", problem ? "text-destructive" : "text-muted-foreground")}>{source.lastError}</p>
        )}
      </div>
      {!source.builtin && (
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate(source.id, { onSuccess: () => toast(`Removed ${source.label}.`), onError })}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

function AddBoardForm() {
  const id = useId();
  const add = useAddSource();
  const [url, setUrl] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(url, {
      onSuccess: (source) => {
        setUrl("");
        toast(`Added ${source.label}. Its jobs arrive on the next Refresh.`);
      },
    });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-2" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-semibold text-lg">
        Add a company board
      </h2>
      <Label htmlFor={`${id}-url`} className="font-normal text-muted-foreground">
        Paste a company's careers link from Greenhouse, for example boards.greenhouse.io/acme.
      </Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          required
          value={url}
          aria-invalid={add.isError}
          aria-describedby={add.isError ? `${id}-err` : undefined}
          onChange={(e) => {
            setUrl(e.target.value);
            add.reset();
          }}
        />
        <Button type="submit" disabled={add.isPending || url.trim() === ""}>
          {add.isPending ? "Checking…" : "Add board"}
        </Button>
      </div>
      {add.isError && (
        <p id={`${id}-err`} role="alert" className="text-destructive text-sm">
          {errorMessage(add.error)}
        </p>
      )}
    </form>
  );
}

export function SourcesPage() {
  const sources = useSources();
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Sources</h1>
        <p className="text-muted-foreground text-sm">
          Refresh reads every source that is on. Built-in boards use your target titles from Profile; company boards
          read the whole board.
        </p>
      </div>
      {sources.isPending ? (
        <div className="grid max-w-2xl gap-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : sources.isError ? (
        <div
          role="alert"
          className="flex max-w-2xl items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm"
        >
          <span>Could not load sources. {errorMessage(sources.error)}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => sources.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <ul aria-label="Sources" className="max-w-2xl divide-y border-y">
          {sources.data.sources.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      )}
      <AddBoardForm />
    </div>
  );
}
