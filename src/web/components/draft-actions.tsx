import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { DraftInput, OverCapDetails, TaskId, WorkspaceDto } from "@/shared/api";
import { ApiError, errorMessage } from "../api";
import { useDraft, useRetryTask } from "../queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/** What to run once the user confirms: a new draft or a retry of a failed task. */
type Pending = { kind: "draft"; input: DraftInput } | { kind: "retry"; taskId: TaskId };

/** A draft request as the UI sees it, before any confirmation. */
export type DraftRequest = {
  input: DraftInput;
  /** Shown in the replace-edits confirmation, e.g. "the resume" or "all files". */
  what: string;
  /** True when a target has user edits that the draft would replace. */
  replacesEdits: boolean;
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Starting and retrying draft tasks, with the two confirmations they can need: replacing edited
 * text, and going over the monthly cap (`402 over_cap`). Render `dialogs` once per page.
 */
export function useDraftActions(ws: WorkspaceDto): {
  request: (req: DraftRequest) => void;
  retry: (taskId: TaskId) => void;
  starting: boolean;
  dialogs: ReactNode;
} {
  const draft = useDraft(ws.opportunity.id);
  const retryTask = useRetryTask(ws.opportunity.id);
  const [replace, setReplace] = useState<DraftRequest | null>(null);
  const [overCap, setOverCap] = useState<{ pending: Pending; details: OverCapDetails } | null>(null);

  function run(pending: Pending, confirmOverCap: boolean) {
    const onError = (error: unknown) => {
      const details = error instanceof ApiError ? error.overCap : null;
      if (details) setOverCap({ pending, details });
      else toast.error(errorMessage(error));
    };
    if (pending.kind === "draft") draft.mutate({ ...pending.input, confirmOverCap }, { onError });
    else retryTask.mutate({ id: pending.taskId, confirmOverCap }, { onError });
  }

  const dialogs = (
    <>
      <AlertDialog open={replace !== null} onOpenChange={(open) => !open && setReplace(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You edited {replace?.what ?? "this file"} by hand. A new draft replaces that text, and your edits cannot
              be brought back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (replace) run({ kind: "draft", input: replace.input }, false);
                setReplace(null);
              }}
            >
              Draft again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={overCap !== null} onOpenChange={(open) => !open && setOverCap(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go over your monthly cap?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <p>This draft would take this month's AI spend past the cap you set.</p>
                {overCap && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-foreground tabular-nums">
                    <dt className="text-muted-foreground">Spent this month</dt>
                    <dd>{usd(overCap.details.monthUsd)}</dd>
                    <dt className="text-muted-foreground">This draft, at most</dt>
                    <dd>{usd(overCap.details.estimateUsd)}</dd>
                    <dt className="text-muted-foreground">Your cap</dt>
                    <dd>{usd(overCap.details.capUsd)}</dd>
                  </dl>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Link to="/settings">Change the cap</Link>
            </AlertDialogCancel>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overCap) run(overCap.pending, true);
                setOverCap(null);
              }}
            >
              Draft anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return {
    request: (req) => {
      if (req.replacesEdits) setReplace(req);
      else run({ kind: "draft", input: req.input }, false);
    },
    retry: (taskId) => run({ kind: "retry", taskId }, false),
    starting: draft.isPending || retryTask.isPending,
    dialogs,
  };
}

/** The draft task's state as text: its step while running, its error with Retry after a failure. */
export function DraftStatus({
  task,
  onRetry,
  busy,
}: {
  task: WorkspaceDto["draftTask"];
  onRetry: () => void;
  busy: boolean;
}) {
  if (!task) return null;
  switch (task.status) {
    case "running":
      return (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {task.step || "Starting the draft"}…
        </p>
      );
    case "failed":
    case "interrupted":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-destructive">
            {task.status === "interrupted"
              ? "Drafting stopped because the app restarted."
              : (task.error ?? "Drafting failed.")}
          </span>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
            Retry
          </Button>
        </div>
      );
    case "done":
      return null;
    default: {
      const _exhaustive: never = task.status;
      return _exhaustive;
    }
  }
}

/** Shown in place of Draft buttons when no AI key is saved. */
export function NoKeyHint() {
  return (
    <p className="text-muted-foreground text-sm">
      To draft with AI, add your key in{" "}
      <Link to="/settings" className="text-foreground underline underline-offset-4">
        Settings
      </Link>
      .
    </p>
  );
}
