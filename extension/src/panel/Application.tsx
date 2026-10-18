import type { FieldDescriptor, ScanNonce } from "@shared/extension";
import { useEffect, useRef, useState } from "react";
import { requestOriginAccess } from "../background/permissions";
import type { PanelReply, PanelRequest } from "../messages";
import type { AttachRequests } from "../messages-attach";
import type { AppliedWatch } from "./AppliedPrompt";
import { FileAttachments } from "./Attachments";
import { sendToWorker } from "./bridge";
import { DraftProgress } from "./DraftProgress";
import { FieldReview, LeftBlankList } from "./FieldReview";
import { SavePreference } from "./SavePreference";
import { SensitiveChecklist } from "./SensitiveChecklist";
import {
  appliedWatch,
  type ClaimState,
  type Effect,
  fillSummary,
  INITIAL_STATE,
  type PanelEvent,
  type PanelState,
  replyToEvent,
  reviewItems,
  saveCandidates,
  type TabInfo,
  transition,
  unresolvedItems,
  type Work,
} from "./state";

// The Application screen: find the session from Apply, link it to this tab, scan, review, attach
// files, Prefill, then ask whether the application went in. All rules are in state.ts (and the
// Files and applied components); this file renders state and runs the worker requests it asks for.

/** The tab the user is looking at in this window. */
export async function activeTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab?.id === undefined) return null;
  return { tabId: tab.id, url: tab.url ?? null };
}

/** Run `transition` and the requests it returns. Replies come back as events. */
function useMachine(onReply: (reply: PanelReply) => void) {
  const [state, setState] = useState<PanelState>(INITIAL_STATE);
  const ref = useRef(state);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const live = useRef(true);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  // Built once: all close over refs only, so `dispatch` and `ask` are stable for effects and children.
  const [{ dispatch, ask }] = useState(() => {
    /** Send one request; its reply reaches `onReply` and comes back to the machine as an event. */
    const ask = async (request: PanelRequest): Promise<PanelReply> => {
      const reply = await sendToWorker(request);
      if (!live.current) return reply;
      onReplyRef.current(reply);
      apply(replyToEvent({ request, reply }));
      return reply;
    };
    const send = async (request: Effect["request"]) => {
      await ask(request);
    };
    const run = ({ request, delayMs }: Effect) => {
      if (delayMs === 0) {
        void send(request);
        return;
      }
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        void send(request);
      }, delayMs);
      timers.current.add(timer);
    };
    const apply = (event: PanelEvent) => {
      const out = transition(ref.current, event);
      ref.current = out.state;
      setState(out.state);
      for (const effect of out.effects) run(effect);
    };
    return { dispatch: apply, ask };
  });

  useEffect(() => {
    live.current = true;
    const pending = timers.current;
    return () => {
      live.current = false;
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return { state, dispatch, ask, current: ref };
}

export function Application({
  onReply,
  onWatch,
}: {
  onReply: (reply: PanelReply) => void;
  /** Gets `appliedWatch(state)` whenever it changes. App.tsx shows the applied prompt above the tabs. */
  onWatch: (watch: AppliedWatch | null) => void;
}) {
  const { state, dispatch, ask, current } = useMachine(onReply);

  const watch = appliedWatch(state);
  const watchSession = watch?.sessionId ?? null;
  const watchTab = watch?.tabId ?? null;
  useEffect(() => {
    onWatch(watchSession === null || watchTab === null ? null : { sessionId: watchSession, tabId: watchTab });
  }, [onWatch, watchSession, watchTab]);

  useEffect(() => {
    let cancelled = false;
    void activeTab().then((tab) => {
      if (!cancelled) dispatch({ kind: "opened", tab });
    });
    const retab = () => {
      void activeTab().then((tab) => {
        if (!cancelled) dispatch({ kind: "tab_changed", tab });
      });
    };
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url !== undefined || change.status === "complete") retab();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      retab();
      dispatch({ kind: "refresh" });
    };
    chrome.tabs.onActivated.addListener(retab);
    chrome.tabs.onUpdated.addListener(onUpdated);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(retab);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dispatch]);

  /** Request Chrome access for `url` as the click's first await, then re-read the tab. */
  async function allowAndRetab(url: string) {
    await requestOriginAccess({ url });
    dispatch({ kind: "tab_changed", tab: await activeTab() });
  }

  async function scan() {
    const url = current.current.tab?.url;
    if (url === null || url === undefined) return;
    const access = await requestOriginAccess({ url });
    dispatch({ kind: "scan_clicked", access });
  }

  const { session } = state;
  return (
    <div className="flex flex-col gap-4">
      {state.notice !== null && <Notice text={state.notice} onDismiss={() => dispatch({ kind: "notice_dismissed" })} />}
      {(() => {
        switch (session.kind) {
          case "loading":
            return <Status text="Looking for an application…" />;
          case "none":
            return (
              <Empty
                text="Click Apply on a job in Hanapbuhay, then open its application form in this tab."
                onRetry={() => dispatch({ kind: "refresh" })}
              />
            );
          case "failed":
            return <Empty text={session.message} onRetry={() => dispatch({ kind: "refresh" })} />;
          case "available":
            return (
              <Claim
                title={session.session.title}
                company={session.session.company}
                claim={session.claim}
                onClaim={(confirmMismatch) => dispatch({ kind: "claim_clicked", confirmMismatch })}
                onAllow={() => void allowAndRetab(session.session.applyUrl)}
              />
            );
          case "claimed":
            return (
              <Claimed
                work={session.work}
                onBoundTab={state.tab?.tabId === session.work.tabId}
                dispatch={dispatch}
                onScan={() => void scan()}
                attach={ask}
              />
            );
          default: {
            const exhaustive: never = session;
            return exhaustive;
          }
        }
      })()}
    </div>
  );
}

function Status({ text }: { text: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start justify-between gap-3 rounded-control bg-muted px-3 py-2">
      <p className="text-sm">{text}</p>
      <button
        type="button"
        className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function Empty({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">{text}</p>
      <button type="button" className="btn-secondary" onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}

function JobHeading({ title, company }: { title: string; company: string }) {
  return (
    <div className="min-w-0">
      <h2 className="text-base font-semibold break-words text-balance">{title}</h2>
      <p className="text-sm text-muted-foreground break-words">{company}</p>
    </div>
  );
}

function Claim({
  title,
  company,
  claim,
  onClaim,
  onAllow,
}: {
  title: string;
  company: string;
  claim: ClaimState;
  onClaim: (confirmMismatch: boolean) => void;
  onAllow: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <JobHeading title={title} company={company} />
      {(() => {
        switch (claim.kind) {
          case "claiming":
            return <Status text="Linking this tab to the application…" />;
          case "no_url":
            return (
              <>
                <p className="text-sm text-muted-foreground">
                  The extension can't read this tab's address. Open the job's application form here, or allow access to
                  the job's site.
                </p>
                <button type="button" className="btn-secondary self-start" onClick={onAllow}>
                  Allow access to the job's site
                </button>
              </>
            );
          case "mismatch":
            return (
              <>
                <p className="text-sm">This tab isn't the job's apply page.</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">This tab</dt>
                  <dd className="break-all">{claim.details.tabUrlKey}</dd>
                  <dt className="text-muted-foreground">Apply page</dt>
                  <dd className="break-all">{claim.details.sessionUrlKey}</dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Link anyway if this is the same form, for example after a redirect to the company's job site.
                </p>
                <button type="button" className="btn-secondary self-start" onClick={() => onClaim(true)}>
                  Link this tab anyway
                </button>
              </>
            );
          case "failed":
            return (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {claim.message}
                </p>
                <button type="button" className="btn-secondary self-start" onClick={() => onClaim(false)}>
                  Try again
                </button>
              </>
            );
          default: {
            const exhaustive: never = claim;
            return exhaustive;
          }
        }
      })()}
    </div>
  );
}

/** The scan the Files list attaches into: its nonce and fields, once the form was read. */
function scannedForm(scan: Work["scan"]): { nonce: ScanNonce; fields: readonly FieldDescriptor[] } | null {
  switch (scan.kind) {
    case "idle":
    case "scanning":
      return null;
    case "matching":
      return { nonce: scan.nonce, fields: scan.fields };
    case "review":
    case "filling":
    case "filled":
      return { nonce: scan.review.nonce, fields: scan.review.fields };
    default: {
      const exhaustive: never = scan;
      return exhaustive;
    }
  }
}

function Claimed({
  work,
  onBoundTab,
  dispatch,
  onScan,
  attach,
}: {
  work: Work;
  onBoundTab: boolean;
  dispatch: (event: PanelEvent) => void;
  onScan: () => void;
  /** Runs an attach request through the machine, so an attached file starts the applied watch. */
  attach: (request: AttachRequests) => Promise<PanelReply>;
}) {
  const { scan } = work;
  return (
    <div className="flex flex-col gap-4">
      <JobHeading title={work.session.title} company={work.session.company} />
      {work.notice !== null && <Notice text={work.notice} onDismiss={() => dispatch({ kind: "notice_dismissed" })} />}
      {!onBoundTab && (
        <p className="text-sm text-muted-foreground">
          This application is linked to another tab. Switch back to it to scan or fill.
        </p>
      )}
      {(() => {
        switch (scan.kind) {
          case "idle":
            return (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  Scan reads the form's fields and finds your saved answers. Nothing is filled until you click Prefill.
                </p>
                <button type="button" className="btn-primary" disabled={!onBoundTab} onClick={onScan}>
                  Scan form
                </button>
              </div>
            );
          case "scanning":
            return <Status text="Reading the form…" />;
          case "matching":
            return <Status text={`Found ${scan.fields.length} fields. Matching your answers…`} />;
          case "review":
          case "filling":
            return <Review work={work} scan={scan} onBoundTab={onBoundTab} dispatch={dispatch} onScan={onScan} />;
          case "filled":
            return <Filled work={work} scan={scan} onBoundTab={onBoundTab} dispatch={dispatch} onScan={onScan} />;
          default: {
            const exhaustive: never = scan;
            return exhaustive;
          }
        }
      })()}
      <FileAttachments
        sessionId={work.session.id}
        tabId={work.tabId}
        scan={scannedForm(scan)}
        outputs={work.outputs.kind === "ready" ? work.outputs.outputs : []}
        onBoundTab={onBoundTab}
        send={attach}
      />
      <DraftProgress outputs={work.outputs} draft={work.draft} dispatch={dispatch} />
    </div>
  );
}

function Review({
  work,
  scan,
  onBoundTab,
  dispatch,
  onScan,
}: {
  work: Work;
  scan: Extract<Work["scan"], { kind: "review" | "filling" }>;
  onBoundTab: boolean;
  dispatch: (event: PanelEvent) => void;
  onScan: () => void;
}) {
  const filling = scan.kind === "filling";
  const items = reviewItems({ review: scan.review, confirmed: work.confirmed });
  const ready = items.filter((i) => i.status === "ready").length;
  const sensitive = items.filter((i) => i.match.needsConfirmation);

  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">No saved answers match this form's fields.</p>
      )}
      <SensitiveChecklist
        key={scan.review.nonce}
        items={sensitive}
        confirmed={work.confirmed}
        dispatch={dispatch}
        disabled={filling}
      />
      <FieldReview items={items} unresolved={unresolvedItems(scan.review)} dispatch={dispatch} disabled={filling} />
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Prefill only fills empty fields and never submits. Check the form before you send it.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={filling || ready === 0 || !onBoundTab}
            onClick={() => dispatch({ kind: "prefill_clicked" })}
          >
            {filling ? "Filling…" : `Prefill ${ready} ${ready === 1 ? "field" : "fields"}`}
          </button>
          <button type="button" className="btn-secondary h-9" disabled={filling || !onBoundTab} onClick={onScan}>
            Scan again
          </button>
        </div>
      </div>
    </div>
  );
}

function Filled({
  work,
  scan,
  onBoundTab,
  dispatch,
  onScan,
}: {
  work: Work;
  scan: Extract<Work["scan"], { kind: "filled" }>;
  onBoundTab: boolean;
  dispatch: (event: PanelEvent) => void;
  onScan: () => void;
}) {
  const summary = fillSummary(scan);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm font-medium tabular-nums">
          Filled {summary.filled} {summary.filled === 1 ? "field" : "fields"}
          {summary.skipped > 0 ? `, skipped ${summary.skipped}` : ""}.
        </p>
        <p className="text-xs text-muted-foreground">Check the form and submit it yourself.</p>
      </div>
      {summary.leftBlank.length > 0 && <LeftBlankList title="Left blank" items={summary.leftBlank} />}
      <SavePreference candidates={saveCandidates(scan)} saves={work.saves} dispatch={dispatch} />
      <button type="button" className="btn-secondary self-start" disabled={!onBoundTab} onClick={onScan}>
        Scan again
      </button>
    </div>
  );
}
