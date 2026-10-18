import type { ApplicationSessionId, ConfirmAppliedResult, SuccessReason } from "@shared/extension";
import { useEffect, useRef, useState } from "react";
import type { PanelReply } from "../messages";
import type { ImportPanelRequest, ImportReply } from "../messages-import";

// "Did you submit this application?" Rules, enforced by `appliedTransition` and checked in
// extension/test/success.test.ts:
// - the bound tab is checked only while the parent passes a `watch` (it does so after the user
//   filled or attached on that tab), and a check never calls the server;
// - a success signal only opens the question;
// - the only event that yields `confirm_applied` is `yes_clicked`;
// - after No, this session is not asked about again.

export const SUCCESS_CHECK_MS = 3000;

/** The bound session and its tab. */
export type AppliedWatch = { sessionId: ApplicationSessionId; tabId: number };

export type AppliedState =
  | { kind: "off" }
  | { kind: "watching"; watch: AppliedWatch; checking: boolean }
  | { kind: "asking"; watch: AppliedWatch; reason: SuccessReason }
  | { kind: "confirming"; watch: AppliedWatch; reason: SuccessReason }
  | { kind: "failed"; watch: AppliedWatch; reason: SuccessReason; message: string }
  | { kind: "confirmed"; watch: AppliedWatch; result: ConfirmAppliedResult }
  | { kind: "declined"; watch: AppliedWatch };

export type AppliedEvent =
  /** The parent's `watch` prop changed. */
  | { kind: "watch"; watch: AppliedWatch | null }
  | { kind: "tick" }
  | { kind: "reply"; reply: ImportReply }
  | { kind: "yes_clicked" }
  | { kind: "no_clicked" };

export type AppliedStep = { state: AppliedState; requests: ImportPanelRequest[] };

export const APPLIED_INITIAL: AppliedState = { kind: "off" };

function sameWatch(a: AppliedWatch, b: AppliedWatch): boolean {
  return a.sessionId === b.sessionId && a.tabId === b.tabId;
}

function stay(state: AppliedState): AppliedStep {
  return { state, requests: [] };
}

function onReply(state: AppliedState, reply: ImportReply): AppliedStep {
  const result = reply.result;
  switch (state.kind) {
    case "watching": {
      if (!state.checking) return stay(state);
      // The session ended or the tab lost its link: stop checking.
      if (result?.kind === "refused" && result.reason === "not_bound") return stay(APPLIED_INITIAL);
      if (result?.kind === "success_checked" && result.reason !== null) {
        return stay({ kind: "asking", watch: state.watch, reason: result.reason });
      }
      // No signal, or the tab could not be read right now (navigating, another origin): keep watching.
      return stay({ ...state, checking: false });
    }
    case "confirming": {
      if (result?.kind === "applied") return stay({ kind: "confirmed", watch: state.watch, result: result.result });
      const message =
        result?.kind === "failed"
          ? result.message
          : result?.kind === "refused"
            ? "This tab is no longer linked to the application. Mark it applied from Hanapbuhay instead."
            : (reply.error ?? "The extension's background worker did not answer.");
      return stay({ kind: "failed", watch: state.watch, reason: state.reason, message });
    }
    case "off":
    case "asking":
    case "failed":
    case "confirmed":
    case "declined":
      return stay(state);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The prompt as a pure state machine. Returns the next state and the worker requests to send. */
export function appliedTransition(state: AppliedState, event: AppliedEvent): AppliedStep {
  switch (event.kind) {
    case "watch": {
      if (event.watch === null) return stay(APPLIED_INITIAL);
      // Same session and tab: keep whatever was asked or answered.
      if (state.kind !== "off" && sameWatch(state.watch, event.watch)) return stay(state);
      return stay({ kind: "watching", watch: event.watch, checking: false });
    }
    case "tick":
      if (state.kind !== "watching" || state.checking) return stay(state);
      return {
        state: { ...state, checking: true },
        requests: [{ kind: "success_check", sessionId: state.watch.sessionId, tabId: state.watch.tabId }],
      };
    case "reply":
      return onReply(state, event.reply);
    case "yes_clicked":
      if (state.kind !== "asking" && state.kind !== "failed") return stay(state);
      return {
        state: { kind: "confirming", watch: state.watch, reason: state.reason },
        requests: [{ kind: "confirm_applied", sessionId: state.watch.sessionId, reason: state.reason }],
      };
    case "no_clicked":
      if (state.kind !== "asking" && state.kind !== "failed") return stay(state);
      return stay({ kind: "declined", watch: state.watch });
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

const REASON_TEXT: Record<SuccessReason, string> = {
  confirmation_url: "The page moved to what looks like a confirmation address.",
  confirmation_text: "The page shows a confirmation message.",
  form_gone: "The application form is no longer on the page.",
};

export type AppliedPromptProps = {
  /** Set once the user filled or attached on the bound tab; null stops all checks. */
  watch: AppliedWatch | null;
  /** `sendToWorker`, narrowed with `asImportReply`. */
  send: (request: ImportPanelRequest) => Promise<ImportReply>;
  /** Gets every reply whose status is not `paired`, so the pairing screen comes back. */
  onReply: (reply: Pick<PanelReply, "status" | "error">) => void;
  intervalMs?: number;
};

/** Mounted by Application.tsx with `appliedWatch(state)` from state.ts. */
export function AppliedPromptPanel({ watch, send, onReply, intervalMs = SUCCESS_CHECK_MS }: AppliedPromptProps) {
  const [state, setState] = useState<AppliedState>(APPLIED_INITIAL);
  const ref = useRef(state);
  const sendRef = useRef(send);
  sendRef.current = send;
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  // Built once over refs only, so it is stable for the effects below.
  const [dispatch] = useState(() => {
    const apply = (event: AppliedEvent) => {
      const out = appliedTransition(ref.current, event);
      ref.current = out.state;
      setState(out.state);
      for (const request of out.requests) {
        void sendRef.current(request).then((reply) => {
          if (reply.status.kind !== "paired") {
            onReplyRef.current(reply);
            apply({ kind: "watch", watch: null });
            return;
          }
          apply({ kind: "reply", reply });
        });
      }
    };
    return apply;
  });

  const sessionId = watch?.sessionId ?? null;
  const tabId = watch?.tabId ?? null;
  useEffect(() => {
    dispatch({ kind: "watch", watch: sessionId === null || tabId === null ? null : { sessionId, tabId } });
  }, [dispatch, sessionId, tabId]);

  const watching = state.kind === "watching";
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => dispatch({ kind: "tick" }), intervalMs);
    return () => clearInterval(timer);
  }, [dispatch, watching, intervalMs]);

  switch (state.kind) {
    case "off":
    case "watching":
    case "declined":
      return null;
    case "asking":
    case "confirming":
    case "failed": {
      const busy = state.kind === "confirming";
      return (
        <section
          aria-labelledby="applied-title"
          className="flex flex-col gap-2 rounded-control border border-border p-3"
        >
          <h2 id="applied-title" className="text-sm font-semibold">
            Did you submit this application?
          </h2>
          <p className="text-xs text-muted-foreground">
            {REASON_TEXT[state.reason]} Nothing changes in Hanapbuhay until you answer.
          </p>
          {state.kind === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => dispatch({ kind: "yes_clicked" })}
            >
              {busy ? "Marking as applied…" : state.kind === "failed" ? "Try again" : "Yes, mark applied"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => dispatch({ kind: "no_clicked" })}
            >
              No
            </button>
          </div>
        </section>
      );
    }
    case "confirmed":
      return (
        <p role="status" className="rounded-control bg-muted px-3 py-2 text-sm">
          {state.result.changed
            ? "Marked as applied in Hanapbuhay."
            : "Hanapbuhay already had this job as applied or further along."}
        </p>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
