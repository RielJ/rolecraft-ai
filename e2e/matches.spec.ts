import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Matches from the keyboard (PLAN.md section 4, keyboard model). Jobs are seeded in SQL as sync
// stores them, newest first: Alpha, Bravo, Charlie, Delta, Echo, plus one that excludes the PH.

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const TITLES = ["Alpha Engineer", "Bravo Engineer", "Charlie Engineer", "Delta Engineer", "Echo Engineer"];

test.beforeEach(() =>
  withSql(async (sql) => {
    await resetTables(sql);
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const jobs = [
      ...TITLES.map((title, i) => ({ title, eligibility: "worldwide", phrase: "open worldwide", age: i })),
      { title: "Locked Engineer", eligibility: "excluded", phrase: "US-only", age: 9 },
    ];
    for (const job of jobs) {
      const key = job.title.toLowerCase();
      await sql`
        INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, description,
          content_hash, description_key, eligibility, eligibility_phrase, first_seen_at)
        VALUES (${user?.id ?? ""}, 'source', ${job.title}, 'Acme', ${key}, 'acme',
          ${`https://example.com/jobs/${encodeURIComponent(key)}`},
          ${`${job.title} at Acme. This role is ${job.phrase}.`}, ${key}, ${key},
          ${job.eligibility}, ${job.phrase}, now() - make_interval(mins => ${job.age}))`;
    }
  }),
);

const list = (page: Page) => page.getByRole("listbox", { name: "Matches" });
const pane = (page: Page) => page.getByRole("region", { name: "Reading pane" });
const selected = (page: Page) => list(page).getByRole("option", { selected: true });

/** Animations running on the pane or any element in it. */
const paneAnimations = (page: Page) => pane(page).evaluate((el) => el.getAnimations({ subtree: true }).length);

test("j j s d 1 z: save, dismiss with a reason, undo; selection never animates", async ({ page }) => {
  await page.goto("/");
  await expect(list(page).getByRole("option")).toHaveText(TITLES.map((t) => new RegExp(t)));
  await expect(list(page)).toBeFocused();
  await expect(selected(page)).toContainText("Alpha Engineer");
  await expect(pane(page).getByRole("heading", { level: 2 })).toHaveText("Alpha Engineer");

  await page.keyboard.press("j");
  await expect(selected(page)).toContainText("Bravo Engineer");
  await expect(pane(page).getByRole("heading", { level: 2 })).toHaveText("Bravo Engineer");
  expect(await paneAnimations(page)).toBe(0);

  await page.keyboard.press("j");
  await expect(selected(page)).toContainText("Charlie Engineer");
  expect(await paneAnimations(page)).toBe(0);
  await expect(pane(page).getByRole("heading", { level: 2 })).toHaveText("Charlie Engineer");
  expect(await paneAnimations(page)).toBe(0);

  // s: Charlie goes to the board, the next job is selected.
  await page.keyboard.press("s");
  await expect(selected(page)).toContainText("Delta Engineer");
  await expect(list(page).getByRole("option")).toHaveCount(4);
  await expect(list(page)).not.toContainText("Charlie Engineer");

  // d then 1: Delta dismissed as "wrong stack", Echo selected.
  await page.keyboard.press("d");
  const reasons = page.getByRole("dialog", { name: "Dismiss reason" });
  await expect(reasons).toBeVisible();
  await page.keyboard.press("1");
  await expect(reasons).toBeHidden();
  await expect(selected(page)).toContainText("Echo Engineer");
  await expect(list(page).getByRole("option")).toHaveText(
    ["Alpha Engineer", "Bravo Engineer", "Echo Engineer"].map((t) => new RegExp(t)),
  );

  // z: the dismiss is undone and Delta is back, selected.
  await page.keyboard.press("z");
  await expect(list(page).getByRole("option")).toHaveText(
    ["Alpha Engineer", "Bravo Engineer", "Delta Engineer", "Echo Engineer"].map((t) => new RegExp(t)),
  );
  await expect(selected(page)).toContainText("Delta Engineer");

  const rows = await withSql(
    (sql) => sql<{ title: string; status: string | null; reason: string | null }[]>`
      SELECT j.title, o.status, o.dismiss_reason AS reason
      FROM opportunities o JOIN jobs j ON j.id = o.job_id ORDER BY j.title`,
  );
  expect(rows).toEqual([{ title: "Charlie Engineer", status: "saved", reason: null }]);

  // The board shows Charlie under Saved.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByRole("region", { name: /^Saved 1/ })).toContainText("Charlie Engineer");
});

test("e shows excluded jobs, ? opens the sheet, / focuses search and Esc returns", async ({ page }) => {
  await page.goto("/");
  await expect(list(page).getByRole("option")).toHaveCount(5);
  await expect(page.getByText("1 excluded hidden (e to show)")).toBeVisible();

  await list(page).focus();
  await page.keyboard.press("e");
  await expect(list(page).getByRole("option")).toHaveCount(6);
  await expect(list(page)).toContainText("Locked Engineer");
  await page.keyboard.press("e");
  await expect(list(page).getByRole("option")).toHaveCount(5);

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();

  await list(page).focus();
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search jobs" });
  await expect(search).toBeFocused();
  // Letters typed in search are text, not keys.
  await search.pressSequentially("delta");
  await expect(list(page).getByRole("option")).toHaveCount(1);
  await expect(selected(page)).toContainText("Delta Engineer");
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeFocused();

  // Enter opens the workspace, saving the job.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Delta Engineer" })).toBeVisible();
});

test("Profile's seniority, years and minimum pay save, and the minimum pay starts the Matches filter", async ({
  page,
}) => {
  await withSql(async (sql) => {
    // Alpha pays ₱50,000 a month and Bravo ₱200,000; the rest state no pay.
    await sql`UPDATE jobs SET pay_min = 50000, pay_currency = 'PHP', pay_period = 'month', pay_phrase = 'PHP 50,000/month'
      WHERE title = 'Alpha Engineer'`;
    await sql`UPDATE jobs SET pay_min = 200000, pay_currency = 'PHP', pay_period = 'month', pay_phrase = 'PHP 200,000/month'
      WHERE title = 'Bravo Engineer'`;
  });

  await page.goto("/profile");
  const form = page.getByRole("form", { name: "Job targeting" });
  await form.getByRole("combobox", { name: "Seniority" }).click();
  await page.getByRole("option", { name: "Senior" }).click();
  await form.getByLabel("Years of experience").fill("61");
  await form.getByLabel("Minimum pay amount").fill("100000");
  await form.getByRole("button", { name: "Save targeting" }).click();
  await expect(form.getByRole("alert")).toHaveText("Years of experience is at most 60.");

  await form.getByLabel("Years of experience").fill("6");
  await form.getByRole("button", { name: "Save targeting" }).click();
  await expect(page.getByText("Job targeting saved.")).toBeVisible();

  await page.reload();
  await expect(form.getByRole("combobox", { name: "Seniority" })).toHaveText("Senior");
  await expect(form.getByLabel("Years of experience")).toHaveValue("6");
  await expect(form.getByLabel("Minimum pay amount")).toHaveValue("100000");
  await expect(form.getByLabel("Minimum pay currency")).toHaveValue("PHP");
  await expect(form.getByRole("combobox", { name: "Minimum pay period" })).toHaveText("a month");

  // Matches: the filter starts at the saved minimum. Alpha is under it; jobs with no pay stay.
  await page.getByRole("link", { name: "Matches" }).click();
  const pay = page.getByLabel("Pay at least");
  await expect(pay).toHaveValue("100000");
  await expect(page.getByText("From your profile")).toBeVisible();
  await expect(list(page).getByRole("option")).toHaveCount(4);
  await expect(list(page)).not.toContainText("Alpha Engineer");
  await expect(page.getByText("1 below your pay filter")).toBeVisible();

  // Change it on the page, then clear it.
  await pay.fill("300000");
  await expect(list(page).getByRole("option")).toHaveCount(3);
  await pay.fill("");
  await expect(list(page).getByRole("option")).toHaveCount(5);
  await expect(page.getByText("From your profile")).toBeHidden();
});
