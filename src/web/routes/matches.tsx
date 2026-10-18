import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { JobId, MatchItem, MatchQueryInput, OpportunityId } from "@/shared/api";
import { DISMISS_REASONS, type DismissReason } from "@/shared/enums";
import { dismissReasonLabel, matchLevelLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { JobList, JobListSkeleton, optionId } from "../components/job-list";
import { type PaneActions, ReadingPane } from "../components/reading-pane";
import { SetupChecklist } from "../components/setup-checklist";
import { ShortcutSheet } from "../components/shortcut-sheet";
import { setAddJobOpen } from "../components/top-bar";
import { clearReturn, readReturn, rememberReturn } from "../lib/matches-return";
import { useIsWide } from "../lib/use-media-query";
import { useSettled } from "../lib/use-settled";
import { cn } from "../lib/utils";
import {
  useDismissJob,
  useMatchDetail,
  useMatches,
  useMergeJob,
  usePrefetchMatch,
  useSaveJob,
  useSetup,
  useStartDraft,
  useUndoJob,
} from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Label } from "../ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type Layout = "split" | "focus";
const LAYOUT_KEY = "hb.matches.layout";
/** Matches opens in the layout used last (list beside the job, or one job at a time). */
function storedLayout(): Layout {
  return localStorage.getItem(LAYOUT_KEY) === "focus" ? "focus" : "split";
}

/** Previous and next, with where you are: "12 of 219 · Possible". */
function Pager({
  index,
  total,
  level,
  onMove,
  className,
}: {
  index: number;
  total: number;
  level: string | null;
  onMove: (step: 1 | -1) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous job"
        aria-keyshortcuts="k ArrowLeft"
        disabled={index <= 0}
        onClick={() => onMove(-1)}
      >
        <ChevronLeftIcon aria-hidden />
      </Button>
      <span aria-live="polite" className="min-w-24 text-center text-muted-foreground text-xs tabular-nums">
        {index + 1} of {total}
        {level && ` · ${level}`}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next job"
        aria-keyshortcuts="j ArrowRight"
        disabled={index >= total - 1}
        onClick={() => onMove(1)}
      >
        <ChevronRightIcon aria-hidden />
      </Button>
    </div>
  );
}

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
        className="w-60 animate-none! rounded-lg p-1"
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
            static
            variant="ghost"
            size="sm"
            className="w-full justify-between rounded-sm font-normal"
            onClick={() => onChoose(reason)}
          >
            {dismissReasonLabel(reason)}
            <Kbd>{i + 1}</Kbd>
          </Button>
        ))}
        <Button
          static
          variant="ghost"
          size="sm"
          className="w-full justify-between rounded-sm font-normal"
          onClick={() => onChoose(null)}
        >
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
      <div className="min-h-0 overflow-y-auto overscroll-contain pb-4">
        <SetupChecklist />
      </div>
    );
  }
  return (
    <p className="surface h-fit max-w-3xl rounded-xl p-6 text-muted-foreground">
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
  // Coming back from Start application's workspace: pick up at the job after the one started.
  const [selectedId, setSelectedId] = useState<JobId | null>(() => readReturn()?.nextJobId ?? null);
  useEffect(() => clearReturn(), []);
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  function setLayout(next: Layout) {
    setLayoutState(next);
    localStorage.setItem(LAYOUT_KEY, next);
  }
  const isWide = useIsWide();
  // The list shows beside the job only on a wide screen in the split layout.
  const listBeside = isWide && layout === "split";
  // Where the selection was, so a row leaving the list hands it to its neighbour.
  const lastIndex = useRef(0);
  const foundIndex = visible.findIndex((j) => j.id === selectedId);
  const index = foundIndex >= 0 ? foundIndex : Math.min(lastIndex.current, visible.length - 1);
  const current = visible[index] ?? null;
  useEffect(() => {
    if (foundIndex >= 0) lastIndex.current = foundIndex;
  }, [foundIndex]);

  // Phones show the list or one job, not both; wider screens show both and ignore this.
  const [phoneView, setPhoneView] = useState<"list" | "job">("list");
  const currentId = current?.id ?? null;
  // A new job opens at its top, in the pane on wide screens and on the page on phones.
  useEffect(() => {
    if (!currentId) return;
    paneRef.current?.scrollTo({ top: 0 });
    if (phoneView === "job") window.scrollTo({ top: 0 });
  }, [currentId, phoneView]);
  useEffect(() => {
    if (!currentId) setPhoneView("list");
  }, [currentId]);

  function backToList() {
    setPhoneView("list");
    // The list was hidden, not unmounted; bring the job you were reading back into view.
    requestAnimationFrame(() => {
      if (currentId) document.getElementById(optionId(currentId))?.scrollIntoView({ block: "center" });
    });
  }

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
  // How the shortcut sheet opened: by `?` it opens and closes with no motion (section 4).
  const [sheet, setSheet] = useState<"closed" | "key" | "click">("closed");
  const sheetOpen = sheet !== "closed";
  const [last, setLast] = useState<LastAction | null>(null);
  const save = useSaveJob();
  const startDraft = useStartDraft();
  const dismiss = useDismissJob();
  const undo = useUndoJob();
  const merge = useMergeJob();
  const [mergingInto, setMergingInto] = useState<JobId | null>(null);

  // Focus the list once there is something in it, so the keys work at once.
  const hasJobs = visible.length > 0;
  useEffect(() => {
    if (hasJobs && document.activeElement === document.body) listRef.current?.focus({ preventScroll: true });
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

  const openWorkspace = (opportunityId: OpportunityId) =>
    void navigate({ to: "/jobs/$opportunityId", params: { opportunityId } });

  /** Save for later: to the Board, on to the next job, with Open and Undo in the toast. */
  function saveCurrent() {
    if (!current) return;
    const { id } = current;
    leave(id);
    const done = save.mutateAsync(id);
    const action: LastAction = { id, action: "save", done };
    setLast(action);
    done.then(
      ({ opportunityId }) =>
        toast("Saved to Board", {
          id: `saved-${id}`,
          action: { label: "Open", onClick: () => openWorkspace(opportunityId) },
          cancel: { label: "Undo", onClick: () => undoAction(action) },
        }),
      (error: unknown) => {
        back(id);
        setLast((l) => (l?.done === done ? null : l));
        toast.error(`Could not save the job. ${errorMessage(error)}`);
      },
    );
  }

  /**
   * Save and write files: save, then start drafting the resume and cover letter in the background
   * (a task, as the workspace's Draft starts). No undo: the files are already being written, so the
   * job is closed on the Board instead. If drafting is refused (no AI, the spend cap, a question
   * only you can answer), the job stays saved and the toast says why.
   */
  function saveAndWriteCurrent() {
    if (!current) return;
    const { id } = current;
    leave(id);
    save.mutateAsync(id).then(
      ({ opportunityId }) => {
        const open = { label: "Open", onClick: () => openWorkspace(opportunityId) };
        startDraft.mutate(
          { opportunityId, json: {} },
          {
            onSuccess: () => toast("Saved. Writing the files in the background.", { id: `saved-${id}`, action: open }),
            onError: (error) =>
              toast.warning(`Saved to Board, but the files were not started. ${errorMessage(error)}`, {
                id: `saved-${id}`,
                action: open,
              }),
          },
        );
      },
      (error: unknown) => {
        back(id);
        toast.error(`Could not save the job. ${errorMessage(error)}`);
      },
    );
  }

  /** Start application: save, then open the workspace to apply or write the files now. */
  function startCurrent() {
    if (!current) return;
    const { id } = current;
    const i = visible.findIndex((j) => j.id === id);
    const nextJobId = (visible[i + 1] ?? visible[i - 1])?.id ?? null;
    save.mutate(id, {
      onSuccess: ({ opportunityId }) => {
        rememberReturn({ opportunityId, nextJobId });
        leave(id);
        openWorkspace(opportunityId);
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

  function undoLast() {
    if (last) undoAction(last);
  }

  /** Undo waits for the action it undoes; if that failed, its own error already showed. */
  function undoAction(target: LastAction) {
    const { id, action, done } = target;
    setLast((l) => (l === target ? null : l));
    toast.dismiss(`saved-${id}`);
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
        case "ArrowRight":
          select(index + 1);
          return true;
        case "k":
        case "ArrowUp":
        case "ArrowLeft":
          select(index - 1);
          return true;
        case "l":
          setLayout(layout === "split" ? "focus" : "split");
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
          startCurrent();
          return true;
        case "s":
          saveCurrent();
          return true;
        case "S":
          saveAndWriteCurrent();
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
          setAddJobOpen(true, "key");
          return true;
        case "?":
          setSheet("key");
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
  const summary = [
    plural(visible.length, "job"),
    counts && counts.excluded > 0 && `${counts.excluded} excluded hidden (e to show)`,
    counts && counts.unsure > 0 && `${counts.unsure} role unclear hidden`,
    counts && counts.belowPay > 0 && `${counts.belowPay} below your pay filter`,
  ]
    .filter(Boolean)
    .join(" · ");

  // On a phone the list and the job take turns; on a wide screen the layout decides.
  const listHidden = isWide ? layout === "focus" : phoneView === "job";
  const paneHidden = !isWide && phoneView === "list";
  const pager = (
    <Pager
      index={index}
      total={visible.length}
      level={current ? matchLevelLabel(current.level) : null}
      onMove={(step) => select(index + step)}
    />
  );
  // The dismiss reasons open at whatever is on screen: the row, the header's buttons, or the phone's bar.
  const dismissPopover = (
    <DismissPopover
      open={dismissing}
      onChoose={dismissCurrent}
      onCancel={() => setDismissing(false)}
      restoreFocus={() => (listBeside ? listRef.current?.focus() : undefined)}
    />
  );
  const paneActions: PaneActions = {
    onStart: startCurrent,
    onSave: saveCurrent,
    onSaveAndWrite: saveAndWriteCurrent,
    onDismiss: () => setDismissing(true),
  };

  return (
    <div className="grid gap-4 md:h-[calc(100dvh-8.5rem)] md:min-h-96 md:grid-rows-[auto_minmax(0,1fr)]">
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", !isWide && phoneView === "job" && "hidden")}>
        <h1 className="display mr-3 text-3xl max-md:w-full">Matches</h1>
        <div className="relative w-full md:max-w-64">
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
          {/* Open jobs that exclude the Philippines, shown or not (decision 53). Part of the name. */}
          {counts && <span className="text-muted-foreground tabular-nums">{counts.excludedOpen}</span>}
        </Toggle>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Layout"
          value={layout}
          onValueChange={(v) => v && setLayout(v === "focus" ? "focus" : "split")}
          className="ml-auto max-md:hidden"
        >
          <ToggleGroupItem value="split" aria-keyshortcuts="l" className="px-3">
            List
          </ToggleGroupItem>
          <ToggleGroupItem value="focus" aria-keyshortcuts="l" className="px-3">
            One at a time
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground max-md:hidden"
          onClick={() => setSheet("click")}
        >
          Shortcuts <Kbd>?</Kbd>
        </Button>
      </div>

      {matches.isPending ? (
        <div className="surface grid min-h-0 overflow-hidden rounded-xl md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <div className="md:border-r">
            <JobListSkeleton />
          </div>
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
        // One frame. Split: the list beside the job, mail-style. One at a time: the job fills it.
        // On phones the job replaces the list.
        <div
          className={cn(
            "surface grid min-h-0 rounded-xl md:overflow-hidden",
            listBeside && "md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]",
          )}
        >
          <div className={cn("grid min-h-0 grid-rows-[minmax(0,1fr)_auto] md:border-r", listHidden && "hidden")}>
            <JobList
              ref={listRef}
              jobs={visible}
              selected={current?.id ?? null}
              onSelect={(id) => {
                setSelectedId(id);
                setPhoneView("job");
                listRef.current?.focus({ preventScroll: true });
              }}
              atSelected={listHidden ? null : dismissPopover}
            />
            <p aria-live="polite" className="border-t px-4 py-2 text-muted-foreground text-xs tabular-nums">
              {summary}
            </p>
          </div>
          <ReadingPane
            ref={paneRef}
            job={shownDetail}
            stale={detail.isPlaceholderData || detail.isFetching}
            layout={isWide ? layout : "split"}
            actions={paneActions}
            onMerge={mergeCurrent}
            merging={mergingInto}
            dismissAnchor={isWide && listHidden ? dismissPopover : null}
            phoneDismissAnchor={!isWide && listHidden ? dismissPopover : null}
            top={
              isWide ? (
                layout === "focus" && (
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b bg-card px-4 py-1.5">
                    {pager}
                    <span className="truncate text-muted-foreground text-xs tabular-nums">{summary}</span>
                  </div>
                )
              ) : (
                <div className="flex items-center justify-between gap-2 px-2 pt-2">
                  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={backToList}>
                    <ArrowLeftIcon aria-hidden />
                    All matches
                  </Button>
                  {pager}
                </div>
              )
            }
            className={cn(paneHidden && "hidden")}
          />
        </div>
      )}
      <ShortcutSheet open={sheetOpen} instant={sheet === "key"} onOpenChange={(open) => !open && setSheet("closed")} />
    </div>
  );
}
