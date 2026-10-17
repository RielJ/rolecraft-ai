import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { SourceDto } from "@/shared/api";
import { SOURCE_SITES, sourceStatusLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { cn } from "../lib/utils";
import { useAddSource, useDeleteSource, useSources, useUpdateSource } from "../queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

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

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * A built-in board's keywords (decision 13): its own list, or the target titles from Profile when
 * it has none. Saving an empty list goes back to the target titles.
 */
function KeywordsEditor({ source }: { source: SourceDto }) {
  const id = useId();
  const update = useUpdateSource();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  function edit() {
    setText((source.keywords ?? []).join("\n"));
    update.reset();
    setOpen(true);
  }

  function save(keywords: string[] | null) {
    update.mutate(
      { id: source.id, keywords },
      {
        onSuccess: () => {
          setOpen(false);
          toast(keywords === null ? `${source.label} uses your target titles.` : `Saved ${source.label}'s keywords.`);
        },
      },
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const keywords = lines(text);
    save(keywords.length === 0 ? null : keywords);
  }

  if (!open) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">Keywords:</span>{" "}
        {source.keywords === null ? "your target titles" : source.keywords.join(", ")}{" "}
        <Button
          type="button"
          size="sm"
          variant="link"
          className="ml-1 h-auto p-0 align-baseline"
          aria-label={`Edit ${source.label} keywords`}
          onClick={edit}
        >
          Edit
        </Button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor={`${id}-kw`} className="font-normal text-muted-foreground text-sm">
        {source.label} keywords, one per line. A posting is kept when its title or tags match one. Leave empty to use
        your target titles.
      </Label>
      <Textarea
        id={`${id}-kw`}
        rows={3}
        value={text}
        aria-invalid={update.isError}
        aria-describedby={update.isError ? `${id}-err` : undefined}
        onChange={(e) => setText(e.target.value)}
      />
      {update.isError && (
        <p id={`${id}-err`} role="alert" className="text-destructive text-sm">
          {errorMessage(update.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save keywords"}
        </Button>
        {source.keywords !== null && (
          <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => save(null)}>
            Use target titles
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Where a source's jobs come from, linked: "Built-in board · via remoteok.com" or "Lever · acme".
 * RemoteOK, We Work Remotely and Remotive ask for this credit and a link back.
 */
function SourceOrigin({ source }: { source: SourceDto }) {
  const site = SOURCE_SITES[source.kind];
  const link = (text: string) => (
    <a href={site.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {text}
    </a>
  );
  if (source.builtin) {
    return (
      <span className="text-muted-foreground text-xs">
        Built-in board · via {link(new URL(site.url).hostname.replace(/^www\./, ""))}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      {link(site.name)} · {source.board}
    </span>
  );
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
          <SourceOrigin source={source} />
          {source.lastStatus && (
            <Badge variant={problem ? "destructive" : "secondary"}>{sourceStatusLabel(source.lastStatus)}</Badge>
          )}
        </div>
        <p className="text-muted-foreground text-sm tabular-nums">
          {source.lastRunAt ? `Last run ${WHEN.format(new Date(source.lastRunAt))}` : "Not run yet"}
          {kept && ` · ${kept}`}
        </p>
        {source.lastError && (
          <p className={cn("text-sm", problem ? "text-destructive" : "text-muted-foreground")}>{source.lastError}</p>
        )}
        {source.builtin && <KeywordsEditor source={source} />}
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
    <form id="add-board" onSubmit={submit} className="grid max-w-2xl gap-2" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-semibold text-lg">
        Add a company board
      </h2>
      <Label htmlFor={`${id}-url`} className="font-normal text-muted-foreground">
        Paste a company's job list link from Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee or Workable, for
        example jobs.lever.co/acme.
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
        <h1 className="display text-3xl">Sources</h1>
        <p className="text-muted-foreground text-sm">
          Refresh reads every source that is on. Built-in boards keep postings that match their keywords, which are your
          target titles from Profile unless you set others; company boards read the whole board.
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
        <div className="grid max-w-2xl gap-3">
          <ul aria-label="Sources" className="divide-y border-y">
            {sources.data.sources.map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
          </ul>
          {sources.data.sources.every((s) => s.builtin) && (
            <p className="text-muted-foreground text-sm">No company boards yet. Add one below.</p>
          )}
        </div>
      )}
      <AddBoardForm />
    </div>
  );
}
