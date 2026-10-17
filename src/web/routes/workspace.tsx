import { CheckIcon, ExternalLinkIcon, InfoIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import type {
  ContractTerms,
  ContractTermsInput,
  GateBlocker,
  OpportunityId,
  OutputDto,
  OutputId,
  OverCapDetails,
  TaskId,
  WorkspaceDto,
} from "@/shared/api";
import { OpportunityType, RATE_TYPES, RateType } from "@/shared/enums";
import {
  CONTRACTOR_CAUTION,
  mustAnswerLabel,
  outcomeLabel,
  outputKindLabel,
  rateTypeLabel,
  statusLabel,
} from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { DraftStatus, NoKeyHint, useDraftActions } from "../components/draft-actions";
import { JobFacts, PossibleDuplicates } from "../components/job-facts";
import { NeedsInput } from "../components/needs-input";
import { OutdatedNotice, OutputEditor } from "../components/output-editor";
import {
  useAddQuestion,
  useChangeStatus,
  useDeleteQuestion,
  useMarkOutputCurrent,
  useMarkReady,
  useRetryTask,
  useSuggestQuestions,
  useUpdateOpportunity,
  useUpdateOutput,
  useWorkspace,
} from "../queries";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

const onError = (error: unknown) => toast.error(errorMessage(error));

function blockersFor(ws: WorkspaceDto, id: OutputId): GateBlocker[] {
  return ws.gate.ok ? [] : ws.gate.blockers.filter((b) => b.outputId === id);
}

type DraftActions = ReturnType<typeof useDraftActions>;

/** Ids the running draft task is writing right now; empty when none runs. */
function draftingIds(ws: WorkspaceDto): ReadonlySet<OutputId> {
  return ws.draftTask?.status === "running" ? new Set(ws.draftTask.outputIds) : new Set();
}

/** Remount editors when the server body changes by an edit or a new draft. */
const editorKey = (o: OutputDto) => `${o.id}:${o.editedAt ?? ""}:${o.generatedAt ?? ""}`;

/** Draft or Regenerate for one output. Null when drafting is not possible here. */
function DraftOne({
  ws,
  output,
  actions,
  variant = "outline",
}: {
  ws: WorkspaceDto;
  output: OutputDto;
  actions: DraftActions;
  variant?: "outline" | "default";
}) {
  if (ws.opportunity.frozen || !ws.aiReady || output.mustAnswer !== null) return null;
  const label = outputKindLabel(output.kind).toLowerCase();
  const busy = actions.starting || ws.draftTask?.status === "running";
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      onClick={() =>
        actions.request({
          input: { outputId: output.id },
          what: output.kind === "answer" ? "this answer" : `the ${label}`,
          replacesEdits: output.body !== null && output.editedAt !== null,
        })
      }
    >
      {output.body === null ? (output.kind === "answer" ? "Draft answer" : `Draft ${label}`) : "Regenerate"}
    </Button>
  );
}

function Outdated({ ws, output, actions }: { ws: WorkspaceDto; output: OutputDto; actions: DraftActions }) {
  const mark = useMarkOutputCurrent(ws.opportunity.id);
  return (
    <OutdatedNotice
      output={output}
      regenerate={<DraftOne ws={ws} output={output} actions={actions} variant="default" />}
      marking={mark.isPending}
      onMarkCurrent={() =>
        mark.mutate(output.id, { onSuccess: () => toast("Marked up to date with your facts."), onError })
      }
    />
  );
}

/** "Draft all" for the included files, the task's progress, and the no-key hint. */
function DraftBar({ ws, actions }: { ws: WorkspaceDto; actions: DraftActions }) {
  const included = ws.files.filter((f) => f.included);
  const running = ws.draftTask?.status === "running";
  const anyDrafted = included.some((f) => f.body !== null);
  if (ws.opportunity.frozen) return null;
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
      {ws.aiReady ? (
        <Button
          size="sm"
          disabled={included.length === 0 || running || actions.starting}
          title={included.length === 0 ? "Tick a file to draft it" : undefined}
          onClick={() =>
            actions.request({
              input: {},
              what: "one or more of these files",
              replacesEdits: included.some((f) => f.body !== null && f.editedAt !== null),
            })
          }
        >
          <SparklesIcon aria-hidden />
          {anyDrafted ? "Regenerate all" : "Draft all"}
        </Button>
      ) : (
        <NoKeyHint />
      )}
      <DraftStatus
        task={ws.draftTask}
        busy={actions.starting}
        onRetry={() => ws.draftTask && actions.retry(ws.draftTask.id)}
      />
    </div>
  );
}

function Files({
  ws,
  selected,
  onSelect,
  actions,
}: {
  ws: WorkspaceDto;
  selected: OutputId;
  onSelect: (id: OutputId) => void;
  actions: DraftActions;
}) {
  const update = useUpdateOutput(ws.opportunity.id);
  const current = ws.files.find((f) => f.id === selected) ?? ws.files[0];
  if (!current) return null;
  const label = outputKindLabel(current.kind);
  const drafting = draftingIds(ws);

  return (
    <section aria-label="Files" className="grid gap-4">
      <DraftBar ws={ws} actions={actions} />
      <div role="tablist" aria-label="Files" className="flex gap-1 border-b">
        {ws.files.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            id={`tab-${f.id}`}
            aria-selected={f.id === current.id}
            aria-controls={`panel-${f.id}`}
            onClick={() => onSelect(f.id)}
            className="-mb-px flex items-center gap-2 border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-selected:border-primary aria-selected:text-foreground"
          >
            <span className={f.included ? "" : "line-through decoration-1"}>{outputKindLabel(f.kind)}</span>
            {drafting.has(f.id) && <span className="text-muted-foreground text-xs">drafting</span>}
            {f.included && f.outdated.length > 0 && <span className="text-warning-foreground text-xs">outdated</span>}
            {f.included && blockersFor(ws, f.id).length > 0 && (
              <span className="size-1.5 rounded-full bg-warning" role="img" aria-label="needs input" />
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`} className="grid gap-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`include-${current.id}`}
            checked={current.included}
            disabled={ws.opportunity.frozen || update.isPending}
            onCheckedChange={(checked) => update.mutate({ id: current.id, included: checked === true }, { onError })}
          />
          <Label htmlFor={`include-${current.id}`}>Include the {label.toLowerCase()} in this application</Label>
        </div>
        {current.included ? (
          <OutputEditor
            key={editorKey(current)}
            output={current}
            frozen={ws.opportunity.frozen}
            blockers={blockersFor(ws, current.id)}
            blocked={!ws.gate.ok}
            saving={update.isPending}
            onSave={(body) => update.mutate({ id: current.id, body }, { onError })}
            drafting={drafting.has(current.id)}
            draftButton={<DraftOne ws={ws} output={current} actions={actions} />}
            outdated={<Outdated ws={ws} output={current} actions={actions} />}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Not included. It will not block export, and it is not part of this application.
          </p>
        )}
      </div>
    </section>
  );
}

function AnswerRow({ ws, answer, actions }: { ws: WorkspaceDto; answer: OutputDto; actions: DraftActions }) {
  const id = useId();
  const update = useUpdateOutput(ws.opportunity.id);
  const remove = useDeleteQuestion(ws.opportunity.id);
  const saved = answer.body ?? "";
  const [draft, setDraft] = useState(saved);
  const dirty = draft !== saved;
  const frozen = ws.opportunity.frozen;
  const drafting = draftingIds(ws).has(answer.id);
  const save = () => {
    if (dirty) update.mutate({ id: answer.id, body: draft.trim() === "" ? null : draft }, { onError });
  };

  return (
    <li id={`output-${answer.id}`} className="grid scroll-mt-20 gap-2 py-4">
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-inc`}
          className="mt-0.5"
          checked={answer.included}
          disabled={frozen || update.isPending}
          aria-label={`Include "${answer.question}"`}
          onCheckedChange={(checked) => update.mutate({ id: answer.id, included: checked === true }, { onError })}
        />
        <Label htmlFor={`${id}-body`} className="flex-1 font-medium leading-snug">
          {answer.question}
        </Label>
        {!answer.included && <span className="pt-0.5 text-muted-foreground text-xs">Not added</span>}
        {answer.mustAnswer && <Badge variant="outline">{mustAnswerLabel(answer.mustAnswer)}</Badge>}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete "${answer.question}"`}
          disabled={frozen || remove.isPending}
          onClick={() => remove.mutate(answer.id, { onError })}
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <div className="grid gap-2 pl-7">
        <Outdated ws={ws} output={answer} actions={actions} />
        <Textarea
          id={`${id}-body`}
          value={draft}
          readOnly={frozen || drafting}
          aria-busy={drafting}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          className="min-h-20 max-w-[68ch] font-serif"
          placeholder={
            answer.mustAnswer
              ? answer.profileAnswer
                ? `Uses your profile answer: ${answer.profileAnswer}`
                : "Answer here for this job, or save a standard answer under Needs your input."
              : "Write your answer. Cite facts with [FACT-n]."
          }
        />
        {answer.mustAnswer && answer.body === null && answer.profileAnswer && (
          <p className="text-muted-foreground text-sm">
            Using your profile answer. Type above to answer differently here.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <Button size="sm" onClick={save} disabled={update.isPending}>
              Save answer
            </Button>
          )}
          {drafting ? (
            <span className="text-muted-foreground text-sm">Drafting…</span>
          ) : (
            <DraftOne ws={ws} output={answer} actions={actions} />
          )}
        </div>
      </div>
    </li>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the last finished suggestion run found, as one line. */
function suggestSummary(result: { found: number; added: number }): string {
  if (result.found === 0) return "The posting asks no questions that the AI could find.";
  if (result.added === 0) return `Found ${plural(result.found, "question")}, all already listed.`;
  return `Added ${plural(result.added, "suggested question")}. Tick the ones the form asks.`;
}

/** "Suggest questions": a light-tier task with its step, its outcome, Retry, and the over-cap confirmation. */
function SuggestQuestions({ ws }: { ws: WorkspaceDto }) {
  const suggest = useSuggestQuestions(ws.opportunity.id);
  const retry = useRetryTask(ws.opportunity.id);
  const [overCap, setOverCap] = useState<{ details: OverCapDetails; retryId: TaskId | null } | null>(null);
  const task = ws.suggestTask;
  const busy = suggest.isPending || retry.isPending || task?.status === "running";
  if (ws.opportunity.frozen || !ws.aiReady) return null;

  function run({ confirmOverCap, retryId }: { confirmOverCap: boolean; retryId: TaskId | null }) {
    const onError = (error: unknown) => {
      const details = error instanceof ApiError ? error.overCap : null;
      if (details) setOverCap({ details, retryId });
      else toast.error(errorMessage(error));
    };
    if (retryId) retry.mutate({ id: retryId, confirmOverCap }, { onError });
    else suggest.mutate({ confirmOverCap }, { onError });
  }

  let status: ReactElement | null = null;
  if (task) {
    switch (task.status) {
      case "running":
        status = (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {task.step || "Starting"}…
          </p>
        );
        break;
      case "failed":
      case "interrupted":
        status = (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-destructive">
              {task.status === "interrupted"
                ? "Finding questions stopped because the app restarted."
                : (task.error ?? "Finding questions failed.")}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run({ confirmOverCap: false, retryId: task.id })}
            >
              Retry
            </Button>
          </div>
        );
        break;
      case "done":
        status = task.result && (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {suggestSummary(task.result)}
          </p>
        );
        break;
      default: {
        const _exhaustive: never = task.status;
        return _exhaustive;
      }
    }
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ confirmOverCap: false, retryId: null })}>
        <SparklesIcon aria-hidden />
        Suggest questions
      </Button>
      {status}
      <AlertDialog open={overCap !== null} onOpenChange={(open) => !open && setOverCap(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go over your monthly cap?</AlertDialogTitle>
            <AlertDialogDescription>
              Finding questions costs at most ${overCap?.details.estimateUsd.toFixed(4) ?? "0"}, which takes this
              month's AI spend past your ${overCap?.details.capUsd.toFixed(2) ?? "0"} cap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overCap) run({ confirmOverCap: true, retryId: overCap.retryId });
                setOverCap(null);
              }}
            >
              Find questions anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Questions({ ws, actions }: { ws: WorkspaceDto; actions: DraftActions }) {
  const id = useId();
  const add = useAddQuestion(ws.opportunity.id);
  const [question, setQuestion] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    add.mutate(question.trim(), { onSuccess: () => setQuestion(""), onError });
  }

  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-3">
      <h2 id={`${id}-h`} className="font-semibold text-lg">
        Questions
      </h2>
      <SuggestQuestions ws={ws} />
      {ws.answers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No questions yet. Add the ones the application form asks, so they are answered before you export.
        </p>
      ) : (
        <ul className="divide-y border-y">
          {ws.answers.map((a) => (
            <AnswerRow key={editorKey(a)} ws={ws} answer={a} actions={actions} />
          ))}
        </ul>
      )}
      {!ws.opportunity.frozen && (
        <form onSubmit={submit} className="flex max-w-2xl gap-2">
          <Label htmlFor={`${id}-q`} className="sr-only">
            Add a question
          </Label>
          <Input
            id={`${id}-q`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Add a question from the form, e.g. What are your salary expectations?"
          />
          <Button type="submit" variant="secondary" className="shrink-0" disabled={add.isPending || !question.trim()}>
            Add a question
          </Button>
        </form>
      )}
    </section>
  );
}

/**
 * A field that keeps its own text while focused and saves on blur when the text changed. It
 * shows the server value again after saving, so a refused value snaps back.
 */
function BlurField({
  value,
  onCommit,
  render,
}: {
  value: string;
  onCommit: (text: string) => void;
  render: (props: {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    onBlur: () => void;
  }) => ReactElement;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return render({
    value: draft ?? value,
    onChange: (event) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== null && draft !== value) onCommit(draft);
      setDraft(null);
    },
  });
}

/** Notes for this job (decision 18). Saved when the field loses focus. */
function Notes({ ws }: { ws: WorkspaceDto }) {
  const id = useId();
  const update = useUpdateOpportunity(ws.opportunity.id);
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>Notes</Label>
        <span aria-live="polite" className="text-muted-foreground text-xs">
          {update.isPending ? "Saving…" : update.isSuccess ? "Saved" : ""}
        </span>
      </div>
      <BlurField
        value={ws.opportunity.notes}
        onCommit={(notes) => update.mutate({ notes }, { onError })}
        render={(field) => (
          <Textarea
            id={id}
            {...field}
            className="min-h-24 text-sm"
            placeholder="Who you spoke to, what comes next. Saved when you click away."
          />
        )}
      />
    </section>
  );
}

/** Mark applied is not gated (section 3.5): people apply through forms that need none of the files. */
function MarkApplied({ ws }: { ws: WorkspaceDto }) {
  const change = useChangeStatus();
  if (ws.opportunity.status !== "saved") return null;
  const label = ws.opportunity.type === "contract" ? "Mark proposal sent" : "Mark applied";
  return (
    <div className="grid gap-1.5">
      <Button
        variant="outline"
        disabled={change.isPending}
        onClick={() =>
          change.mutate(
            { opportunityId: ws.opportunity.id, status: "applied" },
            { onSuccess: () => toast("Moved to Applied. Files and answers now stay as you sent them."), onError },
          )
        }
      >
        {label}
      </Button>
      <p className="text-muted-foreground text-xs">Keeps the files and answers exactly as you send them.</p>
    </div>
  );
}

function Rail({ ws, onJump }: { ws: WorkspaceDto; onJump: (id: OutputId) => void }) {
  const ready = useMarkReady(ws.opportunity.id);
  return (
    <aside className="grid content-start gap-6 lg:sticky lg:top-20">
      <NeedsInput gate={ws.gate} onJump={onJump} />
      <div className="grid gap-2">
        {ws.opportunity.ready ? (
          <p className="flex items-center gap-2 font-medium text-primary text-sm">
            <CheckIcon className="size-4" aria-hidden /> Ready to apply
          </p>
        ) : (
          <Button
            disabled={!ws.gate.ok || ready.isPending}
            onClick={() => ready.mutate(undefined, { onError })}
            title={ws.gate.ok ? undefined : "Clear Needs your input first"}
          >
            Mark ready
          </Button>
        )}
        <MarkApplied ws={ws} />
      </div>
      <Notes ws={ws} />
      <section aria-labelledby="facts-rail" className="grid gap-2">
        <h2 id="facts-rail" className="font-medium text-sm">
          Your confirmed facts
        </h2>
        {ws.facts.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet. Paste and confirm your CV on the Profile page.</p>
        ) : (
          <ul className="grid max-h-80 gap-1.5 overflow-y-auto pr-1 text-sm">
            {ws.facts.map((f) => (
              <li key={f.key} className="flex gap-2">
                <span className="w-14 shrink-0 font-mono text-muted-foreground text-xs leading-5 tabular-nums">
                  {f.key}
                </span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

/** "" means not set; anything else must parse as a positive number or the server refuses it. */
function rateFrom(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  return trimmed === "" ? null : Number(trimmed);
}

/** Rate, rate type, currency and platform (decision 16), saved field by field. */
function ContractFields({ ws, terms }: { ws: WorkspaceDto; terms: ContractTerms }) {
  const id = useId();
  const update = useUpdateOpportunity(ws.opportunity.id);
  const save = (contract: ContractTermsInput) => update.mutate({ contract }, { onError });
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-rate`}>Rate</Label>
        <BlurField
          value={terms.rateAmount === null ? "" : String(terms.rateAmount)}
          onCommit={(text) => {
            const rateAmount = rateFrom(text);
            // NaN would travel as JSON null and clear the rate, so refuse it here.
            if (Number.isNaN(rateAmount)) toast.error("The rate must be a number, such as 35 or 1200.50.");
            else save({ rateAmount });
          }}
          render={(field) => (
            <Input id={`${id}-rate`} {...field} inputMode="decimal" className="w-28 tabular-nums" placeholder="0.00" />
          )}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-currency`}>Currency</Label>
        <BlurField
          value={terms.rateCurrency ?? ""}
          onCommit={(text) => save({ rateCurrency: text.trim() === "" ? null : text })}
          render={(field) => (
            <Input
              id={`${id}-currency`}
              {...field}
              maxLength={3}
              autoCapitalize="characters"
              className="w-20 uppercase"
              placeholder="USD"
            />
          )}
        />
      </div>
      <div className="grid gap-1.5">
        <span id={`${id}-type`} className="font-medium text-sm leading-none">
          Rate type
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-labelledby={`${id}-type`}
          value={terms.rateType ?? ""}
          onValueChange={(value) => {
            const rateType = RateType.safeParse(value);
            if (rateType.success) save({ rateType: rateType.data });
          }}
        >
          {RATE_TYPES.map((t) => (
            <ToggleGroupItem key={t} value={t} disabled={update.isPending}>
              {rateTypeLabel(t)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-platform`}>Platform</Label>
        <BlurField
          value={terms.platform ?? ""}
          onCommit={(text) => save({ platform: text })}
          render={(field) => (
            <Input id={`${id}-platform`} {...field} className="w-44" placeholder="e.g. Upwork, or direct" />
          )}
        />
      </div>
    </div>
  );
}

/** Job or contract, the contract's terms, and the contractor caution (decision 19). */
function KindAndTerms({ ws }: { ws: WorkspaceDto }) {
  const update = useUpdateOpportunity(ws.opportunity.id);
  const { contract } = ws.opportunity;
  return (
    <div className="grid gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Job or contract"
        value={ws.opportunity.type}
        onValueChange={(value) => {
          const type = OpportunityType.safeParse(value);
          if (type.success && type.data !== ws.opportunity.type) update.mutate({ type: type.data }, { onError });
        }}
      >
        <ToggleGroupItem value="job" disabled={update.isPending}>
          Job
        </ToggleGroupItem>
        <ToggleGroupItem value="contract" disabled={update.isPending}>
          Contract
        </ToggleGroupItem>
      </ToggleGroup>
      {contract && (
        <>
          <ContractFields ws={ws} terms={contract} />
          <p className="flex max-w-[68ch] items-start gap-2 text-muted-foreground text-sm">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {CONTRACTOR_CAUTION}
          </p>
        </>
      )}
    </div>
  );
}

function Posting({ ws }: { ws: WorkspaceDto }) {
  return (
    <div className="grid gap-4">
      <PossibleDuplicates duplicates={ws.job.possibleDuplicates} />
      <details className="group rounded-lg border px-4 py-3">
        <summary className="cursor-pointer select-none font-medium text-sm">The posting</summary>
        <div className="mt-3 max-w-[68ch] whitespace-pre-wrap font-serif text-sm leading-relaxed">
          {ws.job.description}
        </div>
      </details>
    </div>
  );
}

function Workspace({ ws }: { ws: WorkspaceDto }) {
  const firstFile = ws.files[0];
  const [selected, setSelected] = useState<OutputId | null>(firstFile?.id ?? null);
  const actions = useDraftActions(ws);

  function jump(id: OutputId) {
    if (ws.files.some((f) => f.id === id)) {
      setSelected(id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#panel-${id} textarea`)?.focus());
      return;
    }
    const row = document.getElementById(`output-${id}`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("textarea")?.focus();
  }

  const { status, outcome } = ws.opportunity;
  const kindStatus = status
    ? [statusLabel({ type: ws.opportunity.type, status }), outcome && outcomeLabel(outcome)].filter(Boolean).join(": ")
    : null;

  return (
    <div className="grid gap-8">
      <header className="grid gap-4">
        <div className="grid gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">{ws.job.title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>{ws.job.company}</span>
            {kindStatus && <Badge variant="secondary">{kindStatus}</Badge>}
            {ws.job.applyUrl && (
              <a
                href={ws.job.applyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:text-foreground hover:underline"
              >
                Apply link <ExternalLinkIcon className="size-3.5" aria-hidden />
              </a>
            )}
          </p>
          {ws.opportunity.frozen && (
            <p className="text-sm">This job is marked applied, so its files and answers stay as you sent them.</p>
          )}
        </div>
        <JobFacts job={ws.job} />
        <KindAndTerms ws={ws} />
      </header>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-10">
          {selected && <Files ws={ws} selected={selected} onSelect={setSelected} actions={actions} />}
          <Questions ws={ws} actions={actions} />
          <Posting ws={ws} />
        </div>
        <Rail ws={ws} onJump={jump} />
      </div>
      {actions.dialogs}
    </div>
  );
}

export function WorkspacePage({ opportunityId }: { opportunityId: OpportunityId }) {
  const ws = useWorkspace(opportunityId);
  if (ws.isPending) return <p className="text-muted-foreground">Loading the job…</p>;
  if (ws.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
        <span>{errorMessage(ws.error)}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => ws.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <Workspace ws={ws.data} />;
}
