import { CopyIcon, FileDownIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import type { GateBlocker, OutputDto } from "@/shared/api";
import { PDF_KINDS } from "@/shared/enums";
import { outdatedLabel, outputKindLabel } from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { downloadPdf, fetchText } from "../queries";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { BodyPreview } from "./body-preview";

function exportFailed(error: unknown, what: string): void {
  if (error instanceof ApiError && error.code === "needs_input") {
    const count = error.blockers.length;
    toast.error(`${what} is blocked by ${count} item${count === 1 ? "" : "s"} under Needs your input.`);
    return;
  }
  toast.error(errorMessage(error));
}

function ExportActions({ output, blocked }: { output: OutputDto; blocked: boolean }) {
  const [busy, setBusy] = useState<"pdf" | "text" | null>(null);
  const pdf = PDF_KINDS.some((k) => k === output.kind);
  const label = outputKindLabel(output.kind);

  async function exportPdf() {
    setBusy("pdf");
    try {
      await downloadPdf(output.id);
    } catch (error) {
      exportFailed(error, "Export");
    } finally {
      setBusy(null);
    }
  }
  async function copyText() {
    setBusy("text");
    try {
      await navigator.clipboard.writeText(await fetchText(output.id));
      toast(`${label} copied as plain text.`);
    } catch (error) {
      exportFailed(error, "Copy");
    } finally {
      setBusy(null);
    }
  }

  const reason = blocked ? "Clear Needs your input first" : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pdf && (
        <Button variant="outline" size="sm" onClick={exportPdf} disabled={blocked || busy !== null} title={reason}>
          <FileDownIcon aria-hidden />
          {busy === "pdf" ? "Exporting…" : "Export PDF"}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={copyText} disabled={blocked || busy !== null} title={reason}>
        <CopyIcon aria-hidden />
        Copy as text
      </Button>
    </div>
  );
}

/**
 * The facts this output cites changed since it was written (section 2, Provenance). Edited facts
 * show old and new text; Mark up to date accepts the new text without redrafting.
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
            <span className="font-medium">{outdatedLabel(change)}</span>
            {change.reason === "edited" && (
              <>
                <span className="text-muted-foreground">
                  Was: <span className="line-through decoration-1">{change.oldText}</span>
                </span>
                <span>Now: {change.newText}</span>
              </>
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
 * One file's editor: the body with `[FACT-n]` markers, the facts it cites (with the text saved
 * when each marker was first written), a preview with citation chips and style hits, and the
 * gated export actions. The parent keys this by id, edit time and draft time, so a saved edit or
 * a new draft remounts it with the server's body.
 */
export function OutputEditor({
  output,
  frozen,
  blockers,
  blocked,
  saving,
  onSave,
  drafting,
  draftButton,
  outdated,
}: {
  output: OutputDto;
  frozen: boolean;
  /** Blockers that point at this output, shown under the editor. */
  blockers: GateBlocker[];
  /** Whether the workspace gate blocks export. */
  blocked: boolean;
  saving: boolean;
  onSave: (body: string | null) => void;
  /** True while a draft task is writing this output; the text stays readable but not editable. */
  drafting: boolean;
  /** Draft or Regenerate, or a hint when there is no key. */
  draftButton: ReactNode;
  /** The outdated notice, when facts this output cites changed. */
  outdated: ReactNode;
}) {
  const id = useId();
  const saved = output.body ?? "";
  const [draft, setDraft] = useState(saved);
  const dirty = draft !== saved;
  const label = outputKindLabel(output.kind);

  const save = () => {
    if (dirty) onSave(draft.trim() === "" ? null : draft);
  };

  return (
    <div className="grid gap-3">
      {outdated}
      <label htmlFor={id} className="sr-only">
        {label} text
      </label>
      <Textarea
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        readOnly={frozen || drafting}
        aria-busy={drafting}
        spellCheck
        placeholder={`Write your ${label.toLowerCase()} here. Cite a fact with its key, like [FACT-1]. Use [[what is missing]] for anything you still need to fill in.`}
        className={cn(
          "min-h-80 max-w-[68ch] font-serif text-base leading-relaxed transition-opacity md:text-base",
          drafting && "opacity-60",
        )}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={!dirty || saving || frozen || drafting}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {draftButton}
        <span className="text-muted-foreground text-sm" aria-live="polite">
          {dirty ? "Unsaved changes" : output.editedAt ? "Saved" : ""}
        </span>
        <div className="ml-auto">
          <ExportActions output={output} blocked={blocked || dirty} />
        </div>
      </div>
      {blockers.length > 0 && (
        <p className="text-sm text-warning-foreground">
          {blockers.length === 1 ? "1 item" : `${blockers.length} items`} in this {label.toLowerCase()}{" "}
          {blockers.length === 1 ? "needs" : "need"} your input.
        </p>
      )}
      <BodyPreview output={output} />
      {output.citations.length > 0 && (
        <section aria-label={`Facts cited in the ${label.toLowerCase()}`} className="max-w-[68ch]">
          <h3 className="font-medium text-muted-foreground text-xs">Cited facts</h3>
          <ul className="mt-2 grid gap-1.5">
            {output.citations.map((c) => (
              <li key={c.key} className="flex gap-2 text-sm">
                <span className="shrink-0 font-mono text-muted-foreground text-xs leading-5 tabular-nums">{c.key}</span>
                <span className={c.deleted ? "text-destructive line-through decoration-1" : ""}>{c.text}</span>
                {c.deleted && <span className="shrink-0 text-destructive text-xs leading-5">deleted</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
