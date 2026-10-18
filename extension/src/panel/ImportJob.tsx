import type { AddJobResult } from "@shared/api";
import type { LookupResult } from "@shared/extension";
import { useRef, useState } from "react";
import type { OriginAccess } from "../background/permissions";
import type { PanelReply } from "../messages";
import {
  IMPORT_LIMITS,
  type ImportDraft,
  ImportEdits,
  type ImportPanelRequest,
  type ImportRefusal,
  type ImportReply,
} from "../messages-import";

// "Import this page": read the visible job on the current tab, check whether it is already saved,
// let the user edit what was read, and save it only on Import. Rules, enforced by `importTransition`
// and checked in extension/test/import.test.ts:
// - nothing is read until the "Read this page" click;
// - an already-saved job is shown with a link to it, and no import is offered;
// - the only event that yields `job_import` is `import_clicked`; Cancel sends nothing.

export type ImportFields = Record<keyof ImportEdits, string>;

type Found = Extract<LookupResult, { kind: "found" }>;

export type ImportState =
  | { kind: "idle"; notice: string | null }
  | { kind: "reading" }
  | { kind: "looking_up"; draft: ImportDraft }
  | { kind: "found"; found: Found }
  | { kind: "editing"; draft: ImportDraft; fields: ImportFields; error: string | null; notice: string | null }
  | { kind: "importing"; draft: ImportDraft; fields: ImportFields }
  | { kind: "imported"; result: AddJobResult; title: string };

export type ImportEvent =
  /** The click, after the panel asked Chrome for the tab's origin. */
  | { kind: "read_clicked"; tabId: number | null; access: OriginAccess }
  | { kind: "reply"; reply: ImportReply }
  | { kind: "edited"; field: keyof ImportFields; value: string }
  | { kind: "import_clicked" }
  | { kind: "cancel_clicked" };

export type ImportStep = { state: ImportState; requests: ImportPanelRequest[] };

export const IMPORT_INITIAL: ImportState = { kind: "idle", notice: null };

const REFUSALS: Record<ImportRefusal, string> = {
  not_active: "Switch to the job's tab, then try again.",
  unsupported_url: "The extension can only read web pages served over HTTPS.",
  blocked_host:
    "This site's terms forbid automated tools, so the extension won't read it. Paste the job into Hanapbuhay instead.",
  permission_denied: "Chrome didn't let the extension read this tab. Click Read this page and allow access.",
  not_bound: "The extension lost track of this tab. Try again.",
  bad_reply: "The page didn't answer. Reload it and try again.",
};

const FIELD_ERRORS: Record<keyof ImportEdits, string> = {
  applyUrl: "The apply link must be a full http:// or https:// address.",
  title: "Add the job title.",
  company: "Add the company.",
  location: "Shorten the location.",
  description: "Add the job description.",
};

function failure(reply: ImportReply): string {
  const { result } = reply;
  if (result?.kind === "refused") return REFUSALS[result.reason];
  if (result?.kind === "failed") return result.message;
  return reply.error ?? "The extension's background worker did not answer.";
}

function fieldsOf(draft: ImportDraft): ImportFields {
  const { applyUrl, title, company, location, description } = draft;
  return { applyUrl, title, company, location, description };
}

function editing(draft: ImportDraft, notice: string | null): ImportState {
  return { kind: "editing", draft, fields: fieldsOf(draft), error: null, notice };
}

function stay(state: ImportState): ImportStep {
  return { state, requests: [] };
}

function onReply(state: ImportState, reply: ImportReply): ImportStep {
  const result = reply.result;
  switch (state.kind) {
    case "reading":
      if (result?.kind !== "job_extracted") return stay({ kind: "idle", notice: failure(reply) });
      return {
        state: { kind: "looking_up", draft: result.draft },
        requests: [{ kind: "job_lookup", url: result.draft.applyUrl }],
      };
    case "looking_up":
      if (result?.kind !== "job_lookup") {
        return stay(
          editing(state.draft, "Couldn't check whether this job is already saved. Import finds it if it is."),
        );
      }
      return stay(
        result.lookup.kind === "found" ? { kind: "found", found: result.lookup } : editing(state.draft, null),
      );
    case "importing":
      if (result?.kind !== "job_imported") {
        return stay({ kind: "editing", draft: state.draft, fields: state.fields, error: failure(reply), notice: null });
      }
      return stay({ kind: "imported", result: result.result, title: state.fields.title.trim() });
    case "idle":
    case "found":
    case "editing":
    case "imported":
      // A reply after Cancel, or for a request this state did not send: ignore it.
      return stay(state);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The import screen as a pure state machine. Returns the next state and the worker requests to send. */
export function importTransition(state: ImportState, event: ImportEvent): ImportStep {
  switch (event.kind) {
    case "read_clicked": {
      if (state.kind === "reading" || state.kind === "looking_up" || state.kind === "importing") return stay(state);
      if (event.tabId === null) return stay({ kind: "idle", notice: "Open the job's page in this window first." });
      if (event.access.kind === "refused") return stay({ kind: "idle", notice: REFUSALS[event.access.reason] });
      if (event.access.kind === "denied") return stay({ kind: "idle", notice: REFUSALS.permission_denied });
      return { state: { kind: "reading" }, requests: [{ kind: "job_extract", tabId: event.tabId }] };
    }
    case "reply":
      return onReply(state, event.reply);
    case "edited":
      if (state.kind !== "editing") return stay(state);
      return stay({ ...state, fields: { ...state.fields, [event.field]: event.value }, error: null });
    case "import_clicked": {
      if (state.kind !== "editing") return stay(state);
      const edits = ImportEdits.safeParse(state.fields);
      if (!edits.success) {
        const key = edits.error.issues[0]?.path[0];
        const message =
          key === "applyUrl" || key === "title" || key === "company" || key === "location" || key === "description"
            ? FIELD_ERRORS[key]
            : "Check the fields and try again.";
        return stay({ ...state, error: message });
      }
      return {
        state: { kind: "importing", draft: state.draft, fields: state.fields },
        requests: [{ kind: "job_import", edits: edits.data }],
      };
    }
    case "cancel_clicked":
      // Nothing was saved before Import; Cancel only forgets what was read. Not while saving.
      return stay(state.kind === "importing" ? state : IMPORT_INITIAL);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** The workspace page for an opportunity, or the app's home when the job is not on the board. */
export function workspaceUrl(endpoint: string, opportunityId: string | null): string {
  return opportunityId === null
    ? new URL("/", endpoint).href
    : new URL(`/jobs/${encodeURIComponent(opportunityId)}`, endpoint).href;
}

export type ImportJobProps = {
  /** The paired server, for links to the web workspace. */
  endpoint: string;
  /** The active tab, kept current by the parent. */
  tab: { tabId: number; url: string | null } | null;
  /** `requestOriginAccess` from background/permissions.ts; must be the click's first await. */
  requestAccess: (url: string) => Promise<OriginAccess>;
  /** `sendToWorker`, narrowed with `asImportReply`. */
  send: (request: ImportPanelRequest) => Promise<ImportReply>;
  /** Gets every reply whose status is not `paired`, so the pairing screen comes back. */
  onReply: (reply: Pick<PanelReply, "status" | "error">) => void;
};

/** The Import screen in App.tsx. */
export function ImportJobPanel({ endpoint, tab, requestAccess, send, onReply }: ImportJobProps) {
  const [state, setState] = useState<ImportState>(IMPORT_INITIAL);
  const ref = useRef(state);
  // Bumped on every dispatch that sends; a reply for an older request is dropped.
  const seq = useRef(0);

  function dispatch(event: ImportEvent) {
    const out = importTransition(ref.current, event);
    ref.current = out.state;
    setState(out.state);
    for (const request of out.requests) {
      const mine = ++seq.current;
      void send(request).then((reply) => {
        if (mine !== seq.current) return;
        if (reply.status.kind !== "paired") {
          onReply(reply);
          ref.current = IMPORT_INITIAL;
          setState(IMPORT_INITIAL);
          return;
        }
        dispatch({ kind: "reply", reply });
      });
    }
  }

  async function read() {
    const url = tab?.url ?? null;
    if (tab === null || url === null) {
      dispatch({ kind: "read_clicked", tabId: null, access: { kind: "refused", reason: "unsupported_url" } });
      return;
    }
    const access = await requestAccess(url);
    dispatch({ kind: "read_clicked", tabId: tab.tabId, access });
  }

  function cancel() {
    seq.current += 1;
    dispatch({ kind: "cancel_clicked" });
  }

  return (
    <section aria-labelledby="import-title" className="flex flex-col gap-3">
      <h2 id="import-title" className="text-sm font-semibold">
        Import this page
      </h2>
      {(() => {
        switch (state.kind) {
          case "idle":
            return (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  Save the job on this tab to Hanapbuhay. You check and edit what was read before anything is saved.
                </p>
                {state.notice !== null && (
                  <p role="status" className="rounded-control bg-muted px-3 py-2 text-sm">
                    {state.notice}
                  </p>
                )}
                <button type="button" className="btn-primary" onClick={() => void read()}>
                  Read this page
                </button>
              </div>
            );
          case "reading":
          case "looking_up":
            return (
              <div className="flex flex-col items-start gap-3">
                <p role="status" className="text-sm text-muted-foreground">
                  {state.kind === "reading" ? "Reading the page…" : "Checking whether it's already saved…"}
                </p>
                <button type="button" className="btn-secondary" onClick={cancel}>
                  Cancel
                </button>
              </div>
            );
          case "found":
            return <AlreadySaved found={state.found} endpoint={endpoint} onDone={cancel} />;
          case "editing":
          case "importing":
            return (
              <Preview
                draft={state.draft}
                fields={state.fields}
                error={state.kind === "editing" ? state.error : null}
                notice={state.kind === "editing" ? state.notice : null}
                busy={state.kind === "importing"}
                onEdit={(field, value) => dispatch({ kind: "edited", field, value })}
                onImport={() => dispatch({ kind: "import_clicked" })}
                onCancel={cancel}
              />
            );
          case "imported":
            return (
              <div className="flex flex-col items-start gap-3">
                <p role="status" className="text-sm">
                  {state.result.kind === "created"
                    ? `Saved “${state.title}” to Hanapbuhay.`
                    : `“${state.title}” was already saved, so nothing new was added.`}
                </p>
                <div className="flex gap-2">
                  <a
                    className="btn-secondary"
                    href={workspaceUrl(endpoint, state.result.opportunityId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Hanapbuhay
                  </a>
                  <button type="button" className="btn-secondary" onClick={cancel}>
                    Done
                  </button>
                </div>
              </div>
            );
          default: {
            const exhaustive: never = state;
            return exhaustive;
          }
        }
      })()}
    </section>
  );
}

function AlreadySaved({ found, endpoint, onDone }: { found: Found; endpoint: string; onDone: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p role="status" className="text-sm">
        Already saved: <span className="font-medium break-words">{found.title}</span>
        {found.company !== "" && <> at {found.company}</>}.
        {found.opportunityId === null && " It isn't on your board yet."}
      </p>
      <div className="flex gap-2">
        <a
          className="btn-secondary"
          href={workspaceUrl(endpoint, found.opportunityId)}
          target="_blank"
          rel="noreferrer"
        >
          {found.opportunityId === null ? "Open Hanapbuhay" : "Open in Hanapbuhay"}
        </a>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

const FIELD_SPECS = [
  { key: "title", label: "Title", max: IMPORT_LIMITS.title },
  { key: "company", label: "Company", max: IMPORT_LIMITS.company },
  { key: "location", label: "Location", max: IMPORT_LIMITS.location },
  { key: "applyUrl", label: "Apply link", max: IMPORT_LIMITS.url },
] as const satisfies readonly { key: keyof ImportFields; label: string; max: number }[];

function Preview({
  draft,
  fields,
  error,
  notice,
  busy,
  onEdit,
  onImport,
  onCancel,
}: {
  draft: ImportDraft;
  fields: ImportFields;
  error: string | null;
  notice: string | null;
  busy: boolean;
  onEdit: (field: keyof ImportFields, value: string) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onImport();
      }}
    >
      <p className="text-xs text-muted-foreground">
        {draft.source === "json_ld"
          ? "Read from the page's job listing data. Check it before you import."
          : "Read from the visible page. Check it before you import."}
      </p>
      {notice !== null && (
        <p role="status" className="rounded-control bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {FIELD_SPECS.map(({ key, label, max }) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-xs font-medium">{label}</span>
          <input
            className="field w-full"
            type={key === "applyUrl" ? "url" : "text"}
            value={fields[key]}
            maxLength={max}
            disabled={busy}
            onChange={(e) => onEdit(key, e.target.value)}
          />
        </label>
      ))}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Description</span>
        <textarea
          className="field h-48 w-full py-2"
          value={fields.description}
          maxLength={IMPORT_LIMITS.description}
          disabled={busy}
          onChange={(e) => onEdit("description", e.target.value)}
        />
      </label>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Import"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
