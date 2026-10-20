import { CopyIcon, EllipsisIcon, EyeIcon, FileDownIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { OpportunityId, OutputDto } from "@/shared/api";
import { type Blank, parseBlank } from "@/shared/blanks";
import { PDF_KINDS } from "@/shared/enums";
import { fileStatusLabel, outdatedLabel, outputKindLabel, resumeLikelyLong, styleHitLabel } from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { useMinuteClock } from "../lib/use-minute-clock";
import { cn } from "../lib/utils";
import { downloadPdf, fetchText, useFillBlanks } from "../queries";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/*
 * How a file shows on the job page (docs/plans/clean-files.md, slice A): a summary card with the
 * PDF one click away, clean copy text, the blanks as their own inputs, and an inline text editor.
 * No fact keys, Markdown marks or markers reach the screen.
 */

const BLOCKED_HINT = "Clear Needs your input first";

function exportFailed(error: unknown, what: string): void {
  if (error instanceof ApiError && error.code === "needs_input") {
    const count = error.blockers.length;
    toast.error(`${what} is blocked by ${count} item${count === 1 ? "" : "s"} under Needs your input.`);
    return;
  }
  toast.error(errorMessage(error));
}

/**
 * The Edit text state of one file. A new server body (an edit, a fill or a new draft) closes the
 * editor, as a remount would. The card itself is not remounted, so the blanks form under it keeps
 * what was typed and not saved yet.
 */
function useEditing(output: OutputDto) {
  const version = `${output.editedAt ?? ""}:${output.generatedAt ?? ""}`;
  const [seen, setSeen] = useState(version);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  if (seen !== version) {
    setSeen(version);
    setEditing(false);
    setDirty(false);
  }
  return { editing, setEditing, dirty, setDirty };
}

/** Copy text and Download PDF, both gated by the server. One runs at a time. */
function useExports(output: OutputDto) {
  const [busy, setBusy] = useState<"pdf" | "text" | null>(null);
  const label = output.kind === "answer" ? "Answer" : outputKindLabel(output.kind);
  async function download() {
    setBusy("pdf");
    try {
      await downloadPdf(output.id);
    } catch (error) {
      exportFailed(error, "Download");
    } finally {
      setBusy(null);
    }
  }
  async function copy() {
    setBusy("text");
    try {
      await navigator.clipboard.writeText(await fetchText(output.id));
      toast(`${label} copied.`);
    } catch (error) {
      exportFailed(error, "Copy");
    } finally {
      setBusy(null);
    }
  }
  return { busy, copy, download };
}

type Exports = ReturnType<typeof useExports>;

function CopyButton({ exports, blocked }: { exports: Exports; blocked: boolean }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={exports.copy}
      disabled={blocked || exports.busy !== null}
      title={blocked ? BLOCKED_HINT : undefined}
    >
      <CopyIcon aria-hidden />
      {exports.busy === "text" ? "Copying…" : "Copy text"}
    </Button>
  );
}

function DownloadButton({ exports, blocked }: { exports: Exports; blocked: boolean }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={exports.download}
      disabled={blocked || exports.busy !== null}
      title={blocked ? BLOCKED_HINT : undefined}
    >
      <FileDownIcon aria-hidden />
      {exports.busy === "pdf" ? "Downloading…" : "Download PDF"}
    </Button>
  );
}

/**
 * The PDF as it would download, blanks shown as boxes, in the browser's own viewer. The frame
 * mounts on each open, and the server sends no-store, so a filled blank shows the next time.
 */
function PreviewDialog({ output, exports, blocked }: { output: OutputDto; exports: Exports; blocked: boolean }) {
  const label = outputKindLabel(output.kind);
  const version = encodeURIComponent(output.editedAt ?? output.generatedAt ?? "");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <EyeIcon aria-hidden />
          Preview PDF
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[min(64rem,calc(100dvh-2rem))] flex-col gap-4 p-4 sm:max-w-[min(56rem,calc(100%-2rem))]"
      >
        <DialogTitle className="sr-only">{label} preview</DialogTitle>
        <iframe
          title={`${label} PDF preview`}
          src={`/api/outputs/${output.id}/preview.pdf?v=${version}`}
          className="min-h-0 w-full flex-1 rounded-md border bg-muted/30"
        />
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">
            {blocked ? "Copy and Download unlock once Needs your input is clear." : ""}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <CopyButton exports={exports} blocked={blocked} />
            <DownloadButton exports={exports} blocked={blocked} />
            <DialogClose asChild>
              <Button size="sm">Close</Button>
            </DialogClose>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const BLANK = /(\[\[[^\]]*\]\])/;

/** What a blank reads as in the text: the label, or the sentence to check. */
function blankText(inner: string): string {
  const blank = parseBlank(inner);
  return blank.kind === "check" ? blank.sentence : blank.label;
}

/**
 * A blank's highlight. The ring is a shadow, not padding, so it takes no room in the line and the
 * period after "role" stays flush.
 */
const BLANK_MARK =
  "box-decoration-clone rounded-sm bg-warning-surface text-warning-foreground shadow-[0_0_0_2px_var(--color-warning-surface)]";

/** One line of plain text, with each `[[blank]]` marked so it stands out. */
function withBlanks(line: string): ReactNode[] {
  return line.split(BLANK).map((part, i) =>
    BLANK.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
      <mark key={i} className={BLANK_MARK}>
        {blankText(part.slice(2, -2))}
      </mark>
    ) : (
      part
    ),
  );
}

/** Clean text as it reads when copied: paragraphs at a reading measure, in the serif face. */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("grid max-w-[68ch] gap-3 font-serif text-base leading-relaxed", className)}>
      {text.split(/\n{2,}/).map((para, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one fixed string
        <p key={i} className="text-pretty">
          {para.split("\n").map((line, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed paragraph
            <span key={j}>
              {j > 0 && <br />}
              {withBlanks(line)}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** Style warnings (decision 43). Suggestions only: they never block export. */
export function StyleHits({ output }: { output: OutputDto }) {
  if (output.styleHits.length === 0) return null;
  return (
    <details className="group max-w-[68ch] text-sm">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground">
        Wording to check <span className="tabular-nums">({output.styleHits.length})</span>
      </summary>
      <ul className="mt-2 grid gap-1 text-muted-foreground">
        {output.styleHits.map((hit, i) => (
          // Hits are a stored list with no id; the same phrase can repeat in one sentence.
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered in place
          <li key={`${i}:${hit.rule}:${hit.phrase}`}>{styleHitLabel(hit)}</li>
        ))}
      </ul>
      <p className="mt-1 text-muted-foreground text-xs">These are suggestions. They do not block export.</p>
    </details>
  );
}

/**
 * The facts a file or answer used changed since it was written (section 2, Provenance). Edited
 * facts show old and new text; Mark up to date accepts the new text without redrafting.
 */
export function OutdatedNotice({
  output,
  regenerate,
  onMarkCurrent,
  marking,
}: {
  output: OutputDto;
  /** The Regenerate button, or null when drafting is not possible. */
  regenerate: ReactNode;
  onMarkCurrent: () => void;
  marking: boolean;
}) {
  if (output.outdated.length === 0) return null;
  const canMark = output.outdated.some((c) => c.reason === "edited");
  return (
    <section
      aria-label="Facts changed"
      className="grid max-w-[68ch] gap-3 rounded-lg border border-warning/40 bg-warning-surface px-4 py-3 text-sm"
    >
      <h3 className="font-medium text-warning-foreground">Facts changed since this was written</h3>
      <ul className="grid gap-2">
        {output.outdated.map((change) => (
          <li key={change.factKey} className="grid gap-0.5">
            <span className="font-medium">{outdatedLabel(change.reason)}</span>
            {change.reason === "edited" ? (
              <>
                <span className="text-muted-foreground">
                  Was: <span className="line-through decoration-1">{change.oldText}</span>
                </span>
                <span>Now: {change.newText}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{change.oldText}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {regenerate}
        {canMark && (
          <Button size="sm" variant="outline" onClick={onMarkCurrent} disabled={marking}>
            Mark up to date
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * The clean text in a box, with Save and Cancel. Saving sends the clean text; the server puts back
 * the sources of every sentence left as it was. `onDirty` lets the caller hold Mark reviewed.
 */
export function TextEditor({
  label,
  initial,
  placeholder,
  saving,
  saveLabel = "Save",
  onSave,
  onCancel,
  onDirty,
  className,
}: {
  /** The box's accessible name. */
  label: string;
  initial: string;
  placeholder: string;
  saving: boolean;
  saveLabel?: string;
  /** Settles when the save does; the box stays open on failure. */
  onSave: (text: string) => Promise<unknown>;
  onCancel: () => void;
  onDirty?: (dirty: boolean) => void;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const dirty = text !== initial;
  // A double click must not send two saves before `saving` disables the button.
  const inFlight = useRef(false);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty) {
      onCancel();
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    void onSave(text).finally(() => {
      inFlight.current = false;
    });
  }
  return (
    <form onSubmit={save} className={cn("grid gap-3", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={text}
        autoFocus
        onChange={(e) => {
          setText(e.target.value);
          onDirty?.(e.target.value !== initial);
        }}
        spellCheck
        placeholder={placeholder}
        className="min-h-60 max-w-[68ch] font-serif text-base leading-relaxed md:text-base"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : saveLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            onDirty?.(false);
            onCancel();
          }}
        >
          Cancel
        </Button>
        <span className="text-muted-foreground text-sm" aria-live="polite">
          {dirty ? "Unsaved changes" : ""}
        </span>
      </div>
    </form>
  );
}

/** One row of the blanks form. */
function BlankField({
  blank,
  value,
  onValue,
  save,
  onSave,
  onRemove,
  busy,
}: {
  blank: Blank;
  value: string;
  onValue: (value: string) => void;
  save: boolean;
  onSave: (save: boolean) => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const id = useId();
  if (blank.kind === "check") {
    return (
      <li className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
        <Label htmlFor={id}>Check this sentence</Label>
        <p id={`${id}-hint`} className="text-muted-foreground text-sm">
          Your facts don't back it. Make it true in your own words, or remove it.
        </p>
        <div className="flex items-start gap-2">
          <Textarea
            id={id}
            data-jump
            aria-describedby={`${id}-hint`}
            value={value}
            onChange={(e) => onValue(e.target.value)}
            className="min-h-16 flex-1 font-serif"
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
      <Label htmlFor={id}>{blank.label}</Label>
      <Input id={id} data-jump value={value} onChange={(e) => onValue(e.target.value)} />
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-save`} checked={save} onCheckedChange={(checked) => onSave(checked === true)} />
        <Label htmlFor={`${id}-save`} className="font-normal text-muted-foreground">
          Also save to my facts
        </Label>
      </div>
    </li>
  );
}

/**
 * "Needs your input" under a file: an input for each blank. Missing information can also be kept
 * as a fact; a Check this sentence can be rewritten or removed. One Save applies every filled
 * input; empty ones stay blanks. Typed values survive a save, so Remove never loses them.
 */
export function BlanksForm({
  opportunityId,
  output,
  blanks,
}: {
  opportunityId: OpportunityId;
  output: OutputDto;
  /** The blanks' inner texts, as the gate reports them. */
  blanks: readonly string[];
}) {
  const id = useId();
  const fill = useFillBlanks(opportunityId);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [keep, setKeep] = useState<Readonly<Record<string, boolean>>>({});
  const parsed = [...new Set(blanks)].map(parseBlank);
  if (parsed.length === 0) return null;
  const textFor = (b: Blank) => values[b.blank] ?? (b.kind === "check" ? b.sentence : "");
  const keepOf = (b: Blank) => keep[b.blank] ?? true;
  const filled = parsed.filter((b) => textFor(b).trim() !== "");

  function forget(done: readonly string[]) {
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !done.includes(k))));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (filled.length === 0 || fill.isPending) return;
    const answers = filled.map((b) => ({
      blank: b.blank,
      value: textFor(b).trim(),
      saveAsFact: b.kind === "missing" && keepOf(b),
    }));
    const saved = answers.filter((a) => a.saveAsFact).length;
    fill
      .mutateAsync({ id: output.id, answers, remove: [] })
      .then(() => {
        forget(answers.map((a) => a.blank));
        toast(saved > 0 ? `Answers saved. ${saved} also saved to your facts.` : "Answers saved.");
      })
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }

  function remove(blank: string) {
    fill
      .mutateAsync({ id: output.id, answers: [], remove: [blank] })
      .then(() => {
        forget([blank]);
        toast("Sentence removed.");
      })
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }

  return (
    <section
      aria-labelledby={`${id}-h`}
      className="grid max-w-[68ch] gap-3 rounded-lg border border-warning/40 bg-warning-surface p-4"
    >
      <h3 id={`${id}-h`} className="font-medium text-sm text-warning-foreground">
        Needs your input <span className="tabular-nums">({parsed.length})</span>
      </h3>
      <form onSubmit={submit} className="grid gap-3">
        <ul className="divide-y divide-warning/25">
          {parsed.map((b) => (
            <BlankField
              key={b.blank}
              blank={b}
              value={textFor(b)}
              onValue={(value) => setValues((v) => ({ ...v, [b.blank]: value }))}
              save={keepOf(b)}
              onSave={(next) => setKeep((k) => ({ ...k, [b.blank]: next }))}
              onRemove={() => remove(b.blank)}
              busy={fill.isPending}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={filled.length === 0 || fill.isPending}>
            {fill.isPending ? "Saving…" : "Save answers"}
          </Button>
          <span className="text-muted-foreground text-sm">Empty boxes stay as blanks.</span>
        </div>
      </form>
    </section>
  );
}

/** Edit text and Regenerate, behind the card's overflow button. */
function MoreActions({
  label,
  onEdit,
  regenerate,
  disabled,
}: {
  label: string;
  onEdit: () => void;
  regenerate: { label: string; run: () => void; disabled: boolean } | null;
  disabled: boolean;
}) {
  // Editing moves focus to the text box, so the menu must not pull it back to its button.
  const editing = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`More actions for the ${label.toLowerCase()}`}
          className="text-muted-foreground hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <EllipsisIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        onCloseAutoFocus={(e) => {
          if (editing.current) e.preventDefault();
          editing.current = false;
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => {
              editing.current = true;
              onEdit();
            }}
          >
            Edit text
          </DropdownMenuItem>
          {regenerate && (
            <DropdownMenuItem disabled={disabled || regenerate.disabled} onSelect={regenerate.run}>
              {regenerate.label}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One file on the job page. A resume is its status line and the PDF actions; a letter adds its
 * clean text below; a message has no PDF. Frozen jobs keep only Preview, Copy and Download.
 */
export function FileCard({
  output,
  frozen,
  blocked,
  blanks,
  drafting,
  saving,
  onSaveText,
  draftButton,
  regenerate,
  review,
  outdated,
  fillForm,
  changes = null,
}: {
  output: OutputDto;
  frozen: boolean;
  /** Whether the workspace gate blocks export. */
  blocked: boolean;
  /** How many blanks this file has. */
  blanks: number;
  /** A draft task is writing this file now. */
  drafting: boolean;
  saving: boolean;
  /** Settles when the save does. */
  onSaveText: (text: string) => Promise<unknown>;
  /** Draft (or the no-key hint) for a file with no text yet. */
  draftButton: ReactNode;
  /** Regenerate in the overflow menu; null when drafting is not possible. */
  regenerate: { label: string; run: () => void; disabled: boolean } | null;
  /** Mark reviewed, told whether unsaved edits are open. */
  review: (busy: boolean) => ReactNode;
  outdated: ReactNode;
  /** The blanks form, shown under the card. */
  fillForm: ReactNode;
  /** A tailored resume's changes to the CV (decision 75), shown under the card. */
  changes?: ReactNode;
}) {
  const now = useMinuteClock();
  const exports = useExports(output);
  const { editing, setEditing, dirty, setDirty } = useEditing(output);
  const label = outputKindLabel(output.kind);
  const pdf = PDF_KINDS.some((k) => k === output.kind);
  const written = output.text !== null && output.text.trim() !== "";
  const canEdit = !frozen && !drafting;

  if (editing && canEdit) {
    return (
      <div className="grid gap-4">
        {outdated}
        <TextEditor
          key={`${output.editedAt ?? ""}:${output.generatedAt ?? ""}`}
          label={`${label} text`}
          initial={output.text ?? ""}
          placeholder={`Write your ${label.toLowerCase()} here. Use [[what is missing]] for anything you still need to fill in.`}
          saving={saving}
          onDirty={setDirty}
          onCancel={() => setEditing(false)}
          onSave={(text) =>
            onSaveText(text).then(() => {
              setDirty(false);
              setEditing(false);
            })
          }
        />
        <div>{review(dirty || saving)}</div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {outdated}
      <section aria-label={`The ${label.toLowerCase()}`} className="grid gap-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm tabular-nums" aria-live="polite">
              {drafting
                ? "Drafting…"
                : written
                  ? fileStatusLabel({
                      generatedAt: output.generatedAt,
                      editedAt: output.editedAt,
                      words: output.words,
                      blanks,
                      now,
                    })
                  : "Not written yet."}
            </p>
            {written && output.kind === "resume" && resumeLikelyLong(output.words) && (
              <p className="text-sm text-warning-foreground">
                Likely over one page. Check Preview PDF; most resumes read best on one.
              </p>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {written ? (
              <>
                {pdf && <PreviewDialog output={output} exports={exports} blocked={blocked} />}
                <CopyButton exports={exports} blocked={blocked} />
                {pdf && <DownloadButton exports={exports} blocked={blocked} />}
                {!frozen && (
                  <MoreActions
                    label={label}
                    disabled={drafting}
                    onEdit={() => setEditing(true)}
                    regenerate={regenerate}
                  />
                )}
              </>
            ) : (
              !frozen &&
              !drafting && (
                <>
                  {draftButton}
                  <Button size="sm" variant="outline" data-jump onClick={() => setEditing(true)}>
                    Write it yourself
                  </Button>
                </>
              )
            )}
          </div>
        </div>
        {written && output.kind !== "resume" && output.plain && <PlainText text={output.plain} />}
        {written && !frozen && <StyleHits output={output} />}
        {written && !frozen && !drafting && <div>{review(saving)}</div>}
      </section>
      {written && !frozen && !drafting && changes}
      {!frozen && fillForm}
    </div>
  );
}

/** A question's answer: its clean text with Copy, and Edit text inline. */
export function AnswerBody({
  answer,
  frozen,
  blocked,
  drafting,
  saving,
  onSaveText,
  actions,
  review,
}: {
  answer: OutputDto;
  frozen: boolean;
  blocked: boolean;
  drafting: boolean;
  saving: boolean;
  onSaveText: (text: string) => Promise<unknown>;
  /** Draft answer or Regenerate. */
  actions: ReactNode;
  review: (busy: boolean) => ReactNode;
}) {
  const exports = useExports(answer);
  const { editing, setEditing, dirty, setDirty } = useEditing(answer);
  const question = answer.question ?? "Answer";
  const written = answer.plain !== null && answer.plain.trim() !== "";
  const usesProfile = answer.mustAnswer !== null && answer.body === null && answer.profileAnswer !== null;

  if (editing && !frozen && !drafting) {
    return (
      <div className="grid gap-2">
        <TextEditor
          key={`${answer.editedAt ?? ""}:${answer.generatedAt ?? ""}`}
          label={question}
          initial={answer.text ?? ""}
          saveLabel="Save answer"
          placeholder={
            answer.mustAnswer
              ? answer.profileAnswer
                ? `Uses your profile answer: ${answer.profileAnswer}`
                : "Answer here for this job, or save a standard answer under Needs your input."
              : "Write your answer. Use [[what is missing]] for anything you still need to fill in."
          }
          saving={saving}
          onDirty={setDirty}
          onCancel={() => setEditing(false)}
          onSave={(text) =>
            onSaveText(text).then(() => {
              setDirty(false);
              setEditing(false);
            })
          }
          className="[&_textarea]:min-h-24"
        />
        <div>{review(dirty || saving)}</div>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {written && answer.plain ? (
        <PlainText text={answer.plain} />
      ) : usesProfile ? (
        <p className="text-muted-foreground text-sm">Uses your profile answer: {answer.profileAnswer}</p>
      ) : (
        <p className="text-muted-foreground text-sm">Not answered yet.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(written || usesProfile) && <CopyButton exports={exports} blocked={blocked} />}
        {!frozen &&
          (drafting ? (
            <span className="text-muted-foreground text-sm">Drafting…</span>
          ) : (
            <>
              <Button size="sm" variant="outline" data-jump onClick={() => setEditing(true)}>
                {written ? "Edit text" : "Write answer"}
              </Button>
              {actions}
              {review(saving)}
            </>
          ))}
      </div>
    </div>
  );
}
