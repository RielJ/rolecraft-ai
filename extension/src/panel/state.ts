import type { OutputId, TaskDto } from "@shared/api";
import {
  type ActiveSessionResponse,
  type AdapterId,
  type ApplicationSessionDto,
  type ExtensionOutputDto,
  type FieldDescriptor,
  type FieldId,
  type FieldMatch,
  type FillEntry,
  type FillPlan,
  type FillResult,
  type FillSkipReason,
  isSalaryLabel,
  PreferenceInput,
  type PrefillCategory,
  type PrefillResponse,
  type ScanNonce,
  type TypedValue,
  type Unresolved,
  type UnresolvedReason,
  type UrlMismatchDetails,
} from "@shared/extension";
import type { OriginAccess } from "../background/permissions";
import type { PanelRefusal, PanelReply, PanelRequest } from "../messages";
import type { ApplicationCompletion, AppliedWatch } from "./AppliedPrompt";

// The Application screen as a pure state machine (docs/EXTENSION.md).
// `transition` returns the next state and the worker requests to send; the UI only renders state,
// runs those requests and feeds the replies back through `replyToEvent`. Safety rules live here,
// where panel-state.test.ts can check them:
// - the only event that yields a `fill` request is `prefill_clicked`, and its plan holds only
//   fields the user accepted (or high confidence, reviewed ones they left on);
// - sensitive matches fill only once the application's checklist confirmed them;
// - unreviewed generated answers and medium-confidence matches fill only after a per-field accept;
// - the only event that yields a `preference_save` request is `save_clicked`;
// - a scan or prefill answer for an older nonce is dropped, and a new scan starts review over;
// - the bound tab is watched for a submitted application (`appliedWatch`) only after a fill or an
//   attach on it.

export const POLL_MS = 2000;

export type TabInfo = { tabId: number; url: string | null };

/** The user's choice for one matched field. `edit` replaces a text value. */
export type Decision = { accepted: boolean; edit: string | null };

export type Review = {
  nonce: ScanNonce;
  adapter: AdapterId;
  fields: readonly FieldDescriptor[];
  matches: readonly FieldMatch[];
  unresolved: readonly Unresolved[];
  decisions: Readonly<Record<string, Decision>>;
};

export type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "matching"; nonce: ScanNonce; adapter: AdapterId; fields: readonly FieldDescriptor[] }
  | { kind: "review"; review: Review }
  | { kind: "filling"; review: Review; plan: FillPlan }
  | { kind: "filled"; review: Review; plan: FillPlan; result: FillResult };

export type PreferenceScopeKind = "global" | "opportunity";

export type SaveStatus =
  | { kind: "saving"; scope: PreferenceScopeKind }
  | { kind: "saved"; scope: PreferenceScopeKind }
  | { kind: "failed"; message: string };

export type OutputsState =
  | { kind: "loading" }
  | { kind: "ready"; outputs: readonly ExtensionOutputDto[] }
  | { kind: "failed"; message: string };

export type DraftState =
  | { kind: "idle" }
  | { kind: "starting"; outputId: OutputId }
  | { kind: "running"; outputId: OutputId; task: TaskDto }
  | { kind: "done"; outputId: OutputId }
  | { kind: "failed"; outputId: OutputId; message: string; overCap: boolean };

export type Work = {
  session: ApplicationSessionDto;
  tabId: number;
  scan: ScanState;
  /** Sensitive answers the user confirmed for this application, by `sensitiveKey`. Kept across rescans. */
  confirmed: readonly string[];
  saves: Readonly<Partial<Record<PrefillCategory, SaveStatus>>>;
  outputs: OutputsState;
  draft: DraftState;
  notice: string | null;
  /** The user filled or attached on the bound tab. Kept for this claim, so a later page can be checked. */
  acted: boolean;
};

export type ClaimState =
  | { kind: "no_url" }
  | { kind: "claiming"; tabId: number; confirmMismatch: boolean }
  | { kind: "mismatch"; details: UrlMismatchDetails }
  | { kind: "failed"; message: string };

export type SessionState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "failed"; message: string }
  | { kind: "available"; session: ApplicationSessionDto; claim: ClaimState }
  | { kind: "claimed"; work: Work };

export type PanelState = { tab: TabInfo | null; session: SessionState; notice: string | null };

export type PanelEvent =
  | { kind: "opened"; tab: TabInfo | null }
  | { kind: "refresh" }
  | { kind: "refresh_tab"; tab: TabInfo | null }
  | { kind: "tab_changed"; tab: TabInfo | null }
  | { kind: "discovered"; active: ActiveSessionResponse }
  | { kind: "discover_failed"; message: string }
  | { kind: "claim_clicked"; confirmMismatch: boolean }
  | { kind: "claimed"; session: ApplicationSessionDto }
  | { kind: "claim_mismatch"; details: UrlMismatchDetails }
  | { kind: "claim_failed"; message: string }
  | { kind: "session_ended"; message: string }
  | ({ kind: "application_completed" } & ApplicationCompletion)
  | { kind: "scan_clicked"; access: OriginAccess }
  | { kind: "scanned"; nonce: ScanNonce; adapter: AdapterId; fields: readonly FieldDescriptor[] }
  | { kind: "scan_failed"; message: string }
  | { kind: "prefilled"; response: PrefillResponse }
  | { kind: "prefill_failed"; message: string }
  | { kind: "accept_toggled"; fieldId: FieldId; accepted: boolean }
  | { kind: "edited"; fieldId: FieldId; text: string }
  | { kind: "checklist_confirmed"; keys: readonly string[] }
  | { kind: "prefill_clicked" }
  | { kind: "filled"; result: FillResult }
  | { kind: "fill_failed"; message: string }
  /** A file went into the bound tab's form (FileAttachments). */
  | { kind: "attached" }
  | {
      kind: "save_clicked";
      category: PrefillCategory;
      typedValue: TypedValue;
      displayText: string;
      scope: PreferenceScopeKind;
    }
  | { kind: "saved"; category: PrefillCategory; scope: PreferenceScopeKind }
  | { kind: "save_failed"; category: PrefillCategory; message: string }
  | { kind: "outputs_loaded"; outputs: readonly ExtensionOutputDto[] }
  | { kind: "outputs_failed"; message: string }
  | { kind: "mark_reviewed_clicked"; fieldId: FieldId }
  | { kind: "output_reviewed"; output: ExtensionOutputDto }
  /** `changed`: the server refused because the answer changed since the panel showed it (409 `output_changed`). */
  | { kind: "output_review_failed"; outputId: OutputId; message: string; changed: boolean }
  | { kind: "draft_clicked"; outputId: OutputId; confirmOverCap: boolean }
  | { kind: "draft_started"; task: TaskDto }
  | { kind: "draft_failed"; message: string; overCap: boolean }
  | { kind: "task_polled"; task: TaskDto }
  | { kind: "notice_dismissed" }
  | { kind: "connection_lost" }
  | { kind: "ignored" };

/** A worker request to send, after `delayMs` (task polling). */
export type Effect = { request: PanelRequest; delayMs: number };

export type Transition = { state: PanelState; effects: readonly Effect[] };

export const INITIAL_STATE: PanelState = { tab: null, session: { kind: "loading" }, notice: null };

const send = (request: PanelRequest, delayMs = 0): Effect => ({ request, delayMs });
const DISCOVER = send({ kind: "session_active" });

// ---------- Derived views ----------

/** The checklist identifies an answer by category and value, so a rescan with the same answer stays confirmed. */
export function sensitiveKey(match: Pick<FieldMatch, "category" | "value">): string {
  return `${match.category}:${JSON.stringify(match.value)}`;
}

export type ItemStatus = "ready" | "needs_ok" | "needs_checklist" | "off";

export type ReviewItem = {
  match: FieldMatch;
  field: FieldDescriptor | null;
  decision: Decision;
  status: ItemStatus;
};

function initialDecision(match: FieldMatch): Decision {
  return { accepted: match.confidence === "high" && !match.needsReview, edit: null };
}

function decisionFor(review: Review, match: FieldMatch): Decision {
  return review.decisions[match.fieldId] ?? initialDecision(match);
}

function itemStatus({
  match,
  decision,
  confirmed,
}: {
  match: FieldMatch;
  decision: Decision;
  confirmed: readonly string[];
}): ItemStatus {
  if (match.needsConfirmation) return confirmed.includes(sensitiveKey(match)) ? "ready" : "needs_checklist";
  if (decision.accepted && (decision.edit === null || decision.edit.trim() !== "")) return "ready";
  if (!decision.accepted && (match.confidence === "medium" || match.needsReview)) return "needs_ok";
  return "off";
}

export function reviewItems({ review, confirmed }: { review: Review; confirmed: readonly string[] }): ReviewItem[] {
  return review.matches.map((match) => {
    const decision = decisionFor(review, match);
    return {
      match,
      field: review.fields.find((f) => f.fieldId === match.fieldId) ?? null,
      decision,
      status: itemStatus({ match, decision, confirmed }),
    };
  });
}

/** The fill plan: ready items only, never a file control, never a pay question, edited text in place. */
export function buildPlan({ review, confirmed }: { review: Review; confirmed: readonly string[] }): FillPlan {
  const entries = reviewItems({ review, confirmed }).flatMap(({ match, field, decision, status }): FillEntry[] => {
    if (status !== "ready" || field === null) return [];
    if (field.control === "file" || isSalaryLabel(field.label)) return [];
    const value =
      decision.edit !== null && match.value.kind === "text"
        ? { kind: "text" as const, text: decision.edit }
        : match.value;
    return [{ fieldId: match.fieldId, value }];
  });
  return { nonce: review.nonce, entries };
}

export type LeftBlank =
  | { kind: "unresolved"; fieldId: FieldId; label: string; reason: UnresolvedReason }
  | { kind: "skipped"; fieldId: FieldId; label: string; reason: FillSkipReason }
  | { kind: "not_selected"; fieldId: FieldId; label: string };

function labelOf(review: Review, fieldId: FieldId): string {
  const label = review.fields.find((f) => f.fieldId === fieldId)?.label.trim() ?? "";
  return label === "" ? "Unlabeled field" : label;
}

/** Fields the server found no fillable answer for, with why. */
export function unresolvedItems(review: Review): LeftBlank[] {
  return review.unresolved.map(
    (u): LeftBlank => ({ kind: "unresolved", fieldId: u.fieldId, reason: u.reason, label: labelOf(review, u.fieldId) }),
  );
}

/** After a fill: the counts, and every field left blank with why. */
export function fillSummary(scan: Extract<ScanState, { kind: "filled" }>): {
  filled: number;
  skipped: number;
  leftBlank: LeftBlank[];
} {
  const { review, plan, result } = scan;
  const planned = new Set<string>(plan.entries.map((e) => e.fieldId));
  return {
    filled: result.filled.length,
    skipped: result.skipped.length,
    leftBlank: [
      ...result.skipped.map((s): LeftBlank => ({ kind: "skipped", ...s, label: labelOf(review, s.fieldId) })),
      ...review.matches
        .filter((m) => !planned.has(m.fieldId))
        .map((m): LeftBlank => ({ kind: "not_selected", fieldId: m.fieldId, label: labelOf(review, m.fieldId) })),
      ...unresolvedItems(review),
    ],
  };
}

export type SaveCandidate = { category: PrefillCategory; label: string; initialText: string | null };

/**
 * Fields worth offering "Save as default / Save for this job" for, after a fill: unresolved fields
 * with a known category (never pay or file fields), and fields whose text the user edited. One per category.
 */
export function saveCandidates(scan: Extract<ScanState, { kind: "filled" }>): SaveCandidate[] {
  const { review, result } = scan;
  const filled = new Set<string>(result.filled);
  const edited = review.matches.flatMap((m): SaveCandidate[] => {
    const edit = review.decisions[m.fieldId]?.edit ?? null;
    if (edit === null || edit.trim() === "" || edit === m.displayText || !filled.has(m.fieldId)) return [];
    return [{ category: m.category, label: labelOf(review, m.fieldId), initialText: edit.trim() }];
  });
  const unresolved = review.unresolved.flatMap((u): SaveCandidate[] =>
    u.category === null || u.reason === "salary" || u.reason === "file_field"
      ? []
      : [{ category: u.category, label: labelOf(review, u.fieldId), initialText: null }],
  );
  const byCategory = new Map<PrefillCategory, SaveCandidate>();
  for (const candidate of [...edited, ...unresolved]) {
    if (!byCategory.has(candidate.category)) byCategory.set(candidate.category, candidate);
  }
  return [...byCategory.values()];
}

/** Answer questions with no draft yet, which the panel can ask Rolecraft to draft. Never salary. */
export function unansweredQuestions(outputs: readonly ExtensionOutputDto[]): ExtensionOutputDto[] {
  return outputs.filter((o) => o.kind === "answer" && o.generatedAt === null && o.mustAnswer !== "salary");
}

// ---------- Transition ----------

function stay(state: PanelState): Transition {
  return { state, effects: [] };
}

function newWork({ session, tabId }: { session: ApplicationSessionDto; tabId: number }): Work {
  return {
    session,
    tabId,
    scan: { kind: "idle" },
    confirmed: [],
    saves: {},
    outputs: { kind: "loading" },
    draft: { kind: "idle" },
    notice: null,
    acted: false,
  };
}

/** Auto-claim needs a readable tab address; the server checks it against the session's. */
function claimFor(state: PanelState, session: ApplicationSessionDto, confirmMismatch: boolean): Transition {
  const tab = state.tab;
  if (tab === null || tab.url === null) {
    return stay({ ...state, session: { kind: "available", session, claim: { kind: "no_url" } } });
  }
  return {
    state: {
      ...state,
      session: { kind: "available", session, claim: { kind: "claiming", tabId: tab.tabId, confirmMismatch } },
    },
    effects: [
      send({ kind: "session_claim", sessionId: session.id, tabId: tab.tabId, tabUrl: tab.url, confirmMismatch }),
    ],
  };
}

/** Apply `update` to the claimed session's work. It returns new work (no requests) or a full transition. */
function onWork(state: PanelState, update: (work: Work) => Transition | Work): Transition {
  if (state.session.kind !== "claimed") return stay(state);
  const out = update(state.session.work);
  return "effects" in out ? out : stay({ ...state, session: { kind: "claimed", work: out } });
}

function withWork(state: PanelState, work: Work, effects: readonly Effect[] = []): Transition {
  return { state: { ...state, session: { kind: "claimed", work } }, effects };
}

/** Review edits apply in `review` only: once filling starts, the plan is fixed. */
function onReview(state: PanelState, update: (review: Review, work: Work) => Review): Transition {
  return onWork(state, (work) =>
    work.scan.kind === "review" ? { ...work, scan: { kind: "review", review: update(work.scan.review, work) } } : work,
  );
}

function setDecision(review: Review, fieldId: FieldId, change: (d: Decision) => Decision): Review {
  const match = review.matches.find((m) => m.fieldId === fieldId);
  if (match === undefined) return review;
  return { ...review, decisions: { ...review.decisions, [fieldId]: change(decisionFor(review, match)) } };
}

function withNotice(work: Work, notice: string): Work {
  return { ...work, notice };
}

const SCAN_BUSY: ReadonlySet<ScanState["kind"]> = new Set(["scanning", "matching", "filling"]);

function scanAccessNotice(access: Exclude<OriginAccess, { kind: "granted" }>): string {
  switch (access.kind) {
    case "denied":
      return `The extension needs access to ${access.origin} to read the form. Scan again and choose Allow.`;
    case "refused":
      return access.reason === "blocked_host"
        ? "This site's terms forbid automated tools, so the extension won't fill it."
        : "The extension only fills forms on https pages.";
    default: {
      const exhaustive: never = access;
      return exhaustive;
    }
  }
}

function tabChanged(state: PanelState, tab: TabInfo | null): Transition {
  const prev = state.tab;
  if (prev?.tabId === tab?.tabId && prev?.url === tab?.url) return stay(state);
  const next = { ...state, tab };
  const { session } = state;
  switch (session.kind) {
    case "none":
    case "failed":
    case "available":
      // Discover first: an Apply click may have replaced the job we were about to claim.
      return { state: { ...next, session: { kind: "loading" } }, effects: [DISCOVER] };
    case "claimed": {
      const { work } = session;
      // Same tab, new address: a scan or review of the old page is stale. A finished fill stays,
      // so its save prompts survive the page moving on. Another tab: the binding stays put.
      if (tab?.tabId === work.tabId && prev?.tabId === work.tabId && work.scan.kind !== "filled") {
        return {
          state: { ...next, session: { kind: "claimed", work: { ...work, scan: { kind: "idle" } } } },
          effects: [DISCOVER],
        };
      }
      return { state: next, effects: [DISCOVER] };
    }
    case "loading":
      return { state: next, effects: [DISCOVER] };
    default: {
      const exhaustive: never = session;
      return exhaustive;
    }
  }
}

/** Ask again without dropping a claimed application: a newer Apply click replaces it, the same one is kept. */
function refresh(state: PanelState): Transition {
  switch (state.session.kind) {
    case "loading":
    case "none":
    case "failed":
    case "available":
      return { state: { ...state, session: { kind: "loading" } }, effects: [DISCOVER] };
    case "claimed":
      return { state, effects: [DISCOVER] };
    default: {
      const exhaustive: never = state.session;
      return exhaustive;
    }
  }
}

export function transition(state: PanelState, event: PanelEvent): Transition {
  switch (event.kind) {
    case "opened":
      return { state: { ...INITIAL_STATE, tab: event.tab }, effects: [DISCOVER] };

    case "tab_changed":
      return tabChanged(state, event.tab);

    case "refresh":
      return refresh(state);

    case "refresh_tab": {
      const moved = tabChanged(state, event.tab);
      return moved.effects.length === 0 ? refresh(moved.state) : moved;
    }

    case "discovered": {
      const current = state.session;
      if (event.active.kind === "none") {
        // The claimed application ended on the server (completed or expired).
        return stay({ ...state, session: { kind: "none" } });
      }
      const { session } = event.active;
      if (current.kind === "claimed" && current.work.session.id === session.id) return stay(state);
      if (current.kind === "available" && current.session.id === session.id) {
        return current.claim.kind === "claiming" || current.claim.kind === "mismatch"
          ? stay(state)
          : claimFor(state, session, false);
      }
      return claimFor(state, session, false);
    }

    case "discover_failed":
      return stay({ ...state, session: { kind: "failed", message: event.message } });

    case "claim_clicked": {
      if (state.session.kind !== "available") return stay(state);
      const { claim, session } = state.session;
      // Confirming a mismatch is only possible from the mismatch prompt.
      if (event.confirmMismatch && claim.kind !== "mismatch") return stay(state);
      if (claim.kind === "claiming") return stay(state);
      return claimFor(state, session, event.confirmMismatch);
    }

    case "claimed": {
      if (state.session.kind !== "available" || state.session.claim.kind !== "claiming") return stay(state);
      if (state.session.session.id !== event.session.id) return stay(state);
      // The worker bound the tab the claim was sent for, which may no longer be the active one.
      const work = newWork({ session: event.session, tabId: state.session.claim.tabId });
      return withWork({ ...state, notice: null }, work, [send({ kind: "outputs_list", sessionId: event.session.id })]);
    }

    case "claim_mismatch":
      if (state.session.kind !== "available") return stay(state);
      return stay({ ...state, session: { ...state.session, claim: { kind: "mismatch", details: event.details } } });

    case "claim_failed":
      if (state.session.kind !== "available") return stay(state);
      return stay({ ...state, session: { ...state.session, claim: { kind: "failed", message: event.message } } });

    case "application_completed": {
      if (state.session.kind !== "claimed" || state.session.work.session.id !== event.sessionId) return stay(state);
      return {
        state: {
          ...state,
          session: { kind: "loading" },
          notice: event.result.changed
            ? "Marked as applied in Rolecraft."
            : "Rolecraft already had this job as applied or further along.",
        },
        effects: [DISCOVER],
      };
    }

    case "session_ended":
      return { state: { ...state, session: { kind: "loading" }, notice: event.message }, effects: [DISCOVER] };

    case "scan_clicked":
      return onWork(state, (work) => {
        if (SCAN_BUSY.has(work.scan.kind) || state.tab?.tabId !== work.tabId) return work;
        if (event.access.kind !== "granted") return withNotice(work, scanAccessNotice(event.access));
        return withWork(state, { ...work, scan: { kind: "scanning" }, notice: null }, [
          send({ kind: "sync_origins" }),
          send({ kind: "scan", tabId: work.tabId }),
        ]);
      });

    case "scanned":
      return onWork(state, (work) => {
        if (work.scan.kind !== "scanning") return work;
        const { nonce, adapter, fields } = event;
        return withWork(state, { ...work, scan: { kind: "matching", nonce, adapter, fields } }, [
          send({ kind: "prefill", sessionId: work.session.id, nonce, fields: [...fields] }),
        ]);
      });

    case "scan_failed":
      return onWork(state, (work) =>
        work.scan.kind === "scanning" ? { ...work, scan: { kind: "idle" }, notice: event.message } : work,
      );

    case "prefilled":
      return onWork(state, (work) => {
        const { scan } = work;
        // A prefill answer for any scan but the current one is stale.
        if (scan.kind !== "matching" || scan.nonce !== event.response.nonce) return work;
        const review: Review = {
          nonce: scan.nonce,
          adapter: scan.adapter,
          fields: scan.fields,
          matches: event.response.matches,
          unresolved: event.response.unresolved,
          decisions: Object.fromEntries(event.response.matches.map((m) => [m.fieldId, initialDecision(m)])),
        };
        return { ...work, scan: { kind: "review", review } };
      });

    case "prefill_failed":
      return onWork(state, (work) =>
        work.scan.kind === "matching" ? { ...work, scan: { kind: "idle" }, notice: event.message } : work,
      );

    case "accept_toggled":
      return onReview(state, (review) =>
        setDecision(review, event.fieldId, (d) => ({ ...d, accepted: event.accepted })),
      );

    case "edited":
      return onReview(state, (review) => {
        const match = review.matches.find((m) => m.fieldId === event.fieldId);
        if (match === undefined || match.value.kind !== "text" || match.needsConfirmation) return review;
        // Typing an answer is accepting it; clearing the box turns the field off.
        return setDecision(review, event.fieldId, () => ({ accepted: event.text.trim() !== "", edit: event.text }));
      });

    case "checklist_confirmed":
      return onWork(state, (work) => {
        if (work.scan.kind !== "review") return work;
        const shown = new Set(work.scan.review.matches.filter((m) => m.needsConfirmation).map(sensitiveKey));
        const kept = work.confirmed.filter((k) => !shown.has(k));
        return { ...work, confirmed: [...kept, ...event.keys.filter((k) => shown.has(k))] };
      });

    case "prefill_clicked":
      return onWork(state, (work) => {
        if (work.scan.kind !== "review" || state.tab?.tabId !== work.tabId) return work;
        const plan = buildPlan({ review: work.scan.review, confirmed: work.confirmed });
        if (plan.entries.length === 0) return withNotice(work, "Nothing is selected to fill.");
        return withWork(state, { ...work, scan: { kind: "filling", review: work.scan.review, plan }, notice: null }, [
          send({ kind: "fill", tabId: work.tabId, plan }),
        ]);
      });

    case "filled":
      return onWork(state, (work) => {
        const { scan } = work;
        if (scan.kind !== "filling" || scan.plan.nonce !== event.result.nonce) return work;
        return {
          ...work,
          scan: { kind: "filled", review: scan.review, plan: scan.plan, result: event.result },
          acted: true,
        };
      });

    case "attached":
      return onWork(state, (work) => ({ ...work, acted: true }));

    case "fill_failed":
      return onWork(state, (work) =>
        work.scan.kind === "filling"
          ? { ...work, scan: { kind: "review", review: work.scan.review }, notice: event.message }
          : work,
      );

    case "save_clicked":
      return onWork(state, (work) => {
        if (work.saves[event.category]?.kind === "saving") return work;
        const parsed = PreferenceInput.safeParse({
          category: event.category,
          typedValue: event.typedValue,
          displayText: event.displayText,
          scope:
            event.scope === "global"
              ? { kind: "global" }
              : { kind: "opportunity", opportunityId: work.session.opportunityId },
        });
        if (!parsed.success) {
          const message = parsed.error.issues[0]?.message ?? "That answer can't be saved.";
          return { ...work, saves: { ...work.saves, [event.category]: { kind: "failed", message } } };
        }
        return withWork(
          state,
          { ...work, saves: { ...work.saves, [event.category]: { kind: "saving", scope: event.scope } } },
          [send({ kind: "preference_save", input: parsed.data })],
        );
      });

    case "saved":
      return onWork(state, (work) => ({
        ...work,
        saves: { ...work.saves, [event.category]: { kind: "saved", scope: event.scope } },
      }));

    case "save_failed":
      return onWork(state, (work) => ({
        ...work,
        saves: { ...work.saves, [event.category]: { kind: "failed", message: event.message } },
      }));

    case "outputs_loaded":
      return onWork(state, (work) => ({ ...work, outputs: { kind: "ready", outputs: event.outputs } }));

    case "outputs_failed":
      return onWork(state, (work) => ({ ...work, outputs: { kind: "failed", message: event.message } }));

    case "mark_reviewed_clicked":
      return onWork(state, (work) => {
        if (work.scan.kind !== "review") return work;
        const match = work.scan.review.matches.find((m) => m.fieldId === event.fieldId);
        // Only a text value shows the answer itself; an option shows its label, which is not the body.
        if (match === undefined || match.provenance.kind !== "generated" || match.value.kind !== "text") return work;
        // Marking the shown answer reviewed is an explicit accept of this field.
        const review = setDecision(work.scan.review, event.fieldId, (d) => ({ ...d, accepted: true }));
        return withWork(state, { ...work, scan: { kind: "review", review } }, [
          send({
            kind: "output_reviewed",
            sessionId: work.session.id,
            outputId: match.provenance.outputId,
            body: match.value.text,
          }),
        ]);
      });

    case "output_reviewed":
      return onWork(state, (work) => {
        const outputs =
          work.outputs.kind === "ready"
            ? {
                ...work.outputs,
                outputs: work.outputs.outputs.map((o) => (o.id === event.output.id ? event.output : o)),
              }
            : work.outputs;
        const unflag = (review: Review): Review => ({
          ...review,
          matches: review.matches.map((m) =>
            m.provenance.kind === "generated" && m.provenance.outputId === event.output.id
              ? { ...m, needsReview: false }
              : m,
          ),
        });
        const scan =
          work.scan.kind === "review" ? { kind: "review" as const, review: unflag(work.scan.review) } : work.scan;
        return { ...work, outputs, scan };
      });

    case "output_review_failed":
      return onWork(state, (work) => {
        if (!event.changed) return withNotice(work, event.message);
        // The answer was edited or redrafted since this scan: the text shown is not the one stored.
        // Un-tick its fields so the old text is not filled, and reload the materials.
        const untick = (review: Review): Review =>
          review.matches.reduce(
            (r, m) =>
              m.provenance.kind === "generated" && m.provenance.outputId === event.outputId
                ? setDecision(r, m.fieldId, (d) => ({ ...d, accepted: false }))
                : r,
            review,
          );
        const scan =
          work.scan.kind === "review" ? { kind: "review" as const, review: untick(work.scan.review) } : work.scan;
        return withWork(state, withNotice({ ...work, scan }, event.message), [
          send({ kind: "outputs_list", sessionId: work.session.id }),
        ]);
      });

    case "draft_clicked":
      return onWork(state, (work) => {
        if (work.draft.kind === "starting" || work.draft.kind === "running") return work;
        if (event.confirmOverCap && !(work.draft.kind === "failed" && work.draft.overCap)) return work;
        return withWork(state, { ...work, draft: { kind: "starting", outputId: event.outputId } }, [
          send({
            kind: "draft_start",
            sessionId: work.session.id,
            outputId: event.outputId,
            confirmOverCap: event.confirmOverCap,
          }),
        ]);
      });

    case "draft_started":
      return onWork(state, (work) => {
        if (work.draft.kind !== "starting") return work;
        return taskUpdate(state, {
          ...work,
          draft: { kind: "running", outputId: work.draft.outputId, task: event.task },
        });
      });

    case "task_polled":
      return onWork(state, (work) => {
        if (work.draft.kind !== "running" || work.draft.task.id !== event.task.id) return work;
        return taskUpdate(state, { ...work, draft: { ...work.draft, task: event.task } });
      });

    case "draft_failed":
      return onWork(state, (work) => {
        if (work.draft.kind !== "starting" && work.draft.kind !== "running") return work;
        const { outputId } = work.draft;
        return { ...work, draft: { kind: "failed", outputId, message: event.message, overCap: event.overCap } };
      });

    case "notice_dismissed":
      if (state.session.kind === "claimed")
        return withWork({ ...state, notice: null }, { ...state.session.work, notice: null });
      return stay({ ...state, notice: null });

    case "connection_lost":
      return stay({ ...INITIAL_STATE, tab: state.tab });

    case "ignored":
      return stay(state);

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Keep polling a running draft; refresh the outputs when it ends. */
function taskUpdate(state: PanelState, work: Work): Transition {
  if (work.draft.kind !== "running") return withWork(state, work);
  const { task, outputId } = work.draft;
  switch (task.status) {
    case "running":
      return withWork(state, work, [send({ kind: "task_poll", taskId: task.id }, POLL_MS)]);
    case "done":
      return withWork(
        state,
        {
          ...work,
          draft: { kind: "done", outputId },
          notice: "Answer drafted. Scan again to use it; it fills only after you OK it.",
        },
        [send({ kind: "outputs_list", sessionId: work.session.id })],
      );
    case "failed":
    case "interrupted":
      return withWork(state, {
        ...work,
        draft: {
          kind: "failed",
          outputId,
          message: task.error ?? "The draft stopped before it finished.",
          overCap: false,
        },
      });
    default: {
      const exhaustive: never = task.status;
      return exhaustive;
    }
  }
}

// ---------- Replies to events ----------

export function refusalMessage(reason: PanelRefusal): string {
  switch (reason) {
    case "not_active":
      return "Switch to the job's tab, then try again.";
    case "unsupported_url":
      return "The extension can't work on this page. Open the job's application form.";
    case "blocked_host":
      return "This site's terms forbid automated tools, so the extension won't fill it.";
    case "permission_denied":
      return "Chrome didn't let the extension read this page. Scan again and allow access.";
    case "not_bound":
      return "This tab is no longer linked to the application.";
    case "bad_reply":
      return "The page didn't answer as expected. Reload it and scan again.";
    case "tab_changed":
      return "The tab changed while linking. Try again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

const SESSION_GONE = "This application session ended. Click Apply in Rolecraft to start again.";

/**
 * What a worker reply means for the screen. Anything but `paired` is `connection_lost`: the App
 * shows the pairing screen and nothing here runs. A session that ended on the server, or a lost
 * binding, goes back to discovery.
 */
export function replyToEvent({ request, reply }: { request: PanelRequest; reply: PanelReply }): PanelEvent {
  if (reply.status.kind !== "paired") return { kind: "connection_lost" };
  const result = reply.result;
  if (result?.kind === "failed" && result.code === "session_expired") {
    return { kind: "session_ended", message: SESSION_GONE };
  }
  if (result?.kind === "refused" && result.reason === "not_bound" && request.kind !== "preference_save") {
    return { kind: "session_ended", message: "This tab lost its link to the application. Linking it again." };
  }
  const failure =
    result === undefined
      ? (reply.error ?? "The extension's background worker did not answer.")
      : result.kind === "failed"
        ? result.message
        : result.kind === "refused"
          ? refusalMessage(result.reason)
          : null;

  switch (request.kind) {
    case "session_active":
      return result?.kind === "session_active"
        ? { kind: "discovered", active: result.active }
        : { kind: "discover_failed", message: failure ?? "Unexpected answer." };
    case "session_claim":
      if (result?.kind === "claimed") return { kind: "claimed", session: result.session };
      if (result?.kind === "claim_mismatch") return { kind: "claim_mismatch", details: result.details };
      return { kind: "claim_failed", message: failure ?? "Unexpected answer." };
    case "scan":
      return result?.kind === "scanned"
        ? { kind: "scanned", nonce: result.nonce, adapter: result.adapter, fields: result.fields }
        : { kind: "scan_failed", message: failure ?? "Unexpected answer." };
    case "prefill":
      return result?.kind === "prefilled"
        ? { kind: "prefilled", response: result.response }
        : { kind: "prefill_failed", message: failure ?? "Unexpected answer." };
    case "fill":
      return result?.kind === "filled"
        ? { kind: "filled", result: result.result }
        : { kind: "fill_failed", message: failure ?? "Unexpected answer." };
    case "preference_save":
      return result?.kind === "preference"
        ? { kind: "saved", category: result.preference.category, scope: result.preference.scope.kind }
        : { kind: "save_failed", category: request.input.category, message: failure ?? "Unexpected answer." };
    case "outputs_list":
      return result?.kind === "outputs"
        ? { kind: "outputs_loaded", outputs: result.outputs }
        : { kind: "outputs_failed", message: failure ?? "Unexpected answer." };
    case "output_reviewed":
      return result?.kind === "output"
        ? { kind: "output_reviewed", output: result.output }
        : {
            kind: "output_review_failed",
            outputId: request.outputId,
            message: failure ?? "Unexpected answer.",
            changed: result?.kind === "failed" && result.code === "output_changed",
          };
    case "draft_start":
      return result?.kind === "task"
        ? { kind: "draft_started", task: result.task }
        : {
            kind: "draft_failed",
            message: failure ?? "Unexpected answer.",
            overCap: result?.kind === "failed" && result.code === "over_cap",
          };
    case "task_poll":
      return result?.kind === "task"
        ? { kind: "task_polled", task: result.task }
        : { kind: "draft_failed", message: failure ?? "Unexpected answer.", overCap: false };
    case "status":
    case "pair":
    case "disconnect":
    case "sync_origins":
    case "revoke_origin":
    // Sent by FileAttachments: only a file that went in counts as acting on the tab.
    case "attach":
      return result?.kind === "attach_done" ? { kind: "attached" } : { kind: "ignored" };
    case "confirm_applied":
      return result?.kind === "applied"
        ? { kind: "application_completed", sessionId: request.sessionId, result: result.result }
        : { kind: "ignored" };
    // Sent by FileAttachments, ImportJobPanel, AppliedPromptPanel and Diagnostics, never by this machine.
    case "questions_lookup":
    case "question_create":
    case "answer_reference_save":
    case "answer_read":
    case "diagnostics_list":
    case "diagnostics_clear":
    case "attach_download":
    case "job_extract":
    case "job_lookup":
    case "job_import":
    case "success_check":
      return { kind: "ignored" };
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/**
 * What AppliedPromptPanel watches: the claimed session and its bound tab, once the user filled or
 * attached there. Null otherwise, so nothing is checked before the user acted.
 */
export function appliedWatch(state: PanelState): AppliedWatch | null {
  if (state.session.kind !== "claimed" || !state.session.work.acted) return null;
  const { work } = state.session;
  return { sessionId: work.session.id, tabId: work.tabId };
}
