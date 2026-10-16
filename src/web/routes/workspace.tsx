import { CheckIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { GateBlocker, OpportunityId, OutputDto, OutputId, WorkspaceDto } from "@/shared/api";
import { mustAnswerLabel, outputKindLabel, statusLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { NeedsInput } from "../components/needs-input";
import { OutputEditor } from "../components/output-editor";
import { useAddQuestion, useDeleteQuestion, useMarkReady, useUpdateOutput, useWorkspace } from "../queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const onError = (error: unknown) => toast.error(errorMessage(error));

function blockersFor(ws: WorkspaceDto, id: OutputId): GateBlocker[] {
  return ws.gate.ok ? [] : ws.gate.blockers.filter((b) => b.outputId === id);
}

function Files({ ws, selected, onSelect }: { ws: WorkspaceDto; selected: OutputId; onSelect: (id: OutputId) => void }) {
  const update = useUpdateOutput(ws.opportunity.id);
  const current = ws.files.find((f) => f.id === selected) ?? ws.files[0];
  if (!current) return null;
  const label = outputKindLabel(current.kind);

  return (
    <section aria-label="Files" className="grid gap-4">
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
            key={`${current.id}:${current.editedAt ?? ""}`}
            output={current}
            frozen={ws.opportunity.frozen}
            blockers={blockersFor(ws, current.id)}
            blocked={!ws.gate.ok}
            saving={update.isPending}
            onSave={(body) => update.mutate({ id: current.id, body }, { onError })}
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

function AnswerRow({ ws, answer }: { ws: WorkspaceDto; answer: OutputDto }) {
  const id = useId();
  const update = useUpdateOutput(ws.opportunity.id);
  const remove = useDeleteQuestion(ws.opportunity.id);
  const saved = answer.body ?? "";
  const [draft, setDraft] = useState(saved);
  const dirty = draft !== saved;
  const frozen = ws.opportunity.frozen;
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
        <Textarea
          id={`${id}-body`}
          value={draft}
          readOnly={frozen}
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
        {dirty && (
          <Button size="sm" className="justify-self-start" onClick={save} disabled={update.isPending}>
            Save answer
          </Button>
        )}
      </div>
    </li>
  );
}

function Questions({ ws }: { ws: WorkspaceDto }) {
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
      {ws.answers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No questions yet. Add the ones the application form asks, so they are answered before you export.
        </p>
      ) : (
        <ul className="divide-y border-y">
          {ws.answers.map((a) => (
            <AnswerRow key={`${a.id}:${a.editedAt ?? ""}`} ws={ws} answer={a} />
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
      </div>
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

function Posting({ ws }: { ws: WorkspaceDto }) {
  return (
    <details className="group rounded-lg border px-4 py-3">
      <summary className="cursor-pointer select-none font-medium text-sm">The posting</summary>
      <div className="mt-3 max-w-[68ch] whitespace-pre-wrap font-serif text-sm leading-relaxed">
        {ws.job.description}
      </div>
    </details>
  );
}

function Workspace({ ws }: { ws: WorkspaceDto }) {
  const firstFile = ws.files[0];
  const [selected, setSelected] = useState<OutputId | null>(firstFile?.id ?? null);

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

  const kindStatus = ws.opportunity.status
    ? statusLabel({ type: ws.opportunity.type, status: ws.opportunity.status })
    : null;

  return (
    <div className="grid gap-8">
      <header className="grid gap-1">
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
      </header>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-10">
          {selected && <Files ws={ws} selected={selected} onSelect={setSelected} />}
          <Questions ws={ws} />
          <Posting ws={ws} />
        </div>
        <Rail ws={ws} onJump={jump} />
      </div>
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
