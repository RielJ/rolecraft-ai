import { useId } from "react";
import { toast } from "sonner";
import type { ChangeStatus, ChangeView, OpportunityId, OutputId, TailoringDto, TailorOpKind } from "@/shared/api";
import type { RequirementWeight } from "@/shared/enums";
import { errorMessage } from "../api";
import { cn } from "../lib/utils";
import { useDecideChanges } from "../queries";
import { Button } from "../ui/button";

const OP_LABEL: Record<TailorOpKind, string> = {
  summary: "New summary",
  order: "Reordered",
  reword: "Reworded",
  remove: "Removed",
  add: "Added",
};

const WEIGHT_LABEL: Record<RequirementWeight, string> = { must: "Required", duty: "Duty", nice: "Nice to have" };

/** What the change does to the CV: old text struck through, new text below. */
function ChangeText({ change }: { change: ChangeView }) {
  if (change.op === "order") {
    // The order the resume uses now: the new one when kept, the CV's when undone.
    const kept = change.status === "accepted";
    const lines = (kept ? change.afterList : change.beforeList) ?? [];
    return (
      <>
        <p className="text-muted-foreground text-xs">{kept ? "New order" : "Your CV's order"}</p>
        <ol className="list-decimal pl-5">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </>
    );
  }
  return (
    <>
      {change.before !== null && (
        <p className="text-muted-foreground">
          <span className="sr-only">Was: </span>
          <span className="line-through decoration-1">{change.before}</span>
        </p>
      )}
      {change.after !== null && (
        <p>
          <span className="sr-only">Now: </span>
          {change.after}
        </p>
      )}
    </>
  );
}

function ChangeRow({
  change,
  busy,
  onDecide,
}: {
  change: ChangeView;
  busy: boolean;
  onDecide: (status: ChangeStatus) => void;
}) {
  const kept = change.status === "accepted";
  const name = [OP_LABEL[change.op], change.where].filter(Boolean).join(", ");
  return (
    <li className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{OP_LABEL[change.op]}</span>
        {change.where && <span className="min-w-0 text-muted-foreground text-xs">{change.where}</span>}
        <fieldset aria-label={name} className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={kept ? "secondary" : "ghost"}
            aria-pressed={kept}
            disabled={busy}
            onClick={() => !kept && onDecide("accepted")}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant={kept ? "ghost" : "secondary"}
            aria-pressed={!kept}
            disabled={busy}
            onClick={() => kept && onDecide("rejected")}
          >
            Undo
          </Button>
        </fieldset>
      </div>
      <div className={cn("grid gap-1", !kept && "opacity-60")}>
        <ChangeText change={change} />
        {!kept && <p className="text-muted-foreground text-xs">Undone. Your CV's version is used.</p>}
      </div>
      {change.reasons.length > 0 && (
        <p className="flex flex-wrap gap-1 text-xs">
          <span className="text-muted-foreground">For:</span>
          {change.reasons.map((r) => (
            <span key={r.id} className="rounded-full border px-2 py-0.5">
              {r.text}
            </span>
          ))}
        </p>
      )}
      {change.note && <p className="text-muted-foreground text-xs">{change.note}</p>}
    </li>
  );
}

/**
 * The changes a tailored resume made to the user's CV (decision 75), each kept or undone on its
 * own or all at once. The PDF and the copy text follow at once. Below them: what the posting asks
 * for that no fact shows, and how many suggestions the checks left out.
 */
export function TailorChanges({
  opportunityId,
  outputId,
  tailoring,
}: {
  opportunityId: OpportunityId;
  outputId: OutputId;
  tailoring: TailoringDto;
}) {
  const headingId = useId();
  const decide = useDecideChanges(opportunityId);
  const { changes, gaps, dropped, baseChanged } = tailoring;
  const kept = changes.filter((c) => c.status === "accepted");
  const undone = changes.filter((c) => c.status === "rejected");
  const run = (ids: string[], status: ChangeStatus) => {
    if (ids.length === 0) return;
    decide.mutate({ id: outputId, ids, status }, { onError: (error) => toast.error(errorMessage(error)) });
  };
  return (
    <section aria-labelledby={headingId} className="grid max-w-[68ch] gap-3 rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={headingId} className="font-medium">
          Changes from your CV
        </h3>
        {changes.length > 0 && (
          <p className="text-muted-foreground tabular-nums" aria-live="polite">
            {kept.length} of {changes.length} kept
          </p>
        )}
        {changes.length > 1 && (
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || undone.length === 0}
              onClick={() =>
                run(
                  undone.map((c) => c.id),
                  "accepted",
                )
              }
            >
              Keep all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || kept.length === 0}
              onClick={() =>
                run(
                  kept.map((c) => c.id),
                  "rejected",
                )
              }
            >
              Undo all
            </Button>
          </div>
        )}
      </div>
      {baseChanged && (
        <p className="text-warning-foreground">
          Your CV changed after this draft. Regenerate to start from the new one.
        </p>
      )}
      {changes.length === 0 ? (
        <p className="text-muted-foreground">No changes. This is your CV as you wrote it.</p>
      ) : (
        <ul className="divide-y">
          {changes.map((change) => (
            <ChangeRow
              key={change.id}
              change={change}
              busy={decide.isPending}
              onDecide={(status) => run([change.id], status)}
            />
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p className="text-muted-foreground text-xs">
          {dropped === 1
            ? "1 suggested change was left out because your CV and facts don't back it."
            : `${dropped} suggested changes were left out because your CV and facts don't back them.`}
        </p>
      )}
      {gaps.length > 0 && (
        <details className="group">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground">
            Asked for, not on your CV <span className="tabular-nums">({gaps.length})</span>
          </summary>
          <ul className="mt-2 grid gap-1">
            {gaps.map((gap) => (
              <li key={gap.id}>
                <span className="text-muted-foreground">{WEIGHT_LABEL[gap.weight]}:</span> {gap.text}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground text-xs">
            If you have done one of these, add it as a fact in Profile, then regenerate.
          </p>
        </details>
      )}
    </section>
  );
}
