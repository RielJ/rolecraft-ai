import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ApiErrorBody, BoardItemDto, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { CONTRACTOR_CAUTION, statusLabel } from "@/shared/labels";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

const START = new Date("2026-10-01T08:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let now = START;
let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  now = START;
  deps = await testDeps({ clock: { now: () => now } });
  app = createApp(deps);
});

/** Move the injected clock forward. */
const advanceDays = (days: number) => {
  now = new Date(now.getTime() + days * DAY_MS);
};

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

/** postgres.js queries are lazy (they run on `.then`), so await them before asserting. */
async function sqlError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String(error);
  }
  return "no error";
}

const JOB = {
  url: "https://jobs.lever.co/acme/123",
  title: "Senior Backend Engineer",
  company: "Acme Inc",
  description: "Build payment APIs. Remote, worldwide.",
};

async function pasteJob(job = JOB): Promise<WorkspaceDto> {
  const added = await json(await call("POST", "/jobs/from-paste", job), AddJobResult, 201);
  return json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
}

const board = async () => json(await call("GET", "/board"), z.array(BoardItemDto));
const move = (ws: WorkspaceDto, body: unknown) => call("POST", `/opportunities/${ws.opportunity.id}/status`, body);
const patch = (ws: WorkspaceDto, body: unknown) => call("PATCH", `/opportunities/${ws.opportunity.id}`, body);
const reload = async (ws: WorkspaceDto) => json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

describe("status changes", () => {
  test("each change appends to history and sets status_changed_at", async () => {
    const ws = await pasteJob();
    advanceDays(2);
    const applied = await json(await move(ws, { status: "applied" }), BoardItemDto);
    expect(applied.status).toBe("applied");
    expect(applied.statusChangedAt).toBe("2026-10-03T08:00:00.000Z");
    advanceDays(3);
    await json(await move(ws, { status: "interviewing" }), BoardItemDto);
    advanceDays(1);
    const closed = await json(await move(ws, { status: "closed", outcome: "rejected" }), BoardItemDto);
    expect(closed.outcome).toBe("rejected");

    const [row] = await testSql()`SELECT status, outcome, status_changed_at, history FROM opportunities`;
    expect(row?.status).toBe("closed");
    expect(row?.outcome).toBe("rejected");
    expect(row?.status_changed_at).toEqual(new Date("2026-10-07T08:00:00Z"));
    expect(row?.history).toEqual([
      { at: "2026-10-01T08:00:00.000Z", from: null, to: "saved" },
      { at: "2026-10-03T08:00:00.000Z", from: "saved", to: "applied" },
      { at: "2026-10-06T08:00:00.000Z", from: "applied", to: "interviewing" },
      { at: "2026-10-07T08:00:00.000Z", from: "interviewing", to: "closed", outcome: "rejected" },
    ]);
  });

  test("moving to the status it already has changes nothing", async () => {
    const ws = await pasteJob();
    advanceDays(1);
    const same = await json(await move(ws, { status: "saved" }), BoardItemDto);
    expect(same.statusChangedAt).toBe(START.toISOString());
    const [row] = await testSql()`SELECT jsonb_array_length(history) AS n FROM opportunities`;
    expect(row?.n).toBe(1);
  });

  test("Closed without an outcome is a 400 from Zod, and the DB CHECK refuses it too", async () => {
    const ws = await pasteJob();
    const body = await json(await move(ws, { status: "closed" }), ApiErrorBody, 400);
    expect(body.error.code).toBe("invalid_input");
    const bad = await json(await move(ws, { status: "closed", outcome: "ghosted" }), ApiErrorBody, 400);
    expect(bad.error.code).toBe("invalid_input");

    const noOutcome = await sqlError(testSql()`UPDATE opportunities SET status = 'closed'`);
    expect(noOutcome).toContain("opportunities_closed_outcome");
    const strayOutcome = await sqlError(testSql()`UPDATE opportunities SET outcome = 'rejected'`);
    expect(strayOutcome).toContain("opportunities_closed_outcome");

    const [row] = await testSql()`SELECT status, outcome FROM opportunities`;
    expect(row).toEqual({ status: "saved", outcome: null });
  });

  test("reopening a closed job clears its outcome; changing only the outcome is logged", async () => {
    const ws = await pasteJob();
    await move(ws, { status: "closed", outcome: "no_response" });
    await move(ws, { status: "closed", outcome: "withdrawn" });
    const reopened = await json(await move(ws, { status: "interviewing" }), BoardItemDto);
    expect(reopened.outcome).toBeNull();
    const [row] = await testSql()`SELECT history FROM opportunities`;
    expect(row?.history).toEqual([
      { at: START.toISOString(), from: null, to: "saved" },
      { at: START.toISOString(), from: "saved", to: "closed", outcome: "no_response" },
      { at: START.toISOString(), from: "closed", to: "closed", outcome: "withdrawn" },
      { at: START.toISOString(), from: "closed", to: "interviewing" },
    ]);
  });

  test("an unknown opportunity is a 404", async () => {
    const res = await call("POST", "/opportunities/00000000-0000-4000-8000-000000000000/status", {
      status: "applied",
    });
    expect((await json(res, ApiErrorBody, 404)).error.code).toBe("not_found");
  });

  test("the board lists every column's rows, most recently moved first", async () => {
    const first = await pasteJob();
    advanceDays(1);
    const second = await pasteJob({ ...JOB, url: "https://jobs.lever.co/acme/456", title: "Platform Engineer" });
    advanceDays(1);
    await move(first, { status: "offer" });
    const rows = await board();
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ["Senior Backend Engineer", "offer"],
      ["Platform Engineer", "saved"],
    ]);
    expect(String(rows[1]?.opportunityId)).toBe(String(second.opportunity.id));
  });
});

describe("drafting on the card", () => {
  /** A draft task row as the task runner leaves it, at a given age so the latest one wins. */
  const draftTask = (ws: WorkspaceDto, status: string, minutesAgo: number) =>
    testSql()`INSERT INTO tasks (user_id, kind, status, input, created_at)
      VALUES (${deps.userId}, 'draft', ${status}, ${testSql().json({ opportunityId: ws.opportunity.id })},
        now() - make_interval(mins => ${minutesAgo}))`;
  const drafting = async () => (await board()).map((r) => r.drafting);

  test("shows the latest draft while it runs or after it failed, and nothing once it is done", async () => {
    const ws = await pasteJob();
    expect(await drafting()).toEqual([null]);
    await draftTask(ws, "running", 3);
    expect(await drafting()).toEqual(["running"]);
    await draftTask(ws, "failed", 2);
    expect(await drafting()).toEqual(["failed"]);
    await draftTask(ws, "done", 1);
    expect(await drafting()).toEqual([null]);
  });

  test("another job's draft does not show on this card", async () => {
    await pasteJob();
    const other = await pasteJob({ ...JOB, url: "https://jobs.lever.co/acme/456", title: "Platform Engineer" });
    await draftTask(other, "running", 1);
    const rows = await board();
    expect(rows.map((r) => [r.title, r.drafting])).toEqual(
      expect.arrayContaining([
        ["Senior Backend Engineer", null],
        ["Platform Engineer", "running"],
      ]),
    );
  });
});

describe("contracts", () => {
  test("a contract keeps rate, rate type, currency and platform, and says Proposal sent for applied", async () => {
    const ws = await pasteJob();
    const updated = await json(
      await patch(ws, {
        type: "contract",
        contract: { rateAmount: 35.5, rateType: "hourly", rateCurrency: "usd", platform: " Upwork " },
      }),
      WorkspaceDto,
    );
    expect(updated.opportunity.type).toBe("contract");
    expect(updated.opportunity.contract).toEqual({
      rateAmount: 35.5,
      rateType: "hourly",
      rateCurrency: "USD",
      platform: "Upwork",
    });

    const item = await json(await move(ws, { status: "applied" }), BoardItemDto);
    expect(item.contract).toEqual({ rateAmount: 35.5, rateType: "hourly", rateCurrency: "USD", platform: "Upwork" });
    expect(statusLabel(item)).toBe("Proposal sent");
    expect(statusLabel({ type: "job", status: "applied" })).toBe("Applied");

    // Partial updates touch only the fields sent; blanks clear.
    const cleared = await json(await patch(ws, { contract: { platform: "" } }), WorkspaceDto);
    expect(cleared.opportunity.contract).toEqual({
      rateAmount: 35.5,
      rateType: "hourly",
      rateCurrency: "USD",
      platform: null,
    });
  });

  test("the W-8BEN caution uses the decision's wording", () => {
    expect(CONTRACTOR_CAUTION).toBe("US clients usually need a W-8BEN; payment and tax setup come up at interview.");
  });

  test("switching back to a job clears the terms; jobs refuse terms", async () => {
    const ws = await pasteJob();
    await patch(ws, { type: "contract", contract: { rateAmount: 1200, rateType: "fixed", rateCurrency: "PHP" } });
    const job = await json(await patch(ws, { type: "job" }), WorkspaceDto);
    expect(job.opportunity.contract).toBeNull();
    const [row] = await testSql()`SELECT rate_amount, rate_type, rate_currency, platform FROM opportunities`;
    expect(row).toEqual({ rate_amount: null, rate_type: null, rate_currency: null, platform: null });

    const refused = await json(await patch(ws, { contract: { rateAmount: 10 } }), ApiErrorBody, 400);
    expect(refused.error.message).toContain("Switch it to a contract first");
    const both = await json(await patch(ws, { type: "job", contract: { rateAmount: 10 } }), ApiErrorBody, 400);
    expect(both.error.code).toBe("invalid_input");
  });

  test("bad terms are a 400", async () => {
    const ws = await pasteJob();
    await patch(ws, { type: "contract" });
    for (const contract of [{ rateCurrency: "US" }, { rateAmount: 0 }, { rateAmount: -5 }, { rateType: "daily" }]) {
      const body = await json(await patch(ws, { contract }), ApiErrorBody, 400);
      expect(body.error.code).toBe("invalid_input");
    }
    expect((await json(await patch(ws, {}), ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });
});

describe("freeze on apply", () => {
  async function setup() {
    await call("PUT", "/profile", {
      standardAnswers: { salary: "USD 4,000 a month", notice: "30 days" },
    });
    await waitForSplits(
      await json(
        await call("PUT", "/profile/cv", { text: "- Built a payments API in Go\n- Led a team of 4 engineers" }),
        ProfileDto,
      ),
    );
    const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    let ws = await pasteJob();
    for (const question of [
      "What are your salary expectations?",
      "What is your notice period?",
      "When can you start?",
    ]) {
      ws = await json(
        await call("POST", `/opportunities/${ws.opportunity.id}/questions`, { question }),
        WorkspaceDto,
        201,
      );
    }
    // The notice answer is overridden for this job; that override must survive.
    const notice = ws.answers.find((a) => a.mustAnswer === "notice");
    ws = await json(await call("PATCH", `/outputs/${notice?.id}`, { body: "Two weeks" }), WorkspaceDto);
    ws = await json(
      await call("PATCH", `/outputs/${file(ws, "resume").id}`, { body: "Built a payments API [FACT-1]." }),
      WorkspaceDto,
    );
    return { ws, profile };
  }

  test("marking applied writes applied_snapshot and copies resolved standard answers", async () => {
    const { ws } = await setup();
    advanceDays(1);
    await json(await move(ws, { status: "applied" }), BoardItemDto);

    const [opp] = await testSql()`SELECT applied_snapshot FROM opportunities`;
    expect(opp?.applied_snapshot).toEqual({
      title: JOB.title,
      company: JOB.company,
      description: JOB.description,
      applyUrl: JOB.url,
      at: "2026-10-02T08:00:00.000Z",
    });
    const answers = await testSql()`
      SELECT must_answer, body, edited_at IS NULL AS untouched FROM outputs
      WHERE kind = 'answer' ORDER BY position`;
    expect([...answers]).toEqual([
      { must_answer: "salary", body: "USD 4,000 a month", untouched: true },
      { must_answer: "notice", body: "Two weeks", untouched: false },
      // No standard answer for start date: nothing to copy, so the gate still names it.
      { must_answer: "start_date", body: null, untouched: true },
    ]);

    // A later profile edit no longer changes what was sent.
    await call("PUT", "/profile", { standardAnswers: { salary: "USD 9,000 a month" } });
    const after = await reload(ws);
    expect(after.answers.find((a) => a.mustAnswer === "salary")?.body).toBe("USD 4,000 a month");
  });

  test("after applying, edit and draft return 409 frozen and no outdated notice shows", async () => {
    const { ws, profile } = await setup();
    await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
    await move(ws, { status: "applied" });

    const edit = await call("PATCH", `/outputs/${file(ws, "resume").id}`, { body: "Changed." });
    expect((await json(edit, ApiErrorBody, 409)).error.code).toBe("frozen");
    const draft = await call("POST", `/opportunities/${ws.opportunity.id}/draft`, {});
    expect((await json(draft, ApiErrorBody, 409)).error.code).toBe("frozen");
    const ask = await call("POST", `/opportunities/${ws.opportunity.id}/questions`, { question: "Why us?" });
    expect((await json(ask, ApiErrorBody, 409)).error.code).toBe("frozen");

    const fact = profile.facts.find((f) => f.key === "FACT-1");
    await call("PATCH", `/facts/${fact?.id}`, { text: "Built a payments API in Rust" });
    const frozen = await reload(ws);
    expect(frozen.opportunity.frozen).toBe(true);
    expect([...frozen.files, ...frozen.answers].every((o) => o.outdated.length === 0)).toBe(true);
    expect(file(frozen, "resume").body).toBe("Built a payments API [FACT-1].");

    // Moving back to Saved unfreezes it, and the changed fact shows as outdated again.
    await move(ws, { status: "saved" });
    const open = await reload(ws);
    expect(file(open, "resume").outdated.map((o) => o.reason)).toEqual(["edited"]);
    const started = await json(
      await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { kinds: ["resume"] }),
      TaskDto,
      202,
    );
    await waitForTask(started.id);
  });

  test("notes and contract terms stay editable on a frozen job", async () => {
    const ws = await pasteJob();
    await move(ws, { status: "interviewing" });
    const updated = await json(
      await patch(ws, { notes: "Call with Maria on Friday", type: "contract", contract: { platform: "Direct" } }),
      WorkspaceDto,
    );
    expect(updated.opportunity.frozen).toBe(true);
    expect(updated.opportunity.notes).toBe("Call with Maria on Friday");
    expect(updated.opportunity.contract?.platform).toBe("Direct");
  });
});

describe("follow-up hint", () => {
  test("an applied job with no change for 15 days shows the hint; 13 days or another status does not", async () => {
    const applied = await pasteJob();
    const offer = await pasteJob({ ...JOB, url: "https://jobs.lever.co/acme/789", title: "Staff Engineer" });
    await move(applied, { status: "applied" });
    await move(offer, { status: "offer" });

    advanceDays(13);
    expect((await board()).map((r) => r.followUp)).toEqual([null, null]);

    advanceDays(2);
    const rows = await board();
    expect(rows.find((r) => r.status === "applied")?.followUp).toEqual({ days: 15 });
    expect(rows.find((r) => r.status === "offer")?.followUp).toBeNull();

    // Any change resets the clock.
    await move(applied, { status: "interviewing" });
    await move(applied, { status: "applied" });
    expect((await board()).find((r) => r.status === "applied")?.followUp).toBeNull();
  });

  test("the hint reads status_changed_at, set 15 days ago", async () => {
    const ws = await pasteJob();
    await move(ws, { status: "applied" });
    await testSql()`UPDATE opportunities SET status_changed_at = ${new Date(START.getTime() - 15 * DAY_MS)}`;
    expect((await board())[0]?.followUp).toEqual({ days: 15 });
  });
});

describe("notes", () => {
  test("notes save and come back on the board and in the workspace", async () => {
    const ws = await pasteJob();
    const saved = await json(await patch(ws, { notes: "Referred by Ana.\nFollow up Monday." }), WorkspaceDto);
    expect(saved.opportunity.notes).toBe("Referred by Ana.\nFollow up Monday.");
    expect((await board())[0]?.notes).toBe("Referred by Ana.\nFollow up Monday.");
    const cleared = await json(await patch(ws, { notes: "" }), WorkspaceDto);
    expect(cleared.opportunity.notes).toBe("");
  });
});

describe("posting date on the card", () => {
  test("the board carries the posting date, null when the source gave none, and when it was first seen", async () => {
    const ws = await pasteJob();
    const [none] = await board();
    expect(none?.postedAt).toBeNull();
    const [seen] = await testSql()`SELECT first_seen_at FROM jobs`;
    expect(none?.firstSeenAt).toBe(new Date(seen?.first_seen_at as string).toISOString());

    await testSql()`UPDATE jobs SET posted_at = '2026-09-20T03:00:00Z'`;
    expect((await board())[0]?.postedAt).toBe("2026-09-20T03:00:00.000Z");
    // A move answers with the same shape.
    const moved = await json(await move(ws, { status: "applied" }), BoardItemDto);
    expect(moved.postedAt).toBe("2026-09-20T03:00:00.000Z");
  });

  test("the card carries where it hires and the pay, compact and monthly in the view currency", async () => {
    await pasteJob();
    const [plain] = await board();
    expect(plain?.pay).toBeNull();
    expect(typeof plain?.locationText).toBe("string");

    await json(await call("PATCH", "/settings", { viewCurrency: "PHP", fxRates: { USD: 57.8 } }), z.unknown());
    await testSql()`UPDATE jobs SET pay_min = 60000, pay_max = 80000, pay_currency = 'USD', pay_period = 'year',
      eligibility = 'worldwide', location_text = 'Anywhere'`;
    const [paid] = await board();
    expect(paid?.pay).toBe("₱289K–₱385K a month");
    expect(paid?.eligibility).toBe("worldwide");
    expect(paid?.locationText).toBe("Anywhere");

    // No rate for the currency: the posting's own words, as Matches shows them.
    await testSql()`UPDATE jobs SET pay_currency = 'EUR', pay_phrase = '€50k a year'`;
    expect((await board())[0]?.pay).toBe("€50k a year");
  });
});
