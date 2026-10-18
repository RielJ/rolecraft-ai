import { Link } from "@tanstack/react-router";
import {
  BanknoteIcon,
  ClockIcon,
  EllipsisIcon,
  type LucideIcon,
  MapPinIcon,
  PlusIcon,
  StickyNoteIcon,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BoardItemDto, ChangeStatusInput, ContractTerms, OpportunityId } from "@/shared/api";
import { OPEN_STATUSES, OPPORTUNITY_STATUSES, type OpportunityStatus, OUTCOMES } from "@/shared/enums";
import {
  boardLocationLabel,
  inColumnLabel,
  metricsLine,
  outcomeLabel,
  postedLabel,
  rateTypeLabel,
  statusLabel,
} from "@/shared/labels";
import { errorMessage } from "../api";
import { AddJobDialog } from "../components/add-job-dialog";
import { FilteredOut } from "../components/filtered-out";
import { SetupChecklist } from "../components/setup-checklist";
import { useMinuteClock } from "../lib/use-minute-clock";
import { cn } from "../lib/utils";
import { useBoard, useBoardMetrics, useChangeStatus } from "../queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Skeleton } from "../ui/skeleton";

const DATE = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
/** "35.50", "1,200": cents only when there are any. */
const amount = (n: number) =>
  new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);

/** Column headings. Applied rows of contracts read "Proposal sent" on the row itself. */
const COLUMN_LABEL: Record<OpportunityStatus, string> = {
  saved: "Saved",
  applied: "Applied / Proposal sent",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

/** "USD 35.50 hourly · Upwork", or a prompt when nothing is filled in yet. */
function termsLine(terms: ContractTerms): string {
  const rate = [terms.rateCurrency, terms.rateAmount === null ? null : amount(terms.rateAmount)]
    .filter(Boolean)
    .join(" ");
  const parts = [
    rate && terms.rateType ? `${rate} ${rateTypeLabel(terms.rateType).toLowerCase()}` : rate,
    terms.platform,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No rate yet";
}

/** Focus a row's link, e.g. when its menu closes without a move. */
function focusRow(id: OpportunityId): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`#row-${id} a`)?.focus());
}

type Move = (item: BoardItemDto, change: ChangeStatusInput, how: "pointer" | "keyboard") => void;

function RowMenu({
  item,
  closing,
  open,
  onOpenChange,
  onMove,
}: {
  item: BoardItemDto;
  /** Opened with key 5: show only the outcomes. */
  closing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: Move;
}) {
  const content = useRef<HTMLDivElement>(null);
  // Opened with key 5: land on the first outcome, so 5 then Enter closes the job in two keys.
  useEffect(() => {
    if (!open || !closing) return;
    const frame = requestAnimationFrame(() =>
      content.current?.querySelector<HTMLElement>("[role=menuitem]:not([data-disabled])")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, closing]);
  const how = (event: { detail: number }) => (event.detail > 0 ? "pointer" : "keyboard");
  const outcomes = OUTCOMES.map((outcome) => (
    <DropdownMenuItem
      key={outcome}
      disabled={item.status === "closed" && item.outcome === outcome}
      onClick={(e) => onMove(item, { status: "closed", outcome }, how(e))}
    >
      {outcomeLabel(outcome)}
    </DropdownMenuItem>
  ));

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Move ${item.title}`}
          // Inset 6px in the card: 10px radius + 6px + the 1px border meets the card's 16px corner.
          className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <EllipsisIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={content}
        align="end"
        className="min-w-48"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusRow(item.opportunityId);
        }}
      >
        {closing ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Close as</DropdownMenuLabel>
            {outcomes}
          </DropdownMenuGroup>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {OPEN_STATUSES.map((status, index) => (
              <DropdownMenuItem
                key={status}
                disabled={item.status === status}
                onClick={(e) => onMove(item, { status }, how(e))}
              >
                {statusLabel({ type: item.type, status })}
                <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                Closed
                <DropdownMenuShortcut>5</DropdownMenuShortcut>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>{outcomes}</DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FULL_DATE = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "Asia/Manila" });

/** "Posted 12d ago", or "Found 3d ago" when the source gave no posting date. */
function PostedAge({ item, now }: { item: BoardItemDto; now: Date }) {
  const at = item.postedAt ?? item.firstSeenAt;
  const label = postedLabel({
    postedAt: item.postedAt === null ? null : new Date(item.postedAt),
    firstSeenAt: new Date(item.firstSeenAt),
    now,
  });
  const exact = FULL_DATE.format(new Date(at));
  return (
    <time
      dateTime={at}
      title={item.postedAt === null ? `No posting date given. First found ${exact}.` : `Posted ${exact}`}
      className="truncate tabular-nums"
    >
      {label}
    </time>
  );
}

/** How long the card has sat in its column: "20d" on the card, the full sentence for screen readers. */
function ColumnAge({ item, now }: { item: BoardItemDto; now: Date }) {
  const { short, long } = inColumnLabel({ since: new Date(item.statusChangedAt), now });
  const sentence =
    short === "Today"
      ? `In ${statusLabel(item)} ${long}`
      : `In ${statusLabel(item)} ${long}, since ${DATE.format(new Date(item.statusChangedAt))}`;
  return (
    <span title={sentence} className="flex shrink-0 items-center gap-1 tabular-nums">
      <ClockIcon aria-hidden className="size-3.5" absoluteStrokeWidth strokeWidth={1.5} />
      <span aria-hidden>{short}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/** One fact on a card: a small icon, then text that truncates. `label` is read before it by screen readers. */
function Fact({
  icon: Icon,
  label,
  title,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  className?: string;
  children: string;
}) {
  return (
    <span title={title ?? children} className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" absoluteStrokeWidth strokeWidth={1.5} />
      <span className="truncate">
        <span className="sr-only">{label}: </span>
        {children}
      </span>
    </span>
  );
}

/** Where it hires, the pay (or a contract's terms) and the first line of the notes, each when known. */
function CardFacts({ item }: { item: BoardItemDto }) {
  const location = boardLocationLabel(item);
  const note = item.notes.trim().split("\n")[0]?.trim() ?? "";
  // A contract's own terms stand in for posted pay; the "Contract" badge above says which it is.
  const pay = item.contract ? termsLine(item.contract) : item.pay;
  if (!location && !pay && !note) return null;
  return (
    <span className="grid gap-1 text-muted-foreground text-xs">
      {location && (
        <Fact
          icon={MapPinIcon}
          label="Location"
          title={item.locationText.trim() || location}
          className={cn(item.eligibility === "excluded" && "text-warning-foreground")}
        >
          {location}
        </Fact>
      )}
      {pay && (
        <Fact icon={BanknoteIcon} label="Pay" className="text-foreground/85 tabular-nums">
          {pay}
        </Fact>
      )}
      {note && (
        <Fact icon={StickyNoteIcon} label="Note" title={item.notes}>
          {note}
        </Fact>
      )}
    </span>
  );
}

function BoardRow({
  item,
  arrived,
  refocus,
  now,
  onMove,
}: {
  item: BoardItemDto;
  /** One clock per column, so "Posted 12d ago" moves on without a reload. */
  now: Date;
  /** Moved here by pointer: ease in. */
  arrived: boolean;
  /** Last moved row: take focus when it mounts in its new column, so keys keep working. */
  refocus: boolean;
  onMove: Move;
}) {
  const [menu, setMenu] = useState<"move" | "close" | null>(null);
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (refocus) link.current?.focus();
  }, [refocus]);

  // Keys 1 to 5 on a focused row (section 4). 5 needs an outcome, so it opens the outcome menu.
  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = Number(event.key) - 1;
    const status = OPPORTUNITY_STATUSES[index];
    if (!status || !Number.isInteger(index)) return;
    event.preventDefault();
    if (status === "closed") setMenu("close");
    else if (status !== item.status) onMove(item, { status }, "keyboard");
  }

  return (
    <li
      id={`row-${item.opportunityId}`}
      className={cn(
        // Only a pointer move eases the card into its new column; keyboard moves are instant.
        arrived && "fade-in-0 slide-in-from-top-1 animate-in transition-none duration-200 ease-out",
      )}
    >
      <div className="lift-card" data-follow-up={item.followUp ? "" : undefined}>
        {/* The whole card is the link; the menu sits in the corner above it. */}
        <Link
          ref={link}
          to="/jobs/$opportunityId"
          params={{ opportunityId: item.opportunityId }}
          onKeyDown={onKeyDown}
          aria-keyshortcuts="1 2 3 4 5"
          className="grid min-w-0 gap-3 rounded-[inherit] p-3 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {/* Who and what: tight together, apart from the facts below. */}
          <span className="grid gap-1">
            <span
              className={cn(
                // Clear of the menu in the corner.
                "line-clamp-2 text-pretty pr-7 font-medium text-sm leading-snug",
                item.status === "closed" && "text-muted-foreground",
              )}
            >
              {item.title}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-muted-foreground text-sm">{item.company}</span>
              {/* Badges sit right of the company; the company gives way when space runs out. */}
              <span className="ml-auto flex shrink-0 gap-1 empty:hidden">
                {item.contract && <Badge variant="outline">Contract</Badge>}
                {item.drafting === "running" && <Badge variant="outline">Writing files…</Badge>}
                {item.drafting === "failed" && <Badge variant="destructive">Files failed</Badge>}
                {item.ready && item.status === "saved" && !item.drafting && <Badge variant="secondary">Ready</Badge>}
                {item.outcome && <Badge variant="outline">{outcomeLabel(item.outcome)}</Badge>}
              </span>
            </span>
          </span>
          <CardFacts item={item} />
          {item.followUp && (
            <span className="text-pretty text-warning-foreground text-xs">
              No change in <span className="tabular-nums">{item.followUp.days}</span> days. Follow up or close?
            </span>
          )}
          <span className="flex min-w-0 items-center justify-between gap-2 border-border/60 border-t pt-2.5 text-muted-foreground text-xs">
            <PostedAge item={item} now={now} />
            <ColumnAge item={item} now={now} />
          </span>
        </Link>
        <RowMenu
          item={item}
          closing={menu === "close"}
          open={menu !== null}
          onOpenChange={(open) => setMenu(open ? "move" : null)}
          onMove={onMove}
        />
      </div>
    </li>
  );
}

function Column({
  status,
  items,
  arrived,
  moved,
  onMove,
}: {
  status: OpportunityStatus;
  items: BoardItemDto[];
  arrived: OpportunityId | null;
  moved: OpportunityId | null;
  onMove: Move;
}) {
  const heading = `col-${status}`;
  const now = useMinuteClock();
  return (
    <section aria-labelledby={heading} className="board-lane grid min-w-0 content-start gap-1.5">
      <h2 id={heading} className="flex items-baseline justify-between gap-2 px-2 pt-1 pb-0.5 font-medium text-sm">
        <span className="truncate">{COLUMN_LABEL[status]}</span>
        <span className="text-muted-foreground text-xs tabular-nums">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="px-2 py-6 text-center text-muted-foreground text-sm">None</p>
      ) : (
        <ul className="grid gap-1.5">
          {items.map((item) => (
            <BoardRow
              key={item.opportunityId}
              item={item}
              arrived={item.opportunityId === arrived}
              refocus={item.opportunityId === moved}
              now={now}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const COLUMNS_GRID = "grid gap-3 sm:grid-cols-2 lg:grid-cols-5";

function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your board" className={COLUMNS_GRID}>
      {OPPORTUNITY_STATUSES.map((status) => (
        <div key={status} className="board-lane grid content-start gap-1.5">
          <Skeleton className="mx-2 mt-1 mb-0.5 h-5 w-24" />
          {/* Card-colored, so the loading lane looks like the lane that replaces it. */}
          <Skeleton className="h-32 rounded-xl bg-card" />
          <Skeleton className="h-32 rounded-xl bg-card" />
        </div>
      ))}
    </div>
  );
}

/**
 * One quiet line for the last 30 days (decision 52). Saved to Ready is worded as elapsed time:
 * it includes idle time, so it is an upper bound, not time spent working.
 */
function MetricsLine() {
  const metrics = useBoardMetrics();
  if (!metrics.data) return null;
  return <p className="text-muted-foreground text-sm tabular-nums">{metricsLine(metrics.data)}</p>;
}

export function BoardPage() {
  const board = useBoard();
  const change = useChangeStatus();
  const [adding, setAdding] = useState(false);
  const [arrived, setArrived] = useState<OpportunityId | null>(null);
  const [moved, setMoved] = useState<OpportunityId | null>(null);

  const move = useCallback<Move>(
    (item, next, how) => {
      setArrived(how === "pointer" ? item.opportunityId : null);
      setMoved(item.opportunityId);
      change.mutate(
        { opportunityId: item.opportunityId, ...next },
        { onError: (error) => toast.error(`Could not move "${item.title}". ${errorMessage(error)}`) },
      );
    },
    [change.mutate],
  );

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="display text-3xl">Board</h1>
        {board.data && board.data.length > 0 && (
          <p className="hidden text-muted-foreground text-sm sm:block">
            Focus a card and press <kbd className="font-sans">1</kbd> to <kbd className="font-sans">5</kbd> to move it.
          </p>
        )}
      </div>
      {board.isPending ? (
        <BoardSkeleton />
      ) : board.isError ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
          <span>Could not load your board. {errorMessage(board.error)}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => board.refetch()}>
            Retry
          </Button>
        </div>
      ) : board.data.length === 0 ? (
        <div className="grid gap-6">
          <div className="surface grid max-w-2xl justify-items-start gap-3 rounded-xl p-6">
            <p className="text-muted-foreground">Nothing on the board yet. Save a match or add a job by link.</p>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden />
              Add by link
            </Button>
            <AddJobDialog open={adding} onOpenChange={setAdding} />
          </div>
          <SetupChecklist />
        </div>
      ) : (
        <div className="grid gap-4">
          <MetricsLine />
          <div className={COLUMNS_GRID}>
            {OPPORTUNITY_STATUSES.map((status) => (
              <Column
                key={status}
                status={status}
                items={board.data.filter((item) => item.status === status)}
                arrived={arrived}
                moved={moved}
                onMove={move}
              />
            ))}
          </div>
        </div>
      )}
      {board.isSuccess && <FilteredOut />}
    </div>
  );
}
