import { describe, expect, test } from "bun:test";
import type { OpportunityStatus } from "@/shared/enums";
import {
  boardLocationLabel,
  durationLabel,
  inColumnLabel,
  metricsLine,
  postedLabel,
  refreshedLabel,
} from "@/shared/labels";
import { boardMetrics, METRICS_WINDOW_DAYS, type Timeline } from "./metrics";

const NOW = new Date("2026-10-31T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A time `days` before NOW, plus `minutes`. */
const ago = (days: number, minutes = 0) => new Date(NOW.getTime() - days * DAY + minutes * MINUTE);

/** A timeline from `[daysAgo, status]` steps; `ready` is days ago too. */
function timeline(steps: [number, OpportunityStatus][], ready: Date | null = null): Timeline {
  return { history: steps.map(([d, to]) => ({ at: ago(d), to })), readyAt: ready };
}

const metrics = (opportunities: Timeline[]) => boardMetrics({ opportunities, now: NOW });

describe("boardMetrics", () => {
  test("the window is the last 30 days", () => {
    expect(METRICS_WINDOW_DAYS).toBe(30);
    expect(metrics([]).windowDays).toBe(30);
  });

  test("zero applications: counts are zero and the rate is null, not NaN", () => {
    const m = metrics([timeline([[3, "saved"]])]);
    expect(m).toMatchObject({ applied: 0, interviewing: 0, rate: null });
  });

  test("counts applications sent in the window and those that reached Interviewing", () => {
    const m = metrics([
      timeline([
        [20, "saved"],
        [18, "applied"],
        [10, "interviewing"],
      ]),
      timeline([
        [12, "saved"],
        [11, "applied"],
        [2, "closed"],
      ]),
      timeline([
        [9, "saved"],
        [8, "applied"],
      ]),
      // Straight to Offer still reached Interviewing.
      timeline([
        [7, "saved"],
        [6, "applied"],
        [1, "offer"],
      ]),
    ]);
    expect(m).toMatchObject({ applied: 4, interviewing: 2, rate: 0.5 });
  });

  test("history entries outside the window are not counted", () => {
    const m = metrics([
      // Applied 40 days ago, interviewing 10 days ago: not an application of this window.
      timeline([
        [45, "saved"],
        [40, "applied"],
        [10, "interviewing"],
      ]),
      // Saved inside, applied inside.
      timeline([
        [5, "saved"],
        [4, "applied"],
      ]),
      // A moved-back-and-forth job counts once, from its first application (outside).
      timeline([
        [50, "saved"],
        [35, "applied"],
        [3, "saved"],
        [2, "applied"],
      ]),
      // Exactly 30 days ago is outside; a future entry (clock skew) is ignored.
      timeline([
        [31, "saved"],
        [30, "applied"],
      ]),
      timeline([
        [1, "saved"],
        [-1, "applied"],
      ]),
    ]);
    expect(m).toMatchObject({ applied: 1, interviewing: 0, rate: 0 });
  });

  test("saved straight to Interviewing counts as applied; saved to Closed does not", () => {
    const m = metrics([
      timeline([
        [5, "saved"],
        [4, "interviewing"],
      ]),
      timeline([
        [5, "saved"],
        [4, "closed"],
      ]),
    ]);
    expect(m).toMatchObject({ applied: 1, interviewing: 1, rate: 1 });
  });

  test("no Ready time: the median is null", () => {
    const m = metrics([
      timeline([
        [5, "saved"],
        [4, "applied"],
      ]),
    ]);
    expect(m).toMatchObject({ readyCount: 0, medianSavedToReadyMs: null });
  });

  test("median Saved to Ready over jobs marked ready in the window", () => {
    const m = metrics([
      { history: [{ at: ago(10), to: "saved" }], readyAt: ago(10, 40) },
      { history: [{ at: ago(8), to: "saved" }], readyAt: ago(8, 20) },
      { history: [{ at: ago(6), to: "saved" }], readyAt: ago(5) },
      // Marked ready 31 days ago: outside.
      { history: [{ at: ago(32), to: "saved" }], readyAt: ago(31) },
    ]);
    expect(m.readyCount).toBe(3);
    expect(m.medianSavedToReadyMs).toBe(40 * MINUTE);
  });

  test("an even count takes the mean of the middle two; the save is the latest one before Ready", () => {
    const m = metrics([
      { history: [{ at: ago(10), to: "saved" }], readyAt: ago(10, 30) },
      {
        // Saved, dismissed and saved again: Ready counts from the second save.
        history: [
          { at: ago(20), to: "saved" },
          { at: ago(4), to: "saved" },
        ],
        readyAt: ago(4, 90),
      },
    ]);
    expect(m.medianSavedToReadyMs).toBe(60 * MINUTE);
  });
});

describe("labels", () => {
  test("the metrics line, with zero applications said plainly", () => {
    expect(metricsLine(metrics([]))).toBe("Last 30 days: no applications sent · no jobs marked ready");
    const m = metrics([
      {
        history: [
          { at: ago(3), to: "saved" },
          { at: ago(2), to: "applied" },
        ],
        readyAt: ago(3, 40),
      },
      {
        history: [
          { at: ago(3), to: "saved" },
          { at: ago(2), to: "applied" },
        ],
        readyAt: null,
      },
      {
        history: [
          { at: ago(3), to: "saved" },
          { at: ago(2), to: "applied" },
          { at: ago(1), to: "interviewing" },
        ],
        readyAt: null,
      },
    ]);
    expect(metricsLine(m)).toBe(
      "Last 30 days: 3 applied · 1 reached Interviewing (33%) · median 40 min from saved to ready",
    );
  });

  test("durations round to minutes, hours or days", () => {
    expect(durationLabel(20_000)).toBe("1 min");
    expect(durationLabel(40 * MINUTE)).toBe("40 min");
    expect(durationLabel(90 * MINUTE)).toBe("2 hours");
    expect(durationLabel(60 * MINUTE)).toBe("1 hour");
    expect(durationLabel(3 * DAY + 2 * 60 * MINUTE)).toBe("3 days");
  });

  test("refresh age", () => {
    expect(refreshedLabel({ at: null, now: NOW })).toBe("Not refreshed yet");
    expect(refreshedLabel({ at: ago(0, -0.5), now: NOW })).toBe("Refreshed just now");
    // A clock a little ahead of the server is "just now", not negative.
    expect(refreshedLabel({ at: ago(0, 1), now: NOW })).toBe("Refreshed just now");
    expect(refreshedLabel({ at: ago(0, -1), now: NOW })).toBe("Refreshed 1 minute ago");
    expect(refreshedLabel({ at: ago(0, -125), now: NOW })).toBe("Refreshed 2 hours ago");
    expect(refreshedLabel({ at: ago(1), now: NOW })).toBe("Refreshed 1 day ago");
    expect(refreshedLabel({ at: ago(3, -60), now: NOW })).toBe("Refreshed 3 days ago");
  });

  test("posting age on a Board card: the posting date, else when it was first seen", () => {
    const seen = ago(40);
    expect(postedLabel({ postedAt: ago(0, -30), firstSeenAt: seen, now: NOW })).toBe("Posted today");
    // A posting date a little ahead of the clock is still today, not negative.
    expect(postedLabel({ postedAt: ago(0, 90), firstSeenAt: seen, now: NOW })).toBe("Posted today");
    expect(postedLabel({ postedAt: ago(1), firstSeenAt: seen, now: NOW })).toBe("Posted yesterday");
    expect(postedLabel({ postedAt: ago(12, -60), firstSeenAt: seen, now: NOW })).toBe("Posted 12d ago");
    expect(postedLabel({ postedAt: ago(75), firstSeenAt: seen, now: NOW })).toBe("Posted 2mo ago");
    expect(postedLabel({ postedAt: null, firstSeenAt: ago(3), now: NOW })).toBe("Found 3d ago");
    expect(postedLabel({ postedAt: null, firstSeenAt: ago(0, -5), now: NOW })).toBe("Found today");
  });

  test("time in a column, short and long: the card shows the short one, the tooltip the long one", () => {
    expect(inColumnLabel({ since: ago(0, -30), now: NOW })).toEqual({ short: "Today", long: "since today" });
    expect(inColumnLabel({ since: ago(1), now: NOW })).toEqual({ short: "1d", long: "for 1 day" });
    expect(inColumnLabel({ since: ago(20), now: NOW })).toEqual({ short: "20d", long: "for 20 days" });
    expect(inColumnLabel({ since: ago(400), now: NOW })).toEqual({ short: "13mo", long: "for 400 days" });
  });

  test("where a Board card says it hires: the verdict when it is known, else the posting's own words", () => {
    expect(boardLocationLabel({ eligibility: "worldwide", locationText: "Anywhere" })).toBe("Worldwide");
    expect(boardLocationLabel({ eligibility: "ph", locationText: "" })).toBe("Open to PH");
    expect(boardLocationLabel({ eligibility: "excluded", locationText: "US only" })).toBe("Excludes PH");
    expect(boardLocationLabel({ eligibility: "unclear", locationText: "  Remote, EMEA " })).toBe("Remote, EMEA");
    expect(boardLocationLabel({ eligibility: "unclear", locationText: "" })).toBeNull();
  });
});
