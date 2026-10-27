import type { ExtensionOutputDto } from "@shared/extension";
import type { DraftState, OutputsState, PanelEvent } from "./state";
import { unansweredQuestions } from "./state";

// Custom questions on this job that have no answer yet. "Draft" asks Rolecraft to write one,
// one at a time; a drafted answer comes back unreviewed and fills only after the user OKs it.

function DraftStatus({
  draft,
  output,
  dispatch,
}: {
  draft: DraftState;
  output: ExtensionOutputDto;
  dispatch: (event: PanelEvent) => void;
}) {
  if (draft.kind === "idle" || draft.outputId !== output.id) return null;
  switch (draft.kind) {
    case "starting":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          Starting…
        </p>
      );
    case "running":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {draft.task.step || "Drafting…"}
        </p>
      );
    case "done":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          Drafted.
        </p>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-1.5">
          <p role="alert" className="text-xs text-destructive">
            {draft.message}
          </p>
          {draft.overCap && (
            <button
              type="button"
              className="btn-secondary self-start"
              onClick={() => dispatch({ kind: "draft_clicked", outputId: output.id, confirmOverCap: true })}
            >
              Draft anyway
            </button>
          )}
        </div>
      );
    default: {
      const exhaustive: never = draft;
      return exhaustive;
    }
  }
}

export function DraftProgress({
  outputs,
  draft,
  dispatch,
}: {
  outputs: OutputsState;
  draft: DraftState;
  dispatch: (event: PanelEvent) => void;
}) {
  if (outputs.kind === "loading") return null;
  if (outputs.kind === "failed") {
    return <p className="text-xs text-muted-foreground">Couldn't load this job's answers: {outputs.message}</p>;
  }
  const open = unansweredQuestions(outputs.outputs);
  if (open.length === 0) return null;
  const busy = draft.kind === "starting" || draft.kind === "running";

  return (
    <section aria-labelledby="draft-title" className="flex flex-col gap-1.5">
      <h3 id="draft-title" className="text-sm font-semibold">
        Questions without an answer{" "}
        <span className="font-normal text-muted-foreground tabular-nums">{open.length}</span>
      </h3>
      <p className="text-xs text-muted-foreground">
        Drafting uses your AI budget. A drafted answer fills only after you check it.
      </p>
      <ul className="divide-y divide-border rounded-control border border-border">
        {open.map((output) => (
          <li key={output.id} className="flex flex-col gap-1.5 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm break-words">{output.question ?? "Untitled question"}</p>
              <button
                type="button"
                className="btn-secondary shrink-0"
                disabled={busy}
                onClick={() => dispatch({ kind: "draft_clicked", outputId: output.id, confirmOverCap: false })}
              >
                Draft
              </button>
            </div>
            <DraftStatus draft={draft} output={output} dispatch={dispatch} />
          </li>
        ))}
      </ul>
    </section>
  );
}
