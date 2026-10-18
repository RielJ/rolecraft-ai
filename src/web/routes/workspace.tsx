import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, InfoIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";
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
import { webUrl } from "@/shared/web-url";
import { ApiError, errorMessage } from "../api";
import { DraftStatus, NoKeyHint, useDraftActions } from "../components/draft-actions";
import { JobFacts, PossibleDuplicates } from "../components/job-facts";
import { NeedsInput } from "../components/needs-input";
import { OutdatedNotice, OutputEditor } from "../components/output-editor";
import { PostingText } from "../components/posting-text";
import { panelId, TabList, tabId } from "../components/tab-list";
import { readReturn } from "../lib/matches-return";
import {
  useAddQuestion,
  useChangeStatus,
  useCreateApplicationSession,
  useDeleteQuestion,
  useMarkOutputCurrent,
  useMarkReady,
  useMarkReviewed,
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

/**
 * "Mark reviewed" on a file or answer, or its reviewed state. The extension fills a generated
 * answer only once it is reviewed. Any edit or redraft clears the review on the server, so this
 * always describes the body as saved. It sends the saved body shown here; if that changed meanwhile,
 * the server refuses, the workspace reloads and the toast says to read the new version. Salary
 * answers get no control: the extension never fills pay.
 */
function ReviewControl({ ws, output, busy }: { ws: WorkspaceDto; output: OutputDto; busy: boolean }) {
  const mark = useMarkReviewed(ws.opportunity.id);
  const body = output.body;
  if (body === null || body.trim() === "" || output.mustAnswer === "salary") return null;
  return (
    <span aria-live="polite" className="inline-flex items-center">
      {output.reviewedAt === null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || mark.isPending}
          title={busy ? "Save your changes first" : undefined}
          onClick={() => mark.mutate({ id: output.id, body }, { onError })}
        >
          Mark reviewed
        </Button>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <CheckIcon className="size-4 text-primary" aria-hidden />
          Reviewed.
          <span className="text-muted-foreground">
            {busy ? "Saving this change clears it." : "Any change clears it."}
          </span>
        </span>
      )}
    </span>
  );
}

/** After saving a body that was reviewed: the server cleared the review, so say so. */
function savedToast(output: OutputDto): void {
  if (output.reviewedAt === null) return;
  const what = output.kind === "answer" ? "Answer" : outputKindLabel(output.kind);
  toast(`${what} saved. Mark it reviewed again so the extension can use it.`);
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
      <TabList
        label="Files"
        variant="pill"
        value={current.id}
        onChange={onSelect}
        tabs={ws.files.map((f) => ({
          value: f.id,
          label: (
            <>
              <span className={f.included ? "" : "line-through decoration-1"}>{outputKindLabel(f.kind)}</span>
              {drafting.has(f.id) && <span className="text-muted-foreground text-xs">drafting</span>}
              {f.included && f.outdated.length > 0 && <span className="text-warning-foreground text-xs">outdated</span>}
              {f.included && blockersFor(ws, f.id).length > 0 && (
                <span className="size-1.5 rounded-full bg-warning" role="img" aria-label="needs input" />
              )}
            </>
          ),
        }))}
      />
      <div role="tabpanel" id={panelId(current.id)} aria-labelledby={tabId(current.id)} className="grid gap-4">
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
            onSave={(body) =>
              update.mutate({ id: current.id, body }, { onSuccess: () => savedToast(current), onError })
            }
            drafting={drafting.has(current.id)}
            draftButton={
              <>
                <DraftOne ws={ws} output={current} actions={actions} />
                {!drafting.has(current.id) && <ReviewControl ws={ws} output={current} busy={update.isPending} />}
              </>
            }
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
    if (!dirty) return;
    update.mutate(
      { id: answer.id, body: draft.trim() === "" ? null : draft },
      { onSuccess: () => savedToast(answer), onError },
    );
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
            <>
              <DraftOne ws={ws} output={answer} actions={actions} />
              <ReviewControl ws={ws} output={answer} busy={dirty || update.isPending} />
            </>
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

/**
 * The actions column. On wide screens it stays pinned under the top bar, lined up with the title,
 * and scrolls on its own when it is taller than the window. Apply sits first.
 */
function Rail({ ws, onJump }: { ws: WorkspaceDto; onJump: (id: OutputId) => void }) {
  const ready = useMarkReady(ws.opportunity.id);
  return (
    <aside
      aria-label="Apply and track"
      className="grid content-start gap-6 lg:sticky lg:top-[calc(57px+1.5rem)] lg:-mx-1 lg:max-h-[calc(100dvh-57px-3rem)] lg:overflow-y-auto lg:overscroll-contain lg:px-1 lg:pb-1"
    >
      {ws.job.applyUrl && (
        // On narrow screens Apply lives in the header instead, above the long posting.
        <ApplyLink
          opportunityId={ws.opportunity.id}
          applyUrl={ws.job.applyUrl}
          variant="default"
          size="default"
          className="hidden w-full lg:inline-flex"
        />
      )}
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
      <KindAndTerms ws={ws} />
      <Notes ws={ws} />
      <section aria-labelledby="facts-rail" className="grid gap-2">
        <h2 id="facts-rail" className="font-medium text-sm">
          Your confirmed facts
        </h2>
        {ws.facts.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet. Paste and confirm your CV on the Profile page.</p>
        ) : (
          <ul className="grid gap-1.5 text-sm">
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

/**
 * Send the blank tab to `url`. The location setter works on any window this page opened, so this
 * never touches the tab's document. No referrer is sent: the app page's policy is `no-referrer`
 * (index.html), and this page starts the navigation. Does nothing if the user closed the tab.
 */
function navigateTab({ tab, url }: { tab: Window; url: string }): void {
  if (tab.closed) return;
  tab.location.replace(url);
}

/**
 * Apply: records an application session so the Chrome extension knows which job the new tab is
 * for, then opens the apply URL as stored. The tab opens blank inside the click, which popup
 * blockers allow, and is cut from this page (`opener = null`) before it leaves for the job site.
 * A failed session still opens the page. The board status does not change: only the user's own
 * "Mark applied" or the extension's "Did you submit?" does that.
 */
function ApplyLink({
  opportunityId,
  applyUrl,
  variant = "outline",
  size = "sm",
  className,
}: {
  opportunityId: OpportunityId;
  applyUrl: string;
} & Pick<ComponentProps<typeof Button>, "variant" | "size" | "className">) {
  const session = useCreateApplicationSession();
  // Only http(s) leaves the app: a `javascript:` URL from a job source would run as this app.
  const url = webUrl(applyUrl);
  if (url === null) return null;

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (url === null) return;
    // Middle, Ctrl, Cmd and Shift clicks open the link the browser's way, with no session.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const tab = window.open("", "_blank");
    // Blocked anyway: the link opens the page itself while the session is recorded.
    if (tab !== null) {
      event.preventDefault();
      tab.opener = null;
    }
    // mutateAsync, not mutate: the tab must still navigate if this page unmounts meanwhile.
    session
      .mutateAsync(opportunityId)
      .catch((error: unknown) =>
        toast("The apply page opened, but the extension won't pick it up.", { description: errorMessage(error) }),
      )
      .finally(() => {
        if (tab !== null) navigateTab({ tab, url });
      });
  }

  return (
    <Button asChild size={size} variant={variant} className={className}>
      <a href={url} target="_blank" rel="noreferrer" onClick={onClick}>
        <ExternalLinkIcon aria-hidden />
        Apply
      </a>
    </Button>
  );
}

/** The posting as the source gave it, after who can apply, the pay and any likely duplicates. */
function Posting({ ws }: { ws: WorkspaceDto }) {
  const text = ws.job.description.trim();
  return (
    <div className="grid gap-6">
      <JobFacts job={ws.job} />
      <PossibleDuplicates duplicates={ws.job.possibleDuplicates} />
      {text === "" ? (
        <p className="border-t pt-6 text-muted-foreground text-sm">
          The source gave no description. Open the posting with Apply to read it there.
        </p>
      ) : (
        <article aria-label="The posting" className="border-t pt-6">
          <PostingText text={text} />
        </article>
      )}
    </div>
  );
}

export const WorkspaceTab = z.enum(["posting", "drafts"]);
export type WorkspaceTab = z.infer<typeof WorkspaceTab>;

/**
 * Without `?tab=`: the posting for a job with nothing written yet, so you read before you write;
 * the drafts once any file or answer has text, or the job is applied.
 */
function defaultTab(ws: WorkspaceDto): WorkspaceTab {
  const written = [...ws.files, ...ws.answers].some((o) => o.body !== null && o.body.trim() !== "");
  return written || ws.opportunity.frozen ? "drafts" : "posting";
}

/** "Drafts" plus how many items need input, so the count is visible from the Posting tab too. */
function DraftsTabLabel({ gate }: { gate: WorkspaceDto["gate"] }) {
  return (
    <>
      Drafts
      {!gate.ok && (
        <span className="rounded-full bg-warning/15 px-1.5 text-warning-foreground text-xs tabular-nums leading-5">
          {gate.blockers.length}
          <span className="sr-only"> need your input</span>
        </span>
      )}
    </>
  );
}

function Workspace({
  ws,
  tab: chosen,
  onTab,
}: {
  ws: WorkspaceDto;
  tab: WorkspaceTab | undefined;
  onTab: (tab: WorkspaceTab) => void;
}) {
  const firstFile = ws.files[0];
  const [selected, setSelected] = useState<OutputId | null>(firstFile?.id ?? null);
  // Picked once on open: a draft finishing later must not pull the page off the posting.
  const [fallback] = useState(() => defaultTab(ws));
  const tab = chosen ?? fallback;
  const actions = useDraftActions(ws);

  const band = useRef<HTMLDivElement>(null);
  const panels = useRef<HTMLDivElement>(null);

  /**
   * Switch tabs. When the band is pinned and the page is scrolled into the old panel, start the
   * new panel just under the band instead of somewhere in its middle.
   */
  function switchTab(next: WorkspaceTab) {
    onTab(next);
    requestAnimationFrame(() => {
      if (!band.current || !panels.current) return;
      const gap = panels.current.getBoundingClientRect().top - band.current.getBoundingClientRect().bottom;
      if (gap < 0 && getComputedStyle(band.current).position === "sticky") window.scrollBy({ top: gap - 32 });
    });
  }

  function jump(id: OutputId) {
    if (tab !== "drafts") switchTab("drafts");
    if (ws.files.some((f) => f.id === id)) {
      setSelected(id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#${panelId(id)} textarea`)?.focus());
      return;
    }
    requestAnimationFrame(() => {
      const row = document.getElementById(`output-${id}`);
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLElement>("textarea")?.focus();
    });
  }

  const { status, outcome } = ws.opportunity;
  const kindStatus = status
    ? [statusLabel({ type: ws.opportunity.type, status }), outcome && outcomeLabel(outcome)].filter(Boolean).join(": ")
    : null;

  // Opened by Start application in Matches: offer the way back to the job after this one.
  const fromMatches = readReturn()?.opportunityId === ws.opportunity.id;

  return (
    <div className="grid gap-x-10 gap-y-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-8">
        {/*
         * Title, company and tabs stay pinned under the top bar on wide screens, so switching
         * between the posting and the drafts never needs a scroll back up. The negative margin
         * keeps the page's top spacing while giving the pinned band room to breathe.
         */}
        <div
          ref={band}
          className="-mt-6 grid gap-5 pt-6 lg:sticky lg:top-[57px] lg:z-[5] lg:bg-background/85 lg:backdrop-blur-md"
        >
          <header className="grid gap-1.5">
            <div className="flex items-start justify-between gap-4">
              <h1
                title={ws.job.title}
                className="display min-w-0 text-balance break-words text-2xl sm:text-[1.75rem] lg:line-clamp-2"
              >
                {ws.job.title}
              </h1>
              {ws.job.applyUrl && (
                <div className="shrink-0 pt-0.5 lg:hidden">
                  <ApplyLink opportunityId={ws.opportunity.id} applyUrl={ws.job.applyUrl} />
                </div>
              )}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span className="min-w-0 break-words">{ws.job.company}</span>
              {kindStatus && <Badge variant="secondary">{kindStatus}</Badge>}
              {fromMatches && (
                <Button variant="ghost" size="sm" className="-my-1 ml-auto text-muted-foreground" asChild>
                  <Link to="/">
                    Next match
                    <ArrowRightIcon aria-hidden />
                  </Link>
                </Button>
              )}
            </p>
            {/* About the whole job, so it shows on either tab. */}
            {ws.opportunity.frozen && (
              <p className="text-muted-foreground text-sm">
                This job is marked applied, so its files and answers stay as you sent them.
              </p>
            )}
          </header>
          <TabList
            label="This job"
            idPrefix="page-"
            value={tab}
            onChange={switchTab}
            tabs={[
              { value: "posting", label: "Posting" },
              { value: "drafts", label: <DraftsTabLabel gate={ws.gate} /> },
            ]}
          />
        </div>
        {/* Both panels stay mounted, so switching tabs never drops an unsaved edit. */}
        <div ref={panels} className="grid min-w-0">
          <div
            role="tabpanel"
            id={panelId("posting", "page-")}
            aria-labelledby={tabId("posting", "page-")}
            hidden={tab !== "posting"}
          >
            <Posting ws={ws} />
          </div>
          <div
            role="tabpanel"
            id={panelId("drafts", "page-")}
            aria-labelledby={tabId("drafts", "page-")}
            hidden={tab !== "drafts"}
            // A focused editor or answer scrolls into view clear of the pinned band.
            className="grid content-start gap-12 lg:[&_[id^=output-]]:scroll-mt-56 lg:[&_textarea]:scroll-mt-56"
          >
            {selected && <Files ws={ws} selected={selected} onSelect={setSelected} actions={actions} />}
            <Questions ws={ws} actions={actions} />
          </div>
        </div>
      </div>
      <Rail ws={ws} onJump={jump} />
      {actions.dialogs}
    </div>
  );
}

export function WorkspacePage({
  opportunityId,
  tab,
  onTab,
}: {
  opportunityId: OpportunityId;
  tab: WorkspaceTab | undefined;
  onTab: (tab: WorkspaceTab) => void;
}) {
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
  return <Workspace ws={ws.data} tab={tab} onTab={onTab} />;
}
