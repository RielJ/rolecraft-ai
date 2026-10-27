import type { OutputId } from "@shared/api";
import { PDF_KINDS } from "@shared/enums";
import type {
  ApplicationSessionId,
  AttachRejectReason,
  ExtensionOutputDto,
  FieldDescriptor,
  FieldId,
  ScanNonce,
} from "@shared/extension";
import { outputKindLabel } from "@shared/labels";
import { useReducer } from "react";
import { z } from "zod";
import { PanelRefusal, type PanelReply } from "../messages";
import { ATTACH_PANEL_RESULTS, type AttachRequests } from "../messages-attach";

// Files: the user picks a resume or letter for one upload field of the current scan and clicks
// Attach. Nothing attaches without that click, and only into an empty field. This component never
// calls Chrome: the parent passes `send` (the worker bridge), the scan and the job's outputs.

type PdfOutput = ExtensionOutputDto & { kind: (typeof PDF_KINDS)[number] };

export type AttachAction = "attach" | "download";

export type AttachStatus =
  | { kind: "idle" }
  | { kind: "busy"; action: AttachAction }
  | { kind: "attached"; fileName: string }
  | { kind: "downloaded" }
  | { kind: "problem"; message: string; offerDownload: boolean };

type Row = { choice: OutputId | null; status: AttachStatus };

/** Rows belong to one scan: a new nonce starts over, and a late answer for an old scan is dropped. */
export type AttachState = { nonce: ScanNonce | null; rows: Readonly<Record<string, Row>> };

export type AttachEvent =
  | { kind: "chose"; nonce: ScanNonce; fieldId: FieldId; outputId: OutputId | null }
  | { kind: "started"; nonce: ScanNonce; fieldId: FieldId; outputId: OutputId; action: AttachAction }
  | { kind: "settled"; nonce: ScanNonce; fieldId: FieldId; status: AttachStatus };

export const INITIAL_ATTACH_STATE: AttachState = { nonce: null, rows: {} };

export function attachReducer(state: AttachState, event: AttachEvent): AttachState {
  const current = state.nonce === event.nonce ? state.rows : {};
  switch (event.kind) {
    case "chose":
      return {
        nonce: event.nonce,
        rows: { ...current, [event.fieldId]: { choice: event.outputId, status: { kind: "idle" } } },
      };
    case "started":
      return {
        nonce: event.nonce,
        rows: {
          ...current,
          [event.fieldId]: { choice: event.outputId, status: { kind: "busy", action: event.action } },
        },
      };
    case "settled": {
      const row = current[event.fieldId];
      if (state.nonce !== event.nonce || row === undefined) return state;
      return { nonce: event.nonce, rows: { ...current, [event.fieldId]: { ...row, status: event.status } } };
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// ---------- Derived views ----------

export function fileFields(fields: readonly FieldDescriptor[]): FieldDescriptor[] {
  return fields.filter((f) => f.control === "file");
}

function isPdfOutput(output: ExtensionOutputDto): output is PdfOutput {
  return PDF_KINDS.some((k) => k === output.kind);
}

/** Resumes and cover letters, the outputs Rolecraft exports as PDF. Resumes first. */
export function attachableOutputs(outputs: readonly ExtensionOutputDto[]): PdfOutput[] {
  const pdfs = outputs.filter(isPdfOutput);
  return [...pdfs.filter((o) => o.kind === "resume"), ...pdfs.filter((o) => o.kind === "letter")];
}

const LETTER_LABEL = /cover|letter|motivation/i;
const RESUME_LABEL = /r[eé]sum[eé]|\bcv\b|curriculum/i;

/** A starting choice from the field's label when exactly one output fits it; the user can change it. */
export function suggestedOutput(field: FieldDescriptor, outputs: readonly PdfOutput[]): OutputId | null {
  const kind = LETTER_LABEL.test(field.label) ? "letter" : RESUME_LABEL.test(field.label) ? "resume" : null;
  if (kind === null) return null;
  const fits = outputs.filter((o) => o.kind === kind);
  return fits.length === 1 && fits[0] !== undefined ? fits[0].id : null;
}

export function rejectionText(reason: AttachRejectReason): string {
  switch (reason) {
    case "not_empty":
      return "That field already has a file. Remove it on the page first.";
    case "stale":
      return "The form changed since the scan. Scan again.";
    case "not_file_input":
      return "That field didn't take the file. Upload it on the page yourself.";
    case "too_large":
      return "The PDF is over 10 MB, too big to attach.";
    case "wrong_type":
      return "This field doesn't take PDFs, or the file isn't a valid PDF.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function refusalText(reason: PanelRefusal): string {
  switch (reason) {
    case "not_active":
      return "Switch to the application tab first.";
    case "unsupported_url":
      return "This tab isn't a web page Rolecraft can work with.";
    case "blocked_host":
      return "This site's terms forbid automated tools. Download the file and upload it yourself.";
    case "permission_denied":
      return "Chrome didn't allow access to this page.";
    case "not_bound":
      return "This tab isn't linked to the application anymore.";
    case "bad_reply":
      return "The page didn't answer. Scan again.";
    case "tab_changed":
      return "The tab moved to another page. Scan again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The reply results this panel cares about, parsed so anything else reads as a failure. */
const AttachReplyResult = z.discriminatedUnion("kind", [
  ...ATTACH_PANEL_RESULTS,
  z.object({ kind: z.literal("refused"), reason: PanelRefusal }),
  z.object({ kind: z.literal("failed"), code: z.string().max(60), message: z.string().max(500) }),
]);

/**
 * What one Attach or Download click came to. `result` is parsed, not trusted: any other kind reads
 * as a failure.
 */
export function statusFromReply({
  reply,
  action,
}: {
  reply: Pick<PanelReply, "status" | "error"> & { result?: unknown };
  action: AttachAction;
}): AttachStatus {
  const problem = (message: string, offerDownload = false): AttachStatus => ({
    kind: "problem",
    message,
    offerDownload,
  });
  const parsed = AttachReplyResult.safeParse(reply.result);
  if (!parsed.success) {
    if (reply.status.kind !== "paired") return problem("Rolecraft isn't connected, so nothing was attached.");
    return problem(reply.error ?? "Something went wrong. Nothing was attached.");
  }
  const result = parsed.data;
  switch (result.kind) {
    case "attach_done":
      return { kind: "attached", fileName: result.fileName };
    case "attach_rejected":
      return problem(rejectionText(result.reason), action === "attach");
    case "attach_downloaded":
      return { kind: "downloaded" };
    case "attach_download_failed":
      return problem("Chrome didn't save the file.");
    case "refused":
      return problem(refusalText(result.reason), action === "attach");
    case "failed":
      return problem(result.message);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

// ---------- View ----------

export type AttachmentsProps = {
  sessionId: ApplicationSessionId;
  tabId: number;
  /** The current scan, or null before the first one. */
  scan: { nonce: ScanNonce; fields: readonly FieldDescriptor[] } | null;
  outputs: readonly ExtensionOutputDto[];
  /** False when the active tab is not the bound one: Attach is disabled. */
  onBoundTab: boolean;
  /** The worker bridge. The parent also reads the connection status from the reply. */
  send: (request: AttachRequests) => Promise<PanelReply>;
};

function outputLabel(output: PdfOutput): string {
  const label = outputKindLabel(output.kind);
  return output.reviewedAt === null ? `${label} (not reviewed yet)` : label;
}

function StatusLine({ status, onDownload }: { status: AttachStatus; onDownload: () => void }) {
  switch (status.kind) {
    case "idle":
      return null;
    case "busy":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {status.action === "attach" ? "Attaching…" : "Saving…"}
        </p>
      );
    case "attached":
      return (
        <p role="status" className="text-xs text-muted-foreground break-words">
          Attached {status.fileName}. Check that the page lists it.
        </p>
      );
    case "downloaded":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          Saved to your Downloads folder. Upload it on the page yourself.
        </p>
      );
    case "problem":
      return (
        <div className="flex flex-col items-start gap-1.5">
          <p role="alert" className="text-xs text-destructive">
            {status.message}
          </p>
          {status.offerDownload && (
            <button type="button" className="btn-secondary" onClick={onDownload}>
              Download instead
            </button>
          )}
        </div>
      );
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The upload fields of the current scan, each with a file picker and Attach. Mounted in
 * Application.tsx, where the scan and the job's outputs live.
 */
export function FileAttachments({ sessionId, tabId, scan, outputs, onBoundTab, send }: AttachmentsProps) {
  const [state, dispatch] = useReducer(attachReducer, INITIAL_ATTACH_STATE);
  if (scan === null) return null;
  const fields = fileFields(scan.fields);
  if (fields.length === 0) return null;
  const pdfs = attachableOutputs(outputs);
  const { nonce } = scan;
  const rows = state.nonce === nonce ? state.rows : {};
  const busy = Object.values(rows).some((r) => r.status.kind === "busy");

  async function run({ fieldId, outputId, action }: { fieldId: FieldId; outputId: OutputId; action: AttachAction }) {
    dispatch({ kind: "started", nonce, fieldId, outputId, action });
    const reply = await send(
      action === "attach"
        ? { kind: "attach", sessionId, tabId, nonce, fieldId, outputId }
        : { kind: "attach_download", sessionId, outputId },
    );
    dispatch({ kind: "settled", nonce, fieldId, status: statusFromReply({ reply, action }) });
  }

  return (
    <section aria-labelledby="files-title" className="flex flex-col gap-1.5">
      <h3 id="files-title" className="text-sm font-semibold">
        Files <span className="font-normal text-muted-foreground tabular-nums">{fields.length}</span>
      </h3>
      <p className="text-xs text-muted-foreground">
        Pick a file for each upload field, then click Attach. It only goes into an empty field, and you submit the form
        yourself.
      </p>
      {pdfs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This job has no resume or cover letter yet. Draft them in Rolecraft first.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-control border border-border">
          {fields.map((field) => {
            const row = rows[field.fieldId];
            const choice = row === undefined ? suggestedOutput(field, pdfs) : row.choice;
            const status = row?.status ?? { kind: "idle" };
            const selectId = `attach-${field.fieldId}`;
            return (
              <li key={field.fieldId} className="flex flex-col gap-1.5 px-3 py-2.5">
                <label htmlFor={selectId} className="text-sm break-words">
                  {field.label === "" ? "Upload field without a label" : field.label}
                  {field.required && <span className="text-muted-foreground"> (required)</span>}
                </label>
                <div className="flex items-center gap-2">
                  <select
                    id={selectId}
                    className="field min-w-0 flex-1 bg-background"
                    value={choice ?? ""}
                    disabled={status.kind === "busy"}
                    onChange={(e) => {
                      const picked = pdfs.find((o) => o.id === e.target.value);
                      dispatch({ kind: "chose", nonce, fieldId: field.fieldId, outputId: picked?.id ?? null });
                    }}
                  >
                    <option value="">Choose a file</option>
                    {pdfs.map((output) => (
                      <option key={output.id} value={output.id}>
                        {outputLabel(output)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary shrink-0"
                    disabled={choice === null || busy || !onBoundTab || status.kind === "attached"}
                    onClick={() => {
                      if (choice !== null) void run({ fieldId: field.fieldId, outputId: choice, action: "attach" });
                    }}
                  >
                    Attach
                  </button>
                </div>
                <StatusLine
                  status={status}
                  onDownload={() => {
                    if (choice !== null) void run({ fieldId: field.fieldId, outputId: choice, action: "download" });
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
