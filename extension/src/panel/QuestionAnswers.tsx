import type { TaskDto } from "@shared/api";
import type { ApplicationSessionId, FieldDescriptor, ScanNonce } from "@shared/extension";
import { AnswerText, canDraftField, isReferenceField, type QuestionAnswerDto } from "@shared/extension-answers";
import { useEffect, useRef, useState } from "react";
import type { PanelReply, PanelRequest } from "../messages";
import { refusalText } from "./Attachments";
import { skipText } from "./FieldReview";
import { POLL_MS } from "./state";

export type QuestionAnswersProps = {
  sessionId: ApplicationSessionId;
  tabId: number;
  nonce: ScanNonce;
  fields: readonly FieldDescriptor[];
  disabled: boolean;
  send: (request: PanelRequest) => Promise<PanelReply>;
  onConnection: (reply: PanelReply) => void;
};

type Notice = { kind: "status" | "alert"; text: string } | null;
type Ask = (request: PanelRequest) => Promise<PanelReply["result"]>;

function replyResult(reply: PanelReply): PanelReply["result"] {
  if (reply.status.kind !== "paired") throw new Error(reply.error ?? "Rolecraft isn't connected.");
  if (reply.result?.kind === "failed") throw new Error(reply.result.message);
  if (reply.result?.kind === "refused") throw new Error(refusalText(reply.result.reason));
  if (reply.result === undefined) throw new Error(reply.error ?? "The worker didn't answer. Try again.");
  return reply.result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, POLL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function AnswerRow({
  field,
  question,
  sessionId,
  tabId,
  nonce,
  disabled,
  ask,
}: {
  field: FieldDescriptor;
  question: QuestionAnswerDto;
  sessionId: ApplicationSessionId;
  tabId: number;
  nonce: ScanNonce;
  disabled: boolean;
  ask: Ask;
}) {
  const [body, setBody] = useState(question.answer?.body ?? "");
  const [outdated, setOutdated] = useState(question.answer?.outdated ?? false);
  const [hasAnswer, setHasAnswer] = useState(Boolean(question.answer?.body.trim()));
  const [pendingTask, setPendingTask] = useState<TaskDto | null>(null);
  const [references, setReferences] = useState(question.references);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const locked = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(true);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (disabled) {
      operation.current?.abort();
      operation.current = null;
      locked.current = false;
      setBusy(false);
    }
    return () => {
      operation.current?.abort();
    };
  }, [disabled]);

  const unavailable = disabled || busy;
  const valid = AnswerText.safeParse(body).success;
  const placeholders = /\[\[[\s\S]*?\]\]/.test(body);
  const draftLabel =
    pendingTask !== null
      ? body.trim()
        ? "Check draft progress (replaces answer)"
        : "Check draft progress"
      : body.trim() || hasAnswer
        ? "Regenerate draft (replaces answer)"
        : "Generate draft";
  const setText = (text: string) => {
    setBody(text);
    setOutdated(false);
    setNotice(null);
  };
  async function run(work: (current: () => boolean, signal: AbortSignal) => Promise<void>) {
    if (disabledRef.current || locked.current || !active.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const current = () => active.current && !disabledRef.current && !controller.signal.aborted;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await work(current, controller.signal);
    } catch (error) {
      if (current()) setNotice({ kind: "alert", text: message(error) });
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        locked.current = false;
        if (active.current) setBusy(false);
      }
    }
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <label htmlFor={`custom-answer-${field.fieldId}`} className="text-sm font-medium break-words">
        {field.label}
      </label>
      <textarea
        id={`custom-answer-${field.fieldId}`}
        className="min-h-24 rounded-control border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        value={body}
        maxLength={10_000}
        disabled={unavailable}
        onChange={(event) => setText(event.target.value)}
      />
      {outdated && (
        <p className="text-xs text-muted-foreground">This answer is outdated. Edit or regenerate it before filling.</p>
      )}
      {placeholders && <p className="text-xs text-muted-foreground">Replace all [[placeholders]] before filling.</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={unavailable}
          onClick={() =>
            void run(async (current) => {
              const result = await ask({ kind: "answer_read", sessionId, tabId, nonce, field });
              if (!current()) return;
              if (result?.kind !== "answer_read" || result.fieldId !== field.fieldId)
                throw new Error("Couldn't read this answer from the form.");
              setText(result.body);
              setNotice({
                kind: "status",
                text: result.body.trim()
                  ? "Read from the form. Review it, then save a reference."
                  : "This form field is empty.",
              });
            })
          }
        >
          Read from form
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={unavailable || !valid}
          onClick={() =>
            void run(async (current) => {
              const result = await ask({ kind: "answer_reference_save", sessionId, input: { field, body } });
              if (!current()) return;
              if (result?.kind !== "answer_reference") throw new Error("Couldn't save the reference.");
              setReferences((previous) =>
                [result.reference, ...previous.filter((reference) => reference.id !== result.reference.id)].slice(0, 3),
              );
              setNotice({ kind: "status", text: "Reference saved. It will only be reused when you choose it." });
            })
          }
        >
          Save reference
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={unavailable || !valid || outdated || placeholders}
          onClick={() =>
            void run(async (current) => {
              if (!valid || outdated || placeholders) return;
              const result = await ask({
                kind: "fill",
                tabId,
                plan: { nonce, entries: [{ fieldId: field.fieldId, value: { kind: "text", text: body } }] },
              });
              if (!current()) return;
              if (result?.kind !== "filled" || result.result.nonce !== nonce)
                throw new Error("Couldn't fill this answer. Scan again.");
              const skipped = result.result.skipped.find((entry) => entry.fieldId === field.fieldId);
              if (skipped) setNotice({ kind: "alert", text: skipText(skipped.reason) });
              else if (result.result.filled.includes(field.fieldId))
                setNotice({ kind: "status", text: "Answer filled. Check it on the page before submitting." });
              else throw new Error("The field wasn't filled. Scan again.");
            })
          }
        >
          Fill this answer
        </button>
        {canDraftField(field) && (
          <button
            type="button"
            className="btn-secondary"
            disabled={unavailable}
            onClick={() =>
              void run(async (current, signal) => {
                let task = pendingTask;
                if (task === null) {
                  const created = await ask({ kind: "question_create", sessionId, input: { field } });
                  if (!current()) return;
                  if (created?.kind !== "output") throw new Error("Couldn't create this question.");
                  const started = await ask({
                    kind: "draft_start",
                    sessionId,
                    outputId: created.output.id,
                    confirmOverCap: false,
                  });
                  if (!current()) return;
                  if (started?.kind !== "task") throw new Error("Couldn't start the draft.");
                  task = started.task;
                  setPendingTask(task);
                }
                while (task.status === "running") {
                  setNotice({ kind: "status", text: task.step || "Drafting…" });
                  await pollDelay(signal);
                  if (!current()) return;
                  const polled = await ask({ kind: "task_poll", taskId: task.id });
                  if (!current()) return;
                  if (polled?.kind !== "task" || polled.task.id !== task.id)
                    throw new Error("Couldn't check the draft's progress.");
                  task = polled.task;
                  setPendingTask(task);
                }
                if (task.status !== "done") {
                  setPendingTask(null);
                  throw new Error(task.error ?? "Drafting stopped. Try again.");
                }
                // Refresh this row only. Answers being edited in other rows stay untouched.
                const refreshed = await ask({ kind: "questions_lookup", sessionId, input: { fields: [field] } });
                if (!current()) return;
                if (refreshed?.kind !== "questions") throw new Error("Couldn't load the drafted answer.");
                const updated = refreshed.data.questions.find((item) => item.fieldId === field.fieldId);
                if (!updated?.answer?.body.trim()) throw new Error("The draft returned no answer. Try again.");
                setBody(updated.answer.body);
                setPendingTask(null);
                setHasAnswer(true);
                setOutdated(updated.answer.outdated);
                setReferences(updated.references);
                setNotice({ kind: "status", text: "Draft ready. Check every fact and company name before filling." });
              })
            }
          >
            {draftLabel}
          </button>
        )}
      </div>
      {canDraftField(field) && (
        <p className="text-xs text-muted-foreground">
          Drafting uses your AI budget. It never fills the form or approves spending over your cap.
        </p>
      )}
      {references.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Saved references. Check the company and question before reusing.
          </p>
          {references.map((reference) => (
            <div
              key={reference.id}
              className="flex min-w-0 flex-col items-start gap-1 rounded-control border border-border p-2"
            >
              <p className="text-xs font-medium break-words">From {reference.company || "Unknown company"}</p>
              <p className="text-xs break-words">{reference.question}</p>
              <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{reference.body}</p>
              <button
                type="button"
                className="btn-secondary"
                disabled={unavailable}
                onClick={() => setText(reference.body)}
              >
                Use as starting point
              </button>
            </div>
          ))}
        </div>
      )}
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Working…
        </p>
      )}
      {notice && (
        <p
          role={notice.kind}
          className={notice.kind === "alert" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {notice.text}
        </p>
      )}
    </li>
  );
}

/** Mounted with a session/scan key. Lookup is read-only; every write needs its own click. */
export function QuestionAnswers(props: QuestionAnswersProps) {
  const [fields] = useState(() => props.fields.filter(isReferenceField));
  const [questions, setQuestions] = useState<readonly QuestionAnswerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const active = useRef(true);
  const lookup = useRef<Promise<PanelReply["result"]> | null>(null);
  const [ask] = useState<Ask>(() => async (request: PanelRequest) => {
    if (!active.current || latest.current.disabled) throw new Error("Switch to the application tab first.");
    const reply = await latest.current.send(request);
    if (!active.current) return undefined;
    latest.current.onConnection(reply);
    return replyResult(reply);
  });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (props.disabled || fields.length === 0) return;
    let cancelled = false;
    lookup.current ??= ask({ kind: "questions_lookup", sessionId: props.sessionId, input: { fields } });
    void lookup.current
      .then((result) => {
        if (cancelled) return;
        if (result?.kind !== "questions") {
          setError("Couldn't load custom answers.");
          return;
        }
        setQuestions(result.data.questions);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [ask, fields, props.disabled, props.sessionId]);

  if (fields.length === 0) return null;
  return (
    <section aria-label="Custom answers" className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">Custom answers</h3>
      <p className="text-xs text-muted-foreground">
        Review an answer, then click Fill this answer. Only empty form fields can be filled.
      </p>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : questions === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading custom answers…
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-control border border-border">
          {fields.map((field) => (
            <AnswerRow
              key={field.fieldId}
              field={field}
              question={
                questions.find((question) => question.fieldId === field.fieldId) ?? {
                  fieldId: field.fieldId,
                  question: field.label,
                  answer: null,
                  references: [],
                }
              }
              sessionId={props.sessionId}
              tabId={props.tabId}
              nonce={props.nonce}
              disabled={props.disabled}
              ask={ask}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
