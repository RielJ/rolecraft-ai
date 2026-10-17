import { Link } from "@tanstack/react-router";
import { CircleCheckIcon, CircleIcon } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import type { SetupDto, SetupStepId, SourceDto } from "@/shared/api";
import { BUILTIN_SOURCE_KINDS, type BuiltinSourceKind, type SourceKind } from "@/shared/enums";
import { BUILTIN_SOURCE_NOTES } from "@/shared/labels";
import { errorMessage } from "../api";
import { cn } from "../lib/utils";
import { useRefresh, useSetup, useSources, useUpdateSource } from "../queries";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { useRunRefresh } from "./run-refresh";

const isBuiltinKind = (kind: SourceKind): kind is BuiltinSourceKind => BUILTIN_SOURCE_KINDS.some((k) => k === kind);

/** Where each step is done. The first-refresh step carries its own panel instead of a link. */
type StepLink = { to: "/settings" | "/profile" | "/sources"; hash?: string; label: string };

type StepCopy = { title: string; detail: string; link: StepLink | null };

function stepCopy(id: SetupStepId, aiVia: SetupDto["aiVia"]): StepCopy {
  switch (id) {
    case "ai":
      return aiVia === "pi"
        ? {
            title: "AI runs through pi",
            detail: "This copy uses the pi CLI on this machine, so it needs no key.",
            link: null,
          }
        : {
            title: "Add an AI key",
            detail: "AI splits your CV into facts and drafts your files. The key stays in a file on this machine.",
            link: { to: "/settings", hash: "ai", label: "Add your key" },
          };
    case "cv":
      return {
        title: "Add your CV",
        detail: "Upload your CV or paste it. It becomes short facts you confirm.",
        link: { to: "/profile", hash: "cv", label: "Add your CV" },
      };
    case "facts":
      return {
        title: "Confirm your facts",
        detail: "Only confirmed facts reach drafts and match scores.",
        link: { to: "/profile", hash: "facts", label: "Review facts" },
      };
    case "preferences":
      return {
        title: "Set your targeting",
        detail: "Target titles and role families decide which postings Refresh keeps.",
        link: { to: "/profile", hash: "targeting", label: "Set targeting" },
      };
    case "sources":
      return {
        title: "Pick your sources",
        detail: "Refresh reads every source that is on. Turn at least one on.",
        link: { to: "/sources", label: "Open Sources" },
      };
    case "first_refresh":
      return {
        title: "Run your first refresh",
        detail: "Turn off any board you don't want, then refresh.",
        link: null,
      };
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/**
 * The five built-in boards as switches above a Refresh button (section 4, Setup checklist). The
 * checklist's first-refresh step shows it inline, and the top bar's Refresh opens it before any
 * refresh has run. Both read and write `sources.enabled`; there is no separate first-run state.
 */
export function SourcesPanel({ onClose }: { onClose?: (() => void) | undefined }) {
  const id = useId();
  const sources = useSources();
  const update = useUpdateSource();
  const refresh = useRefresh();
  const { run, pending } = useRunRefresh();
  const running = refresh.data?.task?.status === "running";

  if (sources.isPending) return <p className="text-muted-foreground text-sm">Loading sources…</p>;
  if (sources.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <span>Could not load sources. {errorMessage(sources.error)}</span>
        <Button size="sm" variant="outline" onClick={() => sources.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const builtins = sources.data.sources.flatMap((s): (SourceDto & { kind: BuiltinSourceKind })[] =>
    isBuiltinKind(s.kind) ? [{ ...s, kind: s.kind }] : [],
  );
  const anyOn = sources.data.sources.some((s) => s.enabled);

  return (
    <div className="grid gap-3">
      <ul aria-label="Built-in boards" className="divide-y">
        {builtins.map((source) => (
          <li key={source.id} className="flex items-start gap-3 py-2.5">
            <Switch
              id={`${id}-${source.kind}`}
              className="mt-0.5"
              checked={source.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) =>
                update.mutate({ id: source.id, enabled }, { onError: (error) => toast.error(errorMessage(error)) })
              }
            />
            <div className="grid min-w-0 gap-0.5">
              <Label htmlFor={`${id}-${source.kind}`} className="font-medium">
                {source.label}
              </Label>
              <p className="text-muted-foreground text-xs">{BUILTIN_SOURCE_NOTES[source.kind]}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">
        Applying to a company directly?{" "}
        <Link
          to="/sources"
          hash="add-board"
          onClick={onClose}
          className="text-foreground underline underline-offset-4 hover:text-primary"
        >
          Add a company board
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => run({ onStarted: onClose })} disabled={!anyOn || pending || running || update.isPending}>
          {running ? "Refreshing…" : "Refresh"}
        </Button>
        {!anyOn && <p className="text-muted-foreground text-sm">Turn on at least one board to refresh.</p>}
      </div>
    </div>
  );
}

/**
 * The first-run checklist (section 4): six steps in any order, each ticked from data by
 * `GET /api/setup`. It renders nothing while loading, on error, and once every step is done.
 */
export function SetupChecklist({ className }: { className?: string }) {
  const setup = useSetup();
  if (!setup.data || setup.data.done) return null;
  const { steps, aiVia } = setup.data;
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;

  return (
    <section aria-labelledby="setup-h" className={cn("surface-glow grid max-w-2xl gap-4 rounded-2xl p-6", className)}>
      <div>
        <h2 id="setup-h" className="display text-2xl">
          Get set up
        </h2>
        <p className="text-muted-foreground text-sm">
          <span className="tabular-nums">
            {doneCount} of {steps.length}
          </span>{" "}
          done. Any order works.
        </p>
      </div>
      <ol aria-label="Setup steps" className="divide-y border-t">
        {steps.map((step) => {
          const copy = stepCopy(step.id, aiVia);
          return (
            <li key={step.id} className="flex items-start gap-3 py-3 last:pb-0">
              {step.done ? (
                <CircleCheckIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              ) : (
                <CircleIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="grid min-w-0 flex-1 gap-1">
                <p className={cn("font-medium", step.done && "text-muted-foreground")}>
                  {copy.title}
                  <span className="sr-only">{step.done ? ", done" : ", to do"}</span>
                </p>
                {!step.done && <p className="text-muted-foreground text-sm">{copy.detail}</p>}
                {!step.done && step.id === "first_refresh" && (
                  <div className="mt-2">
                    <SourcesPanel />
                  </div>
                )}
              </div>
              {!step.done && copy.link && (
                <Button asChild size="sm" variant={step.id === next ? "default" : "outline"} className="shrink-0">
                  <Link to={copy.link.to} {...(copy.link.hash ? { hash: copy.link.hash } : {})}>
                    {copy.link.label}
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
