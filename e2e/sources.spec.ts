import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// The server runs with HB_SOURCES=fixture: boards are files under test/fixtures/sources.

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("targeting, a company board, Refresh and the plain Matches list", async ({ page }) => {
  // Job targeting on the profile: engineering only.
  await page.goto("/profile");
  await page.getByRole("checkbox", { name: "Engineering" }).click();
  await page.getByRole("button", { name: "Save targeting" }).click();
  await expect(page.getByText("Job targeting saved.")).toBeVisible();

  // A board that does not exist is rejected with the ATS's reason, and nothing is saved.
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("list", { name: "Sources" }).getByText("Jobicy")).toBeVisible();
  const link = page.getByLabel(/Paste a company's careers link/);
  await link.fill("https://boards.greenhouse.io/nosuchco");
  await page.getByRole("button", { name: "Add board" }).click();
  await expect(page.getByRole("alert")).toContainText('Greenhouse said the board "nosuchco" does not exist');

  await link.fill("https://boards.greenhouse.io/roles");
  await page.getByRole("button", { name: "Add board" }).click();
  await expect(page.getByRole("list", { name: "Sources" }).getByText("Roles", { exact: true })).toBeVisible();

  // Refresh from the top bar; the toast sums it up when the task finishes.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/^Refresh done\. 5 new\./)).toBeVisible();
  await expect(page.getByRole("list", { name: "Sources" })).toContainText("Kept 3 of 4");
  await expect(page.getByRole("list", { name: "Sources" })).toContainText("Kept 2 of 3");

  // Matches lists what was kept, not the designer or the sales role.
  await page.getByRole("link", { name: "Matches" }).click();
  const jobs = page.getByRole("list", { name: "Open jobs" });
  await expect(jobs.getByRole("listitem")).toHaveCount(5);
  await expect(jobs).toContainText("Senior Frontend Engineer");
  await expect(jobs).toContainText("Technical Wizard");
  await expect(jobs).not.toContainText("Product Designer");
  await expect(jobs).not.toContainText("Account Executive");

  // A second press right away reads nothing new: both boards ran within their minimum interval.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/^Refresh done\. 0 new\./)).toBeVisible();
});
