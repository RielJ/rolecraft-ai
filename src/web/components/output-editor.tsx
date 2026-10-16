import { CopyIcon, FileDownIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { GateBlocker, OutputDto } from "@/shared/api";
import { PDF_KINDS } from "@/shared/enums";
import { outputKindLabel } from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { downloadPdf, fetchText } from "../queries";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

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
 * One file's editor: the body with `[FACT-n]` markers, the facts it cites (with the text saved
 * when each marker was first written), and the gated export actions.
 * The parent keys this by id and edit time, so a saved edit remounts it with the server's body.
 */
export function OutputEditor({
  output,
  frozen,
  blockers,
  blocked,
  saving,
  onSave,
}: {
  output: OutputDto;
  frozen: boolean;
  /** Blockers that point at this output, shown under the editor. */
  blockers: GateBlocker[];
  /** Whether the workspace gate blocks export. */
  blocked: boolean;
  saving: boolean;
  onSave: (body: string | null) => void;
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
      <label htmlFor={id} className="sr-only">
        {label} text
      </label>
      <Textarea
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        readOnly={frozen}
        spellCheck
        placeholder={`Write your ${label.toLowerCase()} here. Cite a fact with its key, like [FACT-1]. Use [[what is missing]] for anything you still need to fill in.`}
        className="min-h-80 max-w-[68ch] font-serif text-base leading-relaxed md:text-base"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={!dirty || saving || frozen}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="text-muted-foreground text-sm" aria-live="polite">
          {dirty ? "Unsaved changes" : output.editedAt ? "Saved" : ""}
        </span>
        <div className="ml-auto">
          <ExportActions output={output} blocked={blocked || dirty} />
        </div>
      </div>
      {blockers.length > 0 && (
        <p className="text-sm text-warning-foreground">
          {blockers.length} item{blockers.length === 1 ? "" : "s"} in this {label.toLowerCase()} need your input.
        </p>
      )}
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
