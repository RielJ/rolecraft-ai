import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Runs on the playwright config's own port (HB_E2E_PORT, default 3100) and database.

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeEach(() => withSql(resetTables));

async function addJob(request: APIRequestContext, title: string, url: string): Promise<void> {
  const res = await request.post("/api/jobs/from-paste", {
    data: { url, title, company: "Acme Inc", description: "Build payment APIs in Go. Remote, worldwide." },
  });
  expect(res.status()).toBe(201);
}

const column = (page: Page, name: RegExp) => page.getByRole("region", { name });

test("contract terms, caution and notes in the workspace; moves on the board freeze the job", async ({
  page,
  request,
}) => {
  await addJob(request, "Backend Contractor", "https://jobs.lever.co/acme/1");

  // Empty columns and the job under Saved.
  await page.goto("/board");
  await expect(column(page, /^Saved 1/).getByRole("link", { name: /Backend Contractor/ })).toBeVisible();
  await expect(column(page, /^Offer 0/).getByText("None")).toBeVisible();

  // Workspace header: make it a contract and fill the terms. Each field saves on blur.
  await page.getByRole("link", { name: /Backend Contractor/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Backend Contractor" })).toBeVisible();
  await expect(page.getByText("US clients usually need a W-8BEN")).toHaveCount(0);
  await page.getByRole("radio", { name: "Contract" }).click();
  await expect(
    page.getByText("US clients usually need a W-8BEN; payment and tax setup come up at interview."),
  ).toBeVisible();
  await page.getByLabel("Rate", { exact: true }).fill("35.50");
  await page.getByLabel("Currency").fill("usd");
  await page.getByLabel("Platform").fill("Upwork");
  await page.getByLabel("Platform").blur();
  await page.getByRole("radio", { name: "Hourly" }).click();
  await expect(page.getByLabel("Currency")).toHaveValue("USD");
  await expect(page.getByRole("radio", { name: "Hourly" })).toBeChecked();

  // Notes save on blur, with no save button.
  await page.getByLabel("Notes").fill("Spoke to Maria. Send the proposal by Friday.");
  await page.getByLabel("Notes").blur();
  // Scoped to the side panel: the header's status badge also reads "Saved".
  await expect(
    page.getByRole("complementary", { name: "Apply and track" }).getByText("Saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Notes")).toHaveValue("Spoke to Maria. Send the proposal by Friday.");
  await expect(page.getByLabel("Rate", { exact: true })).toHaveValue("35.5");
  await expect(page.getByLabel("Platform")).toHaveValue("Upwork");

  // Back on the board: the card carries a Contract badge, the terms and the notes' first line.
  // Key 2 on the focused card moves it.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  const row = page.getByRole("link", { name: /Backend Contractor/ });
  await expect(row.getByText("Contract", { exact: true })).toBeVisible();
  await expect(row).toContainText("USD 35.50 hourly · Upwork");
  await expect(row).toContainText("Spoke to Maria. Send the proposal by Friday.");
  await row.focus();
  await page.keyboard.press("2");
  const applied = column(page, /^Applied \/ Proposal sent 1/);
  await expect(applied.getByRole("link", { name: /Backend Contractor/ })).toBeFocused();
  await expect(applied.getByText("USD 35.50 hourly · Upwork")).toBeVisible();

  // The workspace is frozen now: no drafting, no edits, notes still editable.
  await applied.getByRole("link", { name: /Backend Contractor/ }).click();
  await expect(
    page.getByText("This job is marked applied, so its files and answers stay as you sent them."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Draft all|Regenerate all/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a question" })).toHaveCount(0);
  await expect(page.getByLabel("Notes")).toBeEditable();

  // Fifteen days with no change shows the follow-up hint.
  await withSql((sql) => sql`UPDATE opportunities SET status_changed_at = now() - interval '15 days' RETURNING id`);
  await page.goto("/board");
  await expect(page.getByText("No change in 15 days. Follow up or close?")).toBeVisible();

  // Close it from the row menu; Closed asks for an outcome.
  await page.getByRole("button", { name: "Move Backend Contractor" }).click();
  await page.getByRole("menuitem", { name: /Closed/ }).click();
  await page.getByRole("menuitem", { name: "No response" }).click();
  const closed = column(page, /^Closed 1/);
  await expect(closed.getByRole("link", { name: /Backend Contractor/ })).toContainText("No response");
  await expect(page.getByText("Follow up or close?")).toHaveCount(0);
});

test("key 5 asks for an outcome; a failed move reverts and says why", async ({ page, request }) => {
  await addJob(request, "Platform Engineer", "https://jobs.lever.co/acme/2");
  await page.goto("/board");
  const row = page.getByRole("link", { name: /Platform Engineer/ });

  await row.focus();
  await page.keyboard.press("5");
  await expect(page.getByRole("menu").getByText("Close as")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Accepted" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Rejected" })).toBeFocused();
  await page.keyboard.press("Enter");
  const closed = column(page, /^Closed 1/);
  await expect(closed.getByRole("link", { name: /Platform Engineer/ })).toContainText("Rejected");
  await expect(closed.getByRole("link", { name: /Platform Engineer/ })).toBeFocused();

  // The server refuses the next move: the row goes back and a toast names the reason.
  await page.route("**/api/opportunities/*/status", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal", message: "The database is not reachable. Try again." } }),
    }),
  );
  await page.keyboard.press("4");
  await expect(
    page.getByText('Could not move "Platform Engineer". The database is not reachable. Try again.'),
  ).toBeVisible();
  await expect(column(page, /^Closed 1/).getByRole("link", { name: /Platform Engineer/ })).toBeVisible();
  await expect(column(page, /^Offer 0/)).toBeVisible();
});
