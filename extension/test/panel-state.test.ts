import { describe, expect, test } from "bun:test";
import { OutputId, TaskDto } from "@shared/api";
import {
  ApplicationSessionDto,
  FieldDescriptor,
  FieldId,
  type FieldMatch,
  PairingId,
  type PrefillResponse,
  ScanNonce,
} from "@shared/extension";
import type { PanelReply, PanelRequest } from "../src/messages";
import {
  appliedWatch,
  buildPlan,
  type Effect,
  fillSummary,
  INITIAL_STATE,
  type PanelEvent,
  type PanelState,
  replyToEvent,
  saveCandidates,
  sensitiveKey,
  transition,
} from "../src/panel/state";

const SESSION_ID = "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b";
const OPPORTUNITY_ID = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
const OUTPUT_ID = OutputId.parse("8b7c6d5e-4f3a-4b2c-8d9e-0f1a2b3c4d5e");
const APPLY_URL = "https://boards.example/jobs/1";
const NONCE = ScanNonce.parse("scan-nonce-0000000001");
const OTHER_NONCE = ScanNonce.parse("scan-nonce-0000000002");
const NOW = "2026-10-18T03:00:00.000Z";
const TAB = { tabId: 7, url: APPLY_URL };

const SESSION = ApplicationSessionDto.parse({
  id: SESSION_ID,
  opportunityId: OPPORTUNITY_ID,
  status: "pending",
  applyUrl: APPLY_URL,
  applyUrlKey: "boards.example/jobs/1",
  title: "Engineer",
  company: "Acme",
  createdAt: NOW,
  expiresAt: NOW,
  claimedAt: null,
});

const id = (s: string) => FieldId.parse(s);

function field(fieldId: string, label: string, control: FieldDescriptor["control"] = "text"): FieldDescriptor {
  return FieldDescriptor.parse({
    fieldId,
    control,
    label,
    autocomplete: null,
    name: null,
    required: false,
    options: [],
    adapterCategory: null,
  });
}

const FIELDS = [
  field("email", "Email"),
  field("phone", "Phone"),
  field("why", "Why this company?", "textarea"),
  field("auth", "Are you authorized to work?", "radio"),
  field("gender", "Gender", "select"),
  field("notice", "Notice period"),
  field("custom", "Favourite tool?"),
];

const EMAIL: FieldMatch = {
  fieldId: id("email"),
  category: "email",
  confidence: "high",
  provenance: { kind: "profile" },
  value: { kind: "text", text: "ada@example.com" },
  displayText: "ada@example.com",
  needsReview: false,
  needsConfirmation: false,
};
const PHONE_MEDIUM: FieldMatch = {
  ...EMAIL,
  fieldId: id("phone"),
  category: "phone",
  confidence: "medium",
  value: { kind: "text", text: "+63 900" },
  displayText: "+63 900",
};
const GENERATED: FieldMatch = {
  ...EMAIL,
  fieldId: id("why"),
  category: "references",
  provenance: { kind: "generated", outputId: OUTPUT_ID },
  value: { kind: "text", text: "Because." },
  displayText: "Because.",
  needsReview: true,
};
const AUTH: FieldMatch = {
  ...EMAIL,
  fieldId: id("auth"),
  category: "work_authorization",
  value: { kind: "option", value: "yes" },
  displayText: "Yes",
  needsConfirmation: true,
};
const GENDER: FieldMatch = {
  ...EMAIL,
  fieldId: id("gender"),
  category: "gender",
  value: { kind: "option", value: "decline" },
  displayText: "I don't wish to answer",
  needsConfirmation: true,
};

const RESPONSE: PrefillResponse = {
  nonce: NONCE,
  matches: [EMAIL, PHONE_MEDIUM, GENERATED, AUTH, GENDER],
  unresolved: [
    { fieldId: id("notice"), reason: "no_value", category: "notice_period" },
    { fieldId: id("custom"), reason: "unknown_label", category: null },
  ],
};

/** Run events from `start`, collecting every request they produce. */
function run(events: readonly PanelEvent[], start: PanelState = INITIAL_STATE) {
  let state = start;
  const effects: Effect[] = [];
  for (const event of events) {
    const out = transition(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects, kinds: effects.map((e) => e.request.kind) };
}

const GRANTED = { kind: "granted", origin: "https://boards.example" } as const;

/** Opened, discovered, auto-claimed, scanned and matched: the review screen. */
const TO_REVIEW: readonly PanelEvent[] = [
  { kind: "opened", tab: TAB },
  { kind: "discovered", active: { kind: "active", session: SESSION } },
  { kind: "claimed", session: SESSION },
  { kind: "scan_clicked", access: GRANTED },
  { kind: "scanned", nonce: NONCE, adapter: "generic", fields: FIELDS },
  { kind: "prefilled", response: RESPONSE },
];

function work(state: PanelState) {
  if (state.session.kind !== "claimed") throw new Error(`not claimed: ${state.session.kind}`);
  return state.session.work;
}

function plannedIds(effects: readonly Effect[]): string[] {
  const fill = effects.find((e) => e.request.kind === "fill")?.request;
  if (fill?.kind !== "fill") throw new Error("no fill request");
  return fill.plan.entries.map((e) => e.fieldId);
}

describe("panel state: session discovery and claim", () => {
  test("opening asks for the active session, then claims it for this tab", () => {
    const { state, effects } = run([
      { kind: "opened", tab: TAB },
      { kind: "discovered", active: { kind: "active", session: SESSION } },
    ]);
    expect(effects.map((e) => e.request)).toEqual([
      { kind: "session_active" },
      { kind: "session_claim", sessionId: SESSION.id, tabId: 7, tabUrl: APPLY_URL, confirmMismatch: false },
    ]);
    expect(state.session).toMatchObject({ kind: "available", claim: { kind: "claiming" } });
  });

  test("a URL mismatch waits for an explicit confirm", () => {
    const details = { sessionUrlKey: "boards.example/jobs/1", tabUrlKey: "other.example/x" };
    const mismatched = run([
      { kind: "opened", tab: TAB },
      { kind: "discovered", active: { kind: "active", session: SESSION } },
      { kind: "claim_mismatch", details },
    ]);
    expect(mismatched.state.session).toMatchObject({ kind: "available", claim: { kind: "mismatch", details } });
    const confirmed = transition(mismatched.state, { kind: "claim_clicked", confirmMismatch: true });
    expect(confirmed.effects.map((e) => e.request)).toEqual([
      { kind: "session_claim", sessionId: SESSION.id, tabId: 7, tabUrl: APPLY_URL, confirmMismatch: true },
    ]);
  });

  test("confirmMismatch is never sent without a mismatch prompt", () => {
    const { state } = run([
      { kind: "opened", tab: TAB },
      { kind: "discovered", active: { kind: "active", session: SESSION } },
      { kind: "claim_failed", message: "nope" },
    ]);
    expect(transition(state, { kind: "claim_clicked", confirmMismatch: true }).effects).toEqual([]);
  });

  test("an unreadable tab address claims nothing", () => {
    const { state, kinds } = run([
      { kind: "opened", tab: { tabId: 7, url: null } },
      { kind: "discovered", active: { kind: "active", session: SESSION } },
    ]);
    expect(kinds).toEqual(["session_active"]);
    expect(state.session).toMatchObject({ kind: "available", claim: { kind: "no_url" } });
  });

  test("checking again keeps a claimed application and its review", () => {
    const reviewed = run(TO_REVIEW);
    const again = run(
      [{ kind: "refresh" }, { kind: "discovered", active: { kind: "active", session: SESSION } }],
      reviewed.state,
    );
    expect(again.kinds).toEqual(["session_active"]);
    expect(work(again.state).scan.kind).toBe("review");
  });

  test("a claim loads the job's outputs", () => {
    const { kinds } = run(TO_REVIEW.slice(0, 3));
    expect(kinds).toEqual(["session_active", "session_claim", "outputs_list"]);
  });
});

describe("panel state: safety rules", () => {
  test("nothing fills before Prefill", () => {
    const { state, kinds } = run([
      ...TO_REVIEW,
      { kind: "accept_toggled", fieldId: id("phone"), accepted: true },
      { kind: "accept_toggled", fieldId: id("why"), accepted: true },
      { kind: "edited", fieldId: id("email"), text: "ada@work.example" },
      { kind: "checklist_confirmed", keys: [sensitiveKey(AUTH), sensitiveKey(GENDER)] },
    ]);
    expect(kinds).not.toContain("fill");
    const clicked = transition(state, { kind: "prefill_clicked" });
    expect(clicked.effects.map((e) => e.request.kind)).toEqual(["fill"]);
  });

  test("by default only high-confidence, reviewed, non-sensitive matches fill", () => {
    const { state } = run(TO_REVIEW);
    expect(plannedIds(transition(state, { kind: "prefill_clicked" }).effects)).toEqual(["email"]);
  });

  test("sensitive answers stay blocked until the checklist confirms them", () => {
    const before = run(TO_REVIEW);
    // Accepting a sensitive field directly does not get it past the checklist.
    const accepted = run([{ kind: "accept_toggled", fieldId: id("auth"), accepted: true }], before.state);
    expect(plannedIds(transition(accepted.state, { kind: "prefill_clicked" }).effects)).not.toContain("auth");

    const confirmed = run([{ kind: "checklist_confirmed", keys: [sensitiveKey(AUTH)] }], before.state);
    expect(plannedIds(transition(confirmed.state, { kind: "prefill_clicked" }).effects)).toEqual(["email", "auth"]);
  });

  test("the checklist is per application: a rescan with the same answers stays confirmed", () => {
    const confirmed = run([...TO_REVIEW, { kind: "checklist_confirmed", keys: [sensitiveKey(GENDER)] }]);
    const rescanned = run(
      [
        { kind: "scan_clicked", access: GRANTED },
        { kind: "scanned", nonce: OTHER_NONCE, adapter: "generic", fields: FIELDS },
        { kind: "prefilled", response: { ...RESPONSE, nonce: OTHER_NONCE } },
      ],
      confirmed.state,
    );
    expect(plannedIds(transition(rescanned.state, { kind: "prefill_clicked" }).effects)).toEqual(["email", "gender"]);
  });

  test("a changed sensitive answer needs confirming again", () => {
    const confirmed = run([...TO_REVIEW, { kind: "checklist_confirmed", keys: [sensitiveKey(GENDER)] }]);
    const changed: FieldMatch = { ...GENDER, value: { kind: "option", value: "female" }, displayText: "Female" };
    const rescanned = run(
      [
        { kind: "scan_clicked", access: GRANTED },
        { kind: "scanned", nonce: OTHER_NONCE, adapter: "generic", fields: FIELDS },
        { kind: "prefilled", response: { ...RESPONSE, nonce: OTHER_NONCE, matches: [EMAIL, changed] } },
      ],
      confirmed.state,
    );
    expect(plannedIds(transition(rescanned.state, { kind: "prefill_clicked" }).effects)).toEqual(["email"]);
  });

  test("an unreviewed generated answer and a medium match fill only after a per-field accept", () => {
    const { state } = run(TO_REVIEW);
    expect(plannedIds(transition(state, { kind: "prefill_clicked" }).effects)).not.toContain("why");
    const accepted = run(
      [
        { kind: "accept_toggled", fieldId: id("why"), accepted: true },
        { kind: "accept_toggled", fieldId: id("phone"), accepted: true },
      ],
      state,
    );
    expect(plannedIds(transition(accepted.state, { kind: "prefill_clicked" }).effects)).toEqual([
      "email",
      "phone",
      "why",
    ]);
  });

  test("Mark reviewed sends the text shown; if it changed on the server, it says so, un-ticks it and reloads", () => {
    const clicked = run([...TO_REVIEW, { kind: "mark_reviewed_clicked", fieldId: id("why") }]);
    const request = clicked.effects.at(-1)?.request;
    expect(request).toEqual({ kind: "output_reviewed", sessionId: SESSION.id, outputId: OUTPUT_ID, body: "Because." });
    if (request === undefined) throw new Error("no request");

    const message = "This text changed since you opened it. Read the new version, then mark it reviewed.";
    const reply: PanelReply = {
      status: { kind: "paired", endpoint: "http://localhost:3000", pairingId: PairingId.parse(SESSION_ID) },
      error: null,
      result: { kind: "failed", code: "output_changed", message },
    };
    const changed = transition(clicked.state, replyToEvent({ request, reply }));
    expect(changed.effects.map((e) => e.request)).toEqual([{ kind: "outputs_list", sessionId: SESSION.id }]);
    expect(work(changed.state).notice).toBe(message);
    // The old text is not filled: the field needs a fresh look first.
    expect(plannedIds(transition(changed.state, { kind: "prefill_clicked" }).effects)).not.toContain("why");
    const match = reviewOf(changed.state).matches.find((m) => m.fieldId === id("why"));
    expect(match?.needsReview).toBe(true);
  });

  test("Mark reviewed is not offered for a generated answer shown as an option", () => {
    const asOption: FieldMatch = { ...GENERATED, value: { kind: "option", value: "b" }, displayText: "Because" };
    const { effects } = run([
      ...TO_REVIEW.slice(0, 5),
      { kind: "prefilled", response: { ...RESPONSE, matches: [EMAIL, asOption] } },
      { kind: "mark_reviewed_clicked", fieldId: id("why") },
    ]);
    expect(effects.map((e) => e.request.kind)).not.toContain("output_reviewed");
  });

  test("an edited answer fills with the edited text; clearing it turns the field off", () => {
    const edited = run([...TO_REVIEW, { kind: "edited", fieldId: id("phone"), text: "+63 911" }]);
    const plan = buildPlan({ review: reviewOf(edited.state), confirmed: [] });
    expect(plan.entries).toContainEqual({ fieldId: id("phone"), value: { kind: "text", text: "+63 911" } });
    const cleared = run([{ kind: "edited", fieldId: id("phone"), text: "  " }], edited.state);
    expect(buildPlan({ review: reviewOf(cleared.state), confirmed: [] }).entries.map((e) => String(e.fieldId))).toEqual(
      ["email"],
    );
  });

  test("sensitive answers cannot be edited around the checklist", () => {
    const { state } = run([...TO_REVIEW, { kind: "edited", fieldId: id("gender"), text: "x" }]);
    expect(buildPlan({ review: reviewOf(state), confirmed: [] }).entries.map((e) => String(e.fieldId))).toEqual([
      "email",
    ]);
  });

  test("the plan never holds a pay question or a file control, even if the server matched one", () => {
    const pay = field("pay", "Expected monthly rate");
    const file = field("cv", "Resume", "file");
    const matches: FieldMatch[] = [
      { ...EMAIL, fieldId: id("pay") },
      { ...EMAIL, fieldId: id("cv") },
    ];
    const { state } = run([
      ...TO_REVIEW.slice(0, 4),
      { kind: "scanned", nonce: NONCE, adapter: "generic", fields: [pay, file] },
      { kind: "prefilled", response: { nonce: NONCE, matches, unresolved: [] } },
    ]);
    expect(buildPlan({ review: reviewOf(state), confirmed: [] }).entries).toEqual([]);
    expect(transition(state, { kind: "prefill_clicked" }).effects).toEqual([]);
  });

  test("saving is never automatic", () => {
    const result = { nonce: NONCE, filled: [id("email"), id("phone")], skipped: [] };
    const { state, kinds } = run([
      ...TO_REVIEW,
      { kind: "edited", fieldId: id("phone"), text: "+63 911" },
      { kind: "prefill_clicked" },
      { kind: "filled", result },
    ]);
    expect(kinds).not.toContain("preference_save");
    const scan = work(state).scan;
    if (scan.kind !== "filled") throw new Error("not filled");
    expect(saveCandidates(scan).map((c) => c.category)).toEqual(["phone", "notice_period"]);

    const saved = transition(state, {
      kind: "save_clicked",
      category: "notice_period",
      typedValue: { valueType: "text", value: "Two weeks" },
      displayText: "Two weeks",
      scope: "opportunity",
    });
    expect(saved.effects.map((e) => e.request)).toEqual([
      {
        kind: "preference_save",
        input: {
          category: "notice_period",
          typedValue: { valueType: "text", value: "Two weeks" },
          displayText: "Two weeks",
          scope: { kind: "opportunity", opportunityId: SESSION.opportunityId },
        },
      },
    ]);
  });

  test("a save that doesn't fit its category is refused locally", () => {
    const { state } = run(TO_REVIEW);
    const out = transition(state, {
      kind: "save_clicked",
      category: "gender",
      typedValue: { valueType: "text", value: "x" },
      displayText: "x",
      scope: "global",
    });
    expect(out.effects).toEqual([]);
    expect(work(out.state).saves.gender).toMatchObject({ kind: "failed" });
  });
});

describe("panel state: stale scans", () => {
  test("a prefill answer for another nonce is dropped", () => {
    const { state } = run([
      ...TO_REVIEW.slice(0, 5),
      { kind: "prefilled", response: { ...RESPONSE, nonce: OTHER_NONCE } },
    ]);
    expect(work(state).scan.kind).toBe("matching");
  });

  test("a new scan resets the review and its accepts", () => {
    const accepted = run([...TO_REVIEW, { kind: "accept_toggled", fieldId: id("phone"), accepted: true }]);
    const rescanned = run(
      [
        { kind: "scan_clicked", access: GRANTED },
        { kind: "scanned", nonce: OTHER_NONCE, adapter: "generic", fields: FIELDS },
      ],
      accepted.state,
    );
    expect(work(rescanned.state).scan.kind).toBe("matching");
    expect(transition(rescanned.state, { kind: "prefill_clicked" }).effects).toEqual([]);
    const reviewed = run([{ kind: "prefilled", response: { ...RESPONSE, nonce: OTHER_NONCE } }], rescanned.state);
    expect(plannedIds(transition(reviewed.state, { kind: "prefill_clicked" }).effects)).toEqual(["email"]);
  });

  test("the tab navigating drops the review", () => {
    const { state } = run([...TO_REVIEW, { kind: "tab_changed", tab: { tabId: 7, url: `${APPLY_URL}/step-2` } }]);
    expect(work(state).scan.kind).toBe("idle");
  });

  test("a fill result for another nonce is dropped", () => {
    const { state } = run([
      ...TO_REVIEW,
      { kind: "prefill_clicked" },
      { kind: "filled", result: { nonce: OTHER_NONCE, filled: [id("email")], skipped: [] } },
    ]);
    expect(work(state).scan.kind).toBe("filling");
  });

  test("scanning another tab than the bound one does nothing", () => {
    const { state } = run(TO_REVIEW.slice(0, 3));
    const moved = run([{ kind: "tab_changed", tab: { tabId: 8, url: "https://other.example/" } }], state);
    expect(transition(moved.state, { kind: "scan_clicked", access: GRANTED }).effects).toEqual([]);
  });

  test("a denied origin scans nothing", () => {
    const { state } = run(TO_REVIEW.slice(0, 3));
    const out = transition(state, {
      kind: "scan_clicked",
      access: { kind: "denied", origin: "https://boards.example" },
    });
    expect(out.effects).toEqual([]);
    expect(work(out.state).notice).toContain("Allow");
  });
});

describe("panel state: results and drafts", () => {
  test("the summary counts filled and skipped and lists every blank field", () => {
    const { state } = run([
      ...TO_REVIEW,
      { kind: "prefill_clicked" },
      {
        kind: "filled",
        result: { nonce: NONCE, filled: [], skipped: [{ fieldId: id("email"), reason: "not_empty" }] },
      },
    ]);
    const scan = work(state).scan;
    if (scan.kind !== "filled") throw new Error("not filled");
    const summary = fillSummary(scan);
    expect(summary.filled).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.leftBlank.map((b) => [b.kind, String(b.fieldId)])).toEqual([
      ["skipped", "email"],
      ["not_selected", "phone"],
      ["not_selected", "why"],
      ["not_selected", "auth"],
      ["not_selected", "gender"],
      ["unresolved", "notice"],
      ["unresolved", "custom"],
    ]);
  });

  test("a draft polls until done, then reloads the outputs", () => {
    const task = TaskDto.parse({
      id: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
      kind: "draft",
      status: "running",
      step: "Drafting",
      error: null,
      createdAt: NOW,
      finishedAt: null,
    });
    const { state, effects } = run([
      ...TO_REVIEW.slice(0, 3),
      { kind: "draft_clicked", outputId: OUTPUT_ID, confirmOverCap: false },
      { kind: "draft_started", task },
      { kind: "task_polled", task },
      { kind: "task_polled", task: { ...task, status: "done", finishedAt: NOW } },
    ]);
    expect(effects.slice(3).map((e) => [e.request.kind, e.delayMs])).toEqual([
      ["draft_start", 0],
      ["task_poll", 2000],
      ["task_poll", 2000],
      ["outputs_list", 0],
    ]);
    expect(work(state).draft.kind).toBe("done");
  });

  test("over the cap needs an explicit second click", () => {
    const start = run([...TO_REVIEW.slice(0, 3)]);
    expect(
      transition(start.state, { kind: "draft_clicked", outputId: OUTPUT_ID, confirmOverCap: true }).effects,
    ).toEqual([]);
    const over = run(
      [
        { kind: "draft_clicked", outputId: OUTPUT_ID, confirmOverCap: false },
        { kind: "draft_failed", message: "Over your monthly cap.", overCap: true },
        { kind: "draft_clicked", outputId: OUTPUT_ID, confirmOverCap: true },
      ],
      start.state,
    );
    expect(over.effects.at(-1)?.request).toMatchObject({ kind: "draft_start", confirmOverCap: true });
  });
});

describe("replyToEvent", () => {
  const paired: PanelReply["status"] = {
    kind: "paired",
    endpoint: "http://localhost:3000",
    pairingId: PairingId.parse(SESSION_ID),
  };
  const scan: PanelRequest = { kind: "scan", tabId: 7 };

  test("anything but paired is a lost connection", () => {
    const reply: PanelReply = { status: { kind: "unreachable", endpoint: "http://localhost:3000" }, error: null };
    expect(replyToEvent({ request: scan, reply })).toEqual({ kind: "connection_lost" });
  });

  test("an expired session goes back to discovery", () => {
    const reply: PanelReply = {
      status: paired,
      error: "ended",
      result: { kind: "failed", code: "session_expired", message: "ended" },
    };
    expect(replyToEvent({ request: scan, reply }).kind).toBe("session_ended");
  });

  test("a refusal becomes a readable failure", () => {
    const reply: PanelReply = { status: paired, error: null, result: { kind: "refused", reason: "blocked_host" } };
    expect(replyToEvent({ request: scan, reply })).toEqual({
      kind: "scan_failed",
      message: expect.stringContaining("terms"),
    });
  });
});

function reviewOf(state: PanelState) {
  const scan = work(state).scan;
  if (scan.kind !== "review") throw new Error(`not in review: ${scan.kind}`);
  return scan.review;
}

describe("panel state: watching for a submitted application", () => {
  const attachDone: PanelReply = {
    status: {
      kind: "paired",
      endpoint: "http://localhost:3000",
      pairingId: PairingId.parse(SESSION_ID),
    },
    error: null,
    result: { kind: "attach_done", fieldId: id("resume"), fileName: "Resume.pdf" },
  };
  const attach: PanelRequest = {
    kind: "attach",
    sessionId: SESSION.id,
    tabId: 7,
    nonce: NONCE,
    fieldId: id("resume"),
    outputId: OUTPUT_ID,
  };
  const FILLED: PanelEvent = { kind: "filled", result: { nonce: NONCE, filled: [id("email")], skipped: [] } };

  test("nothing is watched before a fill or an attach", () => {
    expect(appliedWatch(INITIAL_STATE)).toBeNull();
    expect(appliedWatch(run(TO_REVIEW.slice(0, 3)).state)).toBeNull();
    expect(appliedWatch(run(TO_REVIEW).state)).toBeNull();
    expect(appliedWatch(run([...TO_REVIEW, { kind: "prefill_clicked" }]).state)).toBeNull();
  });

  test("a fill on the bound tab starts the watch on that tab", () => {
    const { state } = run([...TO_REVIEW, { kind: "prefill_clicked" }, FILLED]);
    expect(appliedWatch(state)).toEqual({ sessionId: SESSION.id, tabId: 7 });
  });

  test("a fill result for another scan does not start it", () => {
    const { state } = run([
      ...TO_REVIEW,
      { kind: "prefill_clicked" },
      { kind: "filled", result: { nonce: OTHER_NONCE, filled: [id("email")], skipped: [] } },
    ]);
    expect(appliedWatch(state)).toBeNull();
  });

  test("an attached file starts the watch; a rejected or refused attach does not", () => {
    expect(replyToEvent({ request: attach, reply: attachDone })).toEqual({ kind: "attached" });
    const rejected: PanelReply = {
      ...attachDone,
      result: { kind: "attach_rejected", fieldId: id("resume"), reason: "not_empty" },
    };
    expect(replyToEvent({ request: attach, reply: rejected })).toEqual({ kind: "ignored" });
    const refused: PanelReply = { ...attachDone, result: { kind: "refused", reason: "blocked_host" } };
    expect(replyToEvent({ request: attach, reply: refused })).toEqual({ kind: "ignored" });

    const { state } = run([...TO_REVIEW, { kind: "attached" }]);
    expect(appliedWatch(state)).toEqual({ sessionId: SESSION.id, tabId: 7 });
  });

  test("the watch survives the page moving on, and a new claim starts it over", () => {
    const acted = run([...TO_REVIEW, { kind: "attached" }]);
    const moved = run([{ kind: "tab_changed", tab: { tabId: 7, url: `${APPLY_URL}/thank-you` } }], acted.state);
    expect(appliedWatch(moved.state)).toEqual({ sessionId: SESSION.id, tabId: 7 });

    const other = { ...SESSION, id: ApplicationSessionDto.shape.id.parse("1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c") };
    const reclaimed = run(
      [
        { kind: "discovered", active: { kind: "active", session: other } },
        { kind: "claimed", session: other },
      ],
      moved.state,
    );
    expect(work(reclaimed.state).session.id).toBe(other.id);
    expect(appliedWatch(reclaimed.state)).toBeNull();
  });

  test("an attached event with no claimed application changes nothing", () => {
    expect(transition(INITIAL_STATE, { kind: "attached" }).state).toEqual(INITIAL_STATE);
  });
});
