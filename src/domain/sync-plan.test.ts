import { describe, expect, test } from "bun:test";
import type { JobId } from "@/shared/api";
import {
  type CandidateJob,
  type ExistingListing,
  type FetchOutcome,
  type PlannedPosting,
  planSourceRun,
  STALE_DAYS,
} from "./sync-plan";

const now = new Date("2026-10-16T08:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const jobId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as JobId;

const posting = (id: string, over: Partial<PlannedPosting> = {}): PlannedPosting => ({
  externalId: id,
  titleKey: `title ${id}`,
  companyKey: "acme",
  applyUrlKey: `https://boards.greenhouse.io/acme/jobs/${id}`,
  descriptionKey: `desc ${id}`,
  contentHash: `hash ${id}`,
  postedAt: days(-2),
  ...over,
});

const listing = (id: string, n: number, over: Partial<ExistingListing> = {}): ExistingListing => ({
  externalId: id,
  jobId: jobId(n),
  isPrimary: true,
  jobContentHash: `hash ${id}`,
  jobExpiresAt: null,
  lastSeenAt: days(-1),
  missingSince: null,
  ...over,
});

type Fetched = Extract<FetchOutcome, { kind: "fetched" }>;
const fetched = (postings: PlannedPosting[], over: Partial<Fetched> = {}): Fetched => ({
  kind: "fetched",
  complete: true,
  fetchedIds: postings.map((p) => p.externalId),
  unread: [],
  dropped: 0,
  postings,
  ...over,
});

const plan = (args: {
  fetched: FetchOutcome;
  existing?: ExistingListing[];
  candidates?: CandidateJob[];
  lastOkCount?: number | null;
}) =>
  planSourceRun({
    source: { lastOkCount: args.lastOkCount ?? null },
    fetched: args.fetched,
    existing: args.existing ?? [],
    candidates: args.candidates ?? [],
    now,
  });

describe("planSourceRun (section 3.1, steps 5 to 7)", () => {
  test("a thrown fetch writes only the status and closes nothing", () => {
    expect(plan({ fetched: { kind: "failed", error: "The site answered 500." }, existing: [listing("1", 1)] })).toEqual(
      { kind: "failed", error: "The site answered 500." },
    );
    expect(plan({ fetched: { kind: "rate_limited", error: "429" } }).kind).toBe("rate_limited");
  });

  test("zero postings after a healthy run is suspicious_empty; on a first run it is ok", () => {
    expect(plan({ fetched: fetched([]), existing: [listing("1", 1)], lastOkCount: 7 })).toEqual({
      kind: "suspicious_empty",
    });
    expect(plan({ fetched: fetched([]), lastOkCount: null }).kind).toBe("ok");
    expect(plan({ fetched: fetched([]), lastOkCount: 0 }).kind).toBe("ok");
  });

  test("every posting dropped by the role filter is ok, not suspicious_empty", () => {
    const result = plan({ fetched: fetched([], { fetchedIds: ["1", "2", "3", "4"], dropped: 4 }), lastOkCount: 4 });
    expect(result).toMatchObject({ kind: "ok", count: 0, rawCount: 4, dropped: 4, upserts: [] });
  });

  test("a new posting inserts; a known one is seen; a changed primary is rewritten", () => {
    const result = plan({
      fetched: fetched([posting("1"), posting("2", { contentHash: "new" }), posting("3")]),
      existing: [listing("1", 1), listing("2", 2)],
    });
    expect(result).toMatchObject({
      kind: "ok",
      upserts: [
        { kind: "seen", externalId: "1", jobId: jobId(1), rewrite: false },
        { kind: "seen", externalId: "2", jobId: jobId(2), rewrite: true },
        { kind: "insert", externalId: "3" },
      ],
    });
  });

  test("a non-primary listing never rewrites its job (pasted and linked jobs keep their text)", () => {
    const result = plan({
      fetched: fetched([posting("1", { contentHash: "changed" })]),
      existing: [listing("1", 1, { isPrimary: false })],
    });
    expect(result).toMatchObject({ upserts: [{ kind: "seen", rewrite: false }] });
  });

  test("the same apply URL and title attaches to the stored job instead of inserting", () => {
    const p = posting("9");
    const candidate: CandidateJob = { ...p, id: jobId(5), descriptionKey: "pasted text", seenAt: days(-200) };
    expect(plan({ fetched: fetched([p]), candidates: [candidate] })).toMatchObject({
      upserts: [{ kind: "attach", externalId: "9", to: { kind: "job", jobId: jobId(5) } }],
    });
  });

  test("same company and title alone never attaches", () => {
    const p = posting("9");
    const candidate: CandidateJob = {
      ...p,
      id: jobId(5),
      applyUrlKey: "elsewhere",
      descriptionKey: "other",
      seenAt: now,
    };
    expect(plan({ fetched: fetched([p]), candidates: [candidate] })).toMatchObject({
      upserts: [{ kind: "insert", externalId: "9" }],
    });
  });

  test("two postings in one run that are the same posting make one job", () => {
    const a = posting("1");
    const b = posting("2", { applyUrlKey: a.applyUrlKey, titleKey: a.titleKey });
    expect(plan({ fetched: fetched([a, b]) })).toMatchObject({
      upserts: [
        { kind: "insert", externalId: "1" },
        { kind: "attach", externalId: "2", to: { kind: "inserted", externalId: "1" } },
      ],
    });
  });

  test("complete source: a listing absent from the run goes missing; a returning one reopens", () => {
    const result = plan({
      fetched: fetched([posting("2")]),
      existing: [
        listing("1", 1),
        listing("2", 2, { missingSince: days(-3) }),
        listing("3", 3, { missingSince: days(-3) }),
      ],
    });
    expect(result).toMatchObject({ kind: "ok", missing: ["1"], reopened: [jobId(2)] });
  });

  test("complete source: a posting the filters dropped is still on the board, so it is not missing", () => {
    const result = plan({
      fetched: fetched([posting("2")], { fetchedIds: ["1", "2"], dropped: 1 }),
      existing: [listing("1", 1), listing("2", 2)],
    });
    expect(result).toMatchObject({ kind: "ok", missing: [], count: 1, rawCount: 2, dropped: 1 });
  });

  test("incomplete source: absence alone closes nothing; 30 days without a sighting or expiry does", () => {
    const result = plan({
      fetched: fetched([posting("1")], { complete: false }),
      existing: [
        listing("1", 1, { lastSeenAt: days(-60) }),
        listing("2", 2, { lastSeenAt: days(-5) }),
        listing("3", 3, { lastSeenAt: days(-STALE_DAYS - 1) }),
        listing("4", 4, { lastSeenAt: days(-STALE_DAYS + 1) }),
        listing("5", 5, { lastSeenAt: days(-1), jobExpiresAt: days(-1) }),
      ],
    });
    expect(result).toMatchObject({ kind: "ok", missing: ["3", "5"] });
  });

  test("unread postings (detail budget): a stored one is seen unchanged and reopens; none goes missing", () => {
    const result = plan({
      fetched: fetched([posting("1")], { unread: ["2", "3", "9"] }),
      existing: [listing("1", 1), listing("2", 2), listing("3", 3, { missingSince: days(-3) }), listing("4", 4)],
      lastOkCount: 4,
    });
    expect(result).toMatchObject({
      kind: "ok",
      upserts: [
        { kind: "seen", externalId: "1", rewrite: false },
        { kind: "seen", externalId: "2", jobId: jobId(2), rewrite: false },
        { kind: "seen", externalId: "3", jobId: jobId(3), rewrite: false },
      ],
      missing: ["4"],
      reopened: [jobId(3)],
      count: 1,
      rawCount: 4,
    });
  });

  test("a run with only unread postings is not suspicious_empty", () => {
    expect(plan({ fetched: fetched([], { unread: ["1"] }), lastOkCount: 3 }).kind).toBe("ok");
  });

  test("duplicate external ids in one fetch count once", () => {
    expect(plan({ fetched: fetched([posting("1"), posting("1")]) })).toMatchObject({
      upserts: [{ kind: "insert", externalId: "1" }],
    });
  });
});
