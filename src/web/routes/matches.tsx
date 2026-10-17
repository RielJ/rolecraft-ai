import { Link, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { JobId, MatchItem, MatchQueryInput } from "@/shared/api";
import { DISMISS_REASONS, type DismissReason } from "@/shared/enums";
import { dismissReasonLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { JobList, JobListSkeleton } from "../components/job-list";
import { ReadingPane } from "../components/reading-pane";
import { SetupChecklist } from "../components/setup-checklist";
import { ShortcutSheet } from "../components/shortcut-sheet";
import { setAddJobOpen } from "../components/top-bar";
import {
  useDismissJob,
  useMatchDetail,
  useMatches,
  useMergeJob,
  usePrefetchMatch,
  useSaveJob,
  useSetup,
  useUndoJob,
} from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Label } from "../ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Toggle } from "../ui/toggle";

/** The last save or dismiss, recorded when it starts so a quick `z` still finds it. */
type LastAction = { id: JobId; action: "save" | "dismiss"; done: Promise<unknown> };

/** Keys are ignored while focus is in a text field or a dialog (section 4). */
function ignoreKeys(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("input, textarea, select, [role='dialog']")) return true;
  // Enter and Space keep their own meaning on buttons and links.
  return (e.key === "Enter" || e.key === " ") && target.closest("button, a") !== null;
}

/** Wait for typing to settle before searching. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The posting's page for `v`: only an http(s) address from the job's own data opens. */
function postingUrl(job: MatchItem | null): string | null {
  const raw = job?.applyUrl ?? job?.seenOn[0]?.listingUrl;
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The reason popover for `d`, anchored at the selected row (section 4). */
function DismissPopover({
  open,
  onChoose,
  onCancel,
  restoreFocus,
}: {
  open: boolean;
  onChoose: (reason: DismissReason | null) => void;
  onCancel: () => void;
  restoreFocus: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={(next) => !next && onCancel()}>
      <PopoverAnchor className="absolute inset-x-3 bottom-0 h-0" />
      <PopoverContent
        ref={contentRef}
        aria-label="Dismiss reason"
        align="start"
        className="w-60 p-1 duration-150 ease-out"
        // Focus the panel, not the first reason, so Enter means "without a reason".
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreFocus();
        }}
        tabIndex={-1}
        onKeyDown={(e) => {
          const index = Number(e.key) - 1;
          const reason = DISMISS_REASONS[index];
          if (reason && e.key.length === 1) {
            e.preventDefault();
            onChoose(reason);
          } else if (e.key === "Enter" && e.target === contentRef.current) {
            e.preventDefault();
            onChoose(null);
          }
        }}
      >
        <p className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">Dismiss: why?</p>
        {DISMISS_REASONS.map((reason, i) => (
          <Button
            key={reason}
            variant="ghost"
            size="sm"
            className="w-full justify-between font-normal"
            onClick={() => onChoose(reason)}
          >
            {dismissReasonLabel(reason)}
            <Kbd>{i + 1}</Kbd>
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="w-full justify-between font-normal" onClick={() => onChoose(null)}>
          Without a reason
          <Kbd>Enter</Kbd>
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Matches (section 4): triage new postings from the keyboard. The list is an inbox: saved and
 * dismissed jobs leave it at once, and the next job is selected without waiting on the server.
 */
/**
 * No jobs at all: the setup checklist while any step is undone (section 4), else a pointer to
 * Refresh and Sources. The checklist scrolls inside the page's fixed-height grid row.
 */
function NoJobsYet() {
  const setup = useSetup();
  if (setup.data && !setup.data.done) {
    return (
      <div className="min-h-0 overflow-y-auto pb-4">
        <SetupChecklist />
      </div>
    );
  }
  return (
    <p className="max-w-3xl text-muted-foreground">
      No open jobs yet. Press Refresh to read your sources, or add a company board under{" "}
      <Link to="/sources" className="underline underline-offset-4 hover:text-foreground">
        Sources
      </Link>
      .
    </p>
  );
}

export function MatchesPage() {
  const navigate = useNavigate();
  const searchId = useId();
  const payId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  // Null until the user edits the pay filter: the minimum pay saved on Profile applies.
  const [payText, setPayText] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showUnsure, setShowUnsure] = useState(true);
  const q = useSettled(search.trim(), 250);
  // Blank turns the filter off (0); untouched leaves it to the saved minimum (undefined).
  const payAtLeast = useSettled(payText === null ? undefined : Number(payText) || 0, 400);
  const query: MatchQueryInput = {
    q: q || undefined,
    excluded: showExcluded ? "true" : undefined,
    unsure: showUnsure ? undefined : "false",
    payAtLeast,
  };
  const matches = useMatches(query);

  // Jobs saved or dismissed here leave the list before the server answers.
  const [gone, setGone] = useState<ReadonlySet<JobId>>(new Set());
  const visible: MatchItem[] = (matches.data?.jobs ?? []).filter((j) => !gone.has(j.id));
  const [selectedId, setSelectedId] = useState<JobId | null>(null);
  // Where the selection was, so a row leaving the list hands it to its neighbour.
  const lastIndex = useRef(0);
  const foundIndex = visible.findIndex((j) => j.id === selectedId);
  const index = foundIndex >= 0 ? foundIndex : Math.min(lastIndex.current, visible.length - 1);
  const current = visible[index] ?? null;
  useEffect(() => {
    if (foundIndex >= 0) lastIndex.current = foundIndex;
  }, [foundIndex]);

  const detail = useMatchDetail(current?.id ?? null);
  const shownDetail = current ? (detail.data ?? null) : null;
  const prefetch = usePrefetchMatch();
  const nextId = visible[index + 1]?.id;
  const prevId = visible[index - 1]?.id;
  useEffect(() => {
    if (nextId) void prefetch(nextId);
    if (prevId) void prefetch(prevId);
  }, [nextId, prevId, prefetch]);

  const [dismissing, setDismissing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [last, setLast] = useState<LastAction | null>(null);
  const save = useSaveJob();
  const dismiss = useDismissJob();
  const undo = useUndoJob();
  const merge = useMergeJob();
  const [mergingInto, setMergingInto] = useState<JobId | null>(null);

  // Focus the list once there is something in it, so the keys work at once.
  const hasJobs = visible.length > 0;
  useEffect(() => {
    if (hasJobs && document.activeElement === document.body) listRef.current?.focus();
  }, [hasJobs]);

  function select(i: number) {
    const job = visible[Math.max(0, Math.min(i, visible.length - 1))];
    if (job) setSelectedId(job.id);
  }

  /** Take a job out of the list and select the one after it (or before, at the end). */
  function leave(id: JobId) {
    const i = visible.findIndex((j) => j.id === id);
    const next = visible[i + 1] ?? visible[i - 1] ?? null;
    setGone((g) => new Set(g).add(id));
    setSelectedId(next?.id ?? null);
    lastIndex.current = Math.max(0, i);
  }

  function back(id: JobId) {
    setGone((g) => {
      const copy = new Set(g);
      copy.delete(id);
      return copy;
    });
  }

  function saveCurrent() {
    if (!current) return;
    const { id } = current;
    leave(id);
    const done = save.mutateAsync(id);
    setLast({ id, action: "save", done });
    done.catch((error: unknown) => {
      back(id);
      setLast((l) => (l?.done === done ? null : l));
      toast.error(`Could not save the job. ${errorMessage(error)}`);
    });
  }

  function openCurrent() {
    if (!current) return;
    const { id } = current;
    save.mutate(id, {
      onSuccess: ({ opportunityId }) => {
        leave(id);
        void navigate({ to: "/jobs/$opportunityId", params: { opportunityId } });
      },
      onError: (error) => toast.error(`Could not open the job. ${errorMessage(error)}`),
    });
  }

  function dismissCurrent(reason: DismissReason | null) {
    setDismissing(false);
    if (!current) return;
    const { id } = current;
    leave(id);
    const done = dismiss.mutateAsync({ id, reason });
    setLast({ id, action: "dismiss", done });
    done.catch((error: unknown) => {
      back(id);
      setLast((l) => (l?.done === done ? null : l));
      toast.error(`Could not dismiss the job. ${errorMessage(error)}`);
    });
  }

  /** Undo waits for the action it undoes; if that failed, its own error already showed. */
  function undoLast() {
    if (!last) return;
    const { id, action, done } = last;
    setLast(null);
    done.then(
      () =>
        undo.mutateAsync({ id, action }).then(
          () => {
            back(id);
            setSelectedId(id);
          },
          (error: unknown) => {
            setLast({ id, action, done });
            toast.error(errorMessage(error));
          },
        ),
      () => {},
    );
  }

  /**
   * Merge the shown job into a likely duplicate (section 3.8). The server keeps whichever has an
   * opportunity, else the duplicate. If the shown job went, the kept one is selected when it is in
   * the list; otherwise the next job is.
   */
  function mergeCurrent(into: JobId) {
    if (!current || mergingInto) return;
    const { id } = current;
    setMergingInto(into);
    merge.mutate(
      { id, into },
      {
        onSuccess: ({ jobId }) => {
          if (jobId === id) {
            toast("Merged. This job now lists both postings.");
            return;
          }
          leave(id);
          if (visible.some((j) => j.id === jobId)) setSelectedId(jobId);
          toast("Merged into the other job.");
        },
        onError: (error) => toast.error(`Could not merge. ${errorMessage(error)}`),
        onSettled: () => setMergingInto(null),
      },
    );
  }

  function openPosting() {
    const url = postingUrl(current);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  function scrollPane(direction: 1 | -1) {
    const pane = paneRef.current;
    if (pane) pane.scrollBy({ top: direction * pane.clientHeight * 0.85, behavior: "instant" });
  }

  // One handler for the page's keys, kept current without re-subscribing.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (dismissing || sheetOpen || ignoreKeys(e)) return;
    const handled = (() => {
      switch (e.key) {
        case "j":
        case "ArrowDown":
          select(index + 1);
          return true;
        case "k":
        case "ArrowUp":
          select(index - 1);
          return true;
        case "Home":
          select(0);
          return true;
        case "End":
          select(visible.length - 1);
          return true;
        case " ":
          scrollPane(e.shiftKey ? -1 : 1);
          return true;
        case "Enter":
        case "o":
          openCurrent();
          return true;
        case "s":
          saveCurrent();
          return true;
        case "d":
          if (current) setDismissing(true);
          return true;
        case "z":
          undoLast();
          return true;
        case "v":
          openPosting();
          return true;
        case "/":
          searchRef.current?.focus();
          return true;
        case "e":
          setShowExcluded((x) => !x);
          return true;
        case "a":
          setAddJobOpen(true);
          return true;
        case "?":
          setSheetOpen(true);
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const payFilter = matches.data?.payFilter;
  const filtered = q !== "" || showExcluded || !showUnsure || (payFilter?.atLeast ?? null) !== null;
  function clearFilters() {
    setSearch("");
    // Off, not back to the saved minimum: clearing means show everything.
    setPayText("");
    setShowExcluded(false);
    setShowUnsure(true);
  }

  const counts = matches.data?.counts;
  return (
    <div className="grid h-[calc(100dvh-8.5rem)] min-h-96 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="mr-3 font-semibold text-2xl tracking-tight">Matches</h1>
        <div className="relative w-full max-w-64">
          <Label htmlFor={searchId} className="sr-only">
            Search jobs
          </Label>
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            ref={searchRef}
            type="search"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter") {
                e.preventDefault();
                listRef.current?.focus();
              }
            }}
            className="h-8 pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={payId} className="text-muted-foreground text-sm">
            Pay at least
          </Label>
          <Input
            id={payId}
            inputMode="numeric"
            placeholder={`${matches.data?.viewCurrency ?? ""} a month`.trim()}
            value={payText ?? (payFilter?.from === "profile" ? String(payFilter.atLeast) : "")}
            onChange={(e) => setPayText(e.target.value.replace(/[^\d]/g, ""))}
            aria-describedby={`${payId}-note`}
            className="h-8 w-32 tabular-nums"
          />
          <span id={`${payId}-note`} className="text-muted-foreground text-xs">
            {payText === null && payFilter?.from === "profile" ? (
              "From your profile"
            ) : payText === null && payFilter?.missingRate ? (
              <Link to="/settings" hash="money" className="underline underline-offset-4 hover:text-foreground">
                Set a {payFilter.missingRate} rate to use your minimum pay
              </Link>
            ) : null}
          </span>
        </div>
        <Toggle variant="outline" size="sm" pressed={showUnsure} onPressedChange={setShowUnsure}>
          Role unclear
        </Toggle>
        <Toggle variant="outline" size="sm" pressed={showExcluded} onPressedChange={setShowExcluded}>
          Excluded
        </Toggle>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setSheetOpen(true)}>
          Shortcuts <Kbd>?</Kbd>
        </Button>
      </div>

      {matches.isPending ? (
        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <JobListSkeleton />
        </div>
      ) : matches.isError ? (
        <div
          role="alert"
          className="flex h-fit max-w-3xl items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm"
        >
          <span>Could not load matches. {errorMessage(matches.error)}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => matches.refetch()}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        counts && counts.open === 0 ? (
          <NoJobsYet />
        ) : (
          <div className="flex h-fit flex-wrap items-center gap-3 text-muted-foreground">
            <p>Nothing new. Refresh, or loosen the filters</p>
            {filtered && (
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        )
      ) : (
        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
            <JobList
              ref={listRef}
              jobs={visible}
              selected={current?.id ?? null}
              onSelect={(id) => {
                setSelectedId(id);
                listRef.current?.focus();
              }}
              atSelected={
                <DismissPopover
                  open={dismissing}
                  onChoose={dismissCurrent}
                  onCancel={() => setDismissing(false)}
                  restoreFocus={() => listRef.current?.focus()}
                />
              }
            />
            <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
              {[
                plural(visible.length, "job"),
                counts && counts.excluded > 0 && `${counts.excluded} excluded hidden (e to show)`,
                counts && counts.unsure > 0 && `${counts.unsure} role unclear hidden`,
                counts && counts.belowPay > 0 && `${counts.belowPay} below your pay filter`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <ReadingPane
            ref={paneRef}
            job={shownDetail}
            stale={detail.isPlaceholderData || detail.isFetching}
            onSave={saveCurrent}
            onDismiss={() => setDismissing(true)}
            onMerge={mergeCurrent}
            merging={mergingInto}
          />
        </div>
      )}
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
