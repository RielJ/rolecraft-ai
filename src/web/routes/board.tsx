import { Link } from "@tanstack/react-router";
import { statusLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { useBoard } from "../queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const DATE = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });

/** Slice 1: a plain list of saved jobs. Status columns arrive in slice 4. */
export function BoardPage() {
  const board = useBoard();

  return (
    <div className="grid gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">Board</h1>
      {board.isPending ? (
        <ul aria-busy="true" aria-label="Loading saved jobs" className="divide-y border-y">
          {[0, 1, 2].map((n) => (
            <li key={n} className="h-[60px] animate-pulse bg-muted/40" />
          ))}
        </ul>
      ) : board.isError ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
          <span>Could not load your board. {errorMessage(board.error)}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => board.refetch()}>
            Retry
          </Button>
        </div>
      ) : board.data.length === 0 ? (
        <p className="text-muted-foreground">Nothing on the board yet. Add a job with the button above.</p>
      ) : (
        <section aria-labelledby="saved">
          <h2 id="saved" className="mb-2 font-medium text-muted-foreground text-sm">
            Saved <span className="tabular-nums">{board.data.length}</span>
          </h2>
          <ul className="divide-y border-y">
            {board.data.map((item) => (
              <li key={item.opportunityId}>
                <Link
                  to="/jobs/$opportunityId"
                  params={{ opportunityId: item.opportunityId }}
                  className="flex min-h-[60px] items-center gap-4 px-2 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block truncate text-muted-foreground text-sm">{item.company}</span>
                  </span>
                  {item.ready && <Badge variant="secondary">Ready</Badge>}
                  <span className="text-muted-foreground text-sm">{statusLabel(item)}</span>
                  <time dateTime={item.savedAt} className="w-14 text-right text-muted-foreground text-sm tabular-nums">
                    {DATE.format(new Date(item.savedAt))}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
