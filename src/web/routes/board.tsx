import { Link } from "@tanstack/react-router";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BoardItemDto, ChangeStatusInput, ContractTerms, OpportunityId } from "@/shared/api";
import { OPEN_STATUSES, OPPORTUNITY_STATUSES, type OpportunityStatus, OUTCOMES } from "@/shared/enums";
import { outcomeLabel, rateTypeLabel, statusLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { AddJobDialog } from "../components/add-job-dialog";
import { cn } from "../lib/utils";
import { useBoard, useChangeStatus } from "../queries";
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
const AMOUNT = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });

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
  const rate = [terms.rateCurrency, terms.rateAmount === null ? null : AMOUNT.format(terms.rateAmount)]
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
        <Button size="icon-sm" variant="ghost" aria-label={`Move ${item.title}`} className="shrink-0">
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

function BoardRow({
  item,
  arrived,
  refocus,
  onMove,
}: {
  item: BoardItemDto;
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
        "flex items-start gap-1 py-2",
        // Only a pointer move eases the row into its new column; keyboard moves are instant.
        arrived && "fade-in-0 slide-in-from-top-1 animate-in duration-200 ease-out motion-reduce:animate-none",
      )}
    >
      <Link
        ref={link}
        to="/jobs/$opportunityId"
        params={{ opportunityId: item.opportunityId }}
        onKeyDown={onKeyDown}
        aria-keyshortcuts="1 2 3 4 5"
        className="grid min-w-0 flex-1 gap-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="line-clamp-2 font-medium text-sm leading-snug">{item.title}</span>
        <span className="truncate text-muted-foreground text-sm">{item.company}</span>
        {item.contract && (
          <span className="text-pretty text-muted-foreground text-xs tabular-nums">
            {item.status === "applied" ? "Proposal sent" : "Contract"} · {termsLine(item.contract)}
          </span>
        )}
        {item.outcome && <span className="text-muted-foreground text-xs">{outcomeLabel(item.outcome)}</span>}
        {item.followUp && (
          <span className="text-warning-foreground text-xs">
            No change in <span className="tabular-nums">{item.followUp.days}</span> days. Follow up or close?
          </span>
        )}
        <span className="flex items-center gap-2 pt-0.5">
          {item.ready && item.status === "saved" && <Badge variant="secondary">Ready</Badge>}
          <time dateTime={item.statusChangedAt} className="text-muted-foreground text-xs tabular-nums">
            {DATE.format(new Date(item.statusChangedAt))}
          </time>
        </span>
      </Link>
      <RowMenu
        item={item}
        closing={menu === "close"}
        open={menu !== null}
        onOpenChange={(open) => setMenu(open ? "move" : null)}
        onMove={onMove}
      />
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
  return (
    <section aria-labelledby={heading} className="grid min-w-0 content-start gap-2">
      <h2 id={heading} className="flex items-baseline justify-between gap-2 px-2 font-medium text-sm">
        {COLUMN_LABEL[status]} <span className="text-muted-foreground tabular-nums">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="border-t px-2 py-3 text-muted-foreground text-sm">None</p>
      ) : (
        <ul className="divide-y border-t">
          {items.map((item) => (
            <BoardRow
              key={item.opportunityId}
              item={item}
              arrived={item.opportunityId === arrived}
              refocus={item.opportunityId === moved}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const COLUMNS_GRID = "grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-5";

function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your board" className={COLUMNS_GRID}>
      {OPPORTUNITY_STATUSES.map((status) => (
        <div key={status} className="grid content-start gap-2">
          <Skeleton className="mx-2 h-5 w-24" />
          <div className="grid gap-2 border-t pt-2">
            <Skeleton className="h-[72px]" />
            <Skeleton className="h-[72px]" />
          </div>
        </div>
      ))}
    </div>
  );
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
        <h1 className="font-semibold text-2xl tracking-tight">Board</h1>
        {board.data && board.data.length > 0 && (
          <p className="hidden text-muted-foreground text-sm sm:block">
            Focus a row and press <kbd className="font-sans">1</kbd> to <kbd className="font-sans">5</kbd> to move it.
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
        <div className="grid justify-items-start gap-3 py-8">
          <p className="text-muted-foreground">Nothing on the board yet. Save a match or add a job by link.</p>
          <Button onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden />
            Add by link
          </Button>
          <AddJobDialog open={adding} onOpenChange={setAdding} />
        </div>
      ) : (
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
      )}
    </div>
  );
}
