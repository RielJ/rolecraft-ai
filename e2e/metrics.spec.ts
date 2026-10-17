import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AddJobResult } from "@/shared/api";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Slice 12: the top bar's refresh age, the Excluded toggle's count and the Board's metrics line.
// Runs on the playwright config's own port (HB_E2E_PORT, default 3100) and database.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeEach(() => withSql(resetTables));

const banner = (page: Page) => page.getByRole("banner");

test("the top bar shows the refresh age, and moves on when a Refresh finishes", async ({ page }) => {
  await page.goto("/");
  await expect(banner(page).getByText("Not refreshed yet")).toBeVisible();
  await expect(banner(page).getByRole("link", { name: "No jobs" })).toBeVisible();

  // The first Refresh goes through the sources panel. No reload: the age appears on its own.
  await banner(page)
    .getByRole("button", { name: /^Refresh/ })
    .click();
  await page.getByRole("dialog", { name: "First refresh" }).getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/^Refresh done\./)).toBeVisible();
  await expect(banner(page).getByText("Refreshed just now")).toBeVisible();
  await expect(banner(page).getByText("Not refreshed yet")).toHaveCount(0);

  // The job count sits right of the age and matches what Matches lists.
  const count = banner(page).getByRole("link", { name: /^[\d,]+ jobs?$/ });
  await expect(count).toBeVisible();
  const shown = Number((await count.innerText()).replace(/\D/g, ""));
  await expect(page.getByText(new RegExp(`^${shown} jobs?$`)).last()).toBeVisible();
  const [ageBox, countBox] = [
    await banner(page).getByText("Refreshed just now").boundingBox(),
    await count.boundingBox(),
  ];
  expect(countBox?.x ?? 0).toBeGreaterThan((ageBox?.x ?? 0) + (ageBox?.width ?? 0));

  // The same refresh, finished three days ago.
  await withSql((sql) => sql`UPDATE tasks SET finished_at = now() - interval '3 days 1 hour' WHERE kind = 'refresh'`);
  await page.reload();
  const age = banner(page).getByText("Refreshed 3 days ago");
  await expect(age).toBeVisible();
  await expect(age).toHaveCSS("font-variant-numeric", "tabular-nums");
});

test("the Excluded toggle carries the count of open excluded jobs in its name", async ({ page }) => {
  await withSql(async (sql) => {
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const jobs = [
      { title: "Open Engineer", eligibility: "worldwide", phrase: "open worldwide" },
      { title: "Locked One", eligibility: "excluded", phrase: "US-only" },
      { title: "Locked Two", eligibility: "excluded", phrase: "US-only" },
      { title: "Locked Three", eligibility: "excluded", phrase: "US-only" },
    ];
    for (const job of jobs) {
      const key = job.title.toLowerCase();
      await sql`
        INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, description,
          content_hash, description_key, eligibility, eligibility_phrase, first_seen_at)
        VALUES (${user?.id ?? ""}, 'source', ${job.title}, 'Acme', ${key}, 'acme',
          ${`https://example.com/jobs/${encodeURIComponent(key)}`},
          ${`${job.title} at Acme. This role is ${job.phrase}.`}, ${key}, ${key},
          ${job.eligibility}, ${job.phrase}, now())`;
    }
  });

  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Excluded 3" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("listbox", { name: "Matches" }).getByRole("option")).toHaveCount(1);

  // Showing them keeps the count.
  await toggle.click();
  await expect(page.getByRole("button", { name: "Excluded 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("listbox", { name: "Matches" }).getByRole("option")).toHaveCount(4);
});

async function paste(request: APIRequestContext, title: string, n: number): Promise<string> {
  const res = await request.post("/api/jobs/from-paste", {
    data: {
      url: `https://jobs.lever.co/acme/${n}`,
      title,
      company: "Acme Inc",
      description: "Build payment APIs in Go. Remote, worldwide.",
    },
  });
  expect(res.status()).toBe(201);
  return AddJobResult.parse(await res.json()).opportunityId;
}

type Step = { daysAgo: number; to: "saved" | "applied" | "interviewing" };

/** Give an opportunity a dated history (as status changes write it) and a Ready time. */
async function backdate(id: string, steps: Step[], readyMinutesAfterSave: number | null): Promise<void> {
  const now = Date.now();
  const when = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const history = steps.map((s, i) => ({
    at: when(s.daysAgo).toISOString(),
    from: i === 0 ? null : (steps[i - 1]?.to ?? null),
    to: s.to,
  }));
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last) throw new Error("no steps");
  const readyAt =
    readyMinutesAfterSave === null ? null : new Date(when(first.daysAgo).getTime() + readyMinutesAfterSave * MINUTE);
  await withSql(
    (sql) => sql`
      UPDATE opportunities SET history = ${JSON.stringify(history)}::jsonb, status = ${last.to},
        status_changed_at = ${when(last.daysAgo)}, ready_at = ${readyAt}
      WHERE id = ${id}`,
  );
}

test("the Board's metrics line: last 30 days from status history, and it follows a move", async ({ page, request }) => {
  const alpha = await paste(request, "Alpha Engineer", 1);
  await page.goto("/board");
  // A saved job only: no divide by zero, said plainly.
  const line = page.getByText(/^Last 30 days:/);
  await expect(line).toHaveText("Last 30 days: no applications sent · no jobs marked ready");

  const bravo = await paste(request, "Bravo Engineer", 2);
  const old = await paste(request, "Old Engineer", 3);
  await backdate(
    alpha,
    [
      { daysAgo: 10, to: "saved" },
      { daysAgo: 9, to: "applied" },
      { daysAgo: 2, to: "interviewing" },
    ],
    40,
  );
  await backdate(
    bravo,
    [
      { daysAgo: 5, to: "saved" },
      { daysAgo: 4, to: "applied" },
    ],
    40,
  );
  // Applied and marked ready before the window: not counted, even at Interviewing now.
  await backdate(
    old,
    [
      { daysAgo: 45, to: "saved" },
      { daysAgo: 40, to: "applied" },
      { daysAgo: 1, to: "interviewing" },
    ],
    5,
  );
  await page.reload();
  await expect(line).toHaveText(
    "Last 30 days: 2 applied · 1 reached Interviewing (50%) · median 40 min from saved to ready",
  );
  await expect(line).toHaveCSS("font-variant-numeric", "tabular-nums");

  // Key 3 moves Bravo to Interviewing; the line follows with no reload.
  const row = page.getByRole("link", { name: /Bravo Engineer/ });
  await row.focus();
  await page.keyboard.press("3");
  // Alpha and Old were there already.
  const interviewing = page.getByRole("region", { name: /^Interviewing 3/ });
  await expect(interviewing.getByRole("link", { name: /Bravo Engineer/ })).toBeVisible();
  await expect(line).toHaveText(
    "Last 30 days: 2 applied · 2 reached Interviewing (100%) · median 40 min from saved to ready",
  );
});
