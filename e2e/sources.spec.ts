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

test("targeting, a company board, Refresh and the Matches list", async ({ page }) => {
  // Job targeting on the profile: engineering only.
  await page.goto("/profile");
  await page.getByRole("checkbox", { name: "Engineering" }).click();
  await page.getByRole("button", { name: "Save targeting" }).click();
  await expect(page.getByText("Job targeting saved.")).toBeVisible();

  // A board that does not exist is rejected with the ATS's reason, and nothing is saved.
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("list", { name: "Sources" }).getByText("Jobicy", { exact: true })).toBeVisible();
  const link = page.getByLabel(/Paste a company's job list link/);
  await link.fill("https://boards.greenhouse.io/nosuchco");
  await page.getByRole("button", { name: "Add board" }).click();
  await expect(page.getByRole("alert")).toContainText('Greenhouse said the board "nosuchco" does not exist');

  await link.fill("https://boards.greenhouse.io/roles");
  await page.getByRole("button", { name: "Add board" }).click();
  await expect(page.getByRole("list", { name: "Sources" }).getByText("Roles", { exact: true })).toBeVisible();

  // Refresh from the top bar; the toast sums it up when the task finishes.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/^Refresh done\. 11 new\./)).toBeVisible();
  await expect(page.getByRole("list", { name: "Sources" })).toContainText("Kept 3 of 4");
  await expect(page.getByRole("list", { name: "Sources" })).toContainText("Kept 2 of 3");

  // Matches lists what was kept, not the designer or the sales role.
  await page.getByRole("link", { name: "Matches" }).click();
  const jobs = page.getByRole("listbox", { name: "Matches" });
  // Greenhouse 3, Jobicy 2, and the other built-ins' fixtures: Himalayas 2, RemoteOK 1, WWR 2, Remotive 1.
  await expect(jobs.getByRole("option")).toHaveCount(11);
  await expect(jobs).toContainText("Senior Frontend Engineer");
  await expect(jobs).toContainText("Technical Wizard");
  // Unsure about the role: kept, with the chip, and the reason in the pane.
  await jobs.getByRole("option", { name: /Technical Wizard/ }).click();
  await expect(jobs.getByRole("option", { name: /Technical Wizard/ })).toContainText("Role unclear");
  await expect(page.getByRole("region", { name: "Reading pane" })).toContainText("no role family in the title");
  await expect(jobs).not.toContainText("Product Designer");
  await expect(jobs).not.toContainText("Account Executive");

  // RemoteOK asks for credit: its job reads "via RemoteOK", linked to the listing there.
  await jobs.getByRole("option", { name: /Senior TypeScript Engineer/ }).click();
  const pane = page.getByRole("region", { name: "Reading pane" });
  await expect(pane).toContainText("via RemoteOK");
  await expect(pane.getByRole("link", { name: "RemoteOK" })).toHaveAttribute(
    "href",
    "https://remoteok.com/remote-jobs/remote-senior-typescript-engineer-pied-piper-1093001",
  );

  // A second press right away reads nothing new: both boards ran within their minimum interval.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/^Refresh done\. 0 new\./)).toBeVisible();
});

test("a built-in board's own keywords replace the target titles, and can go back", async ({ page }) => {
  await page.goto("/sources");
  const list = page.getByRole("list", { name: "Sources" });
  await expect(list.getByRole("link", { name: "remoteok.com" })).toHaveAttribute("href", "https://remoteok.com");
  const row = list.getByRole("listitem").filter({ hasText: "RemoteOK" });
  await expect(row).toContainText("Keywords: your target titles");

  await row.getByRole("button", { name: "Edit RemoteOK keywords" }).click();
  await row.getByLabel(/RemoteOK keywords, one per line/).fill("devops\n  kubernetes \n\n");
  await row.getByRole("button", { name: "Save keywords" }).click();
  await expect(page.getByText("Saved RemoteOK's keywords.")).toBeVisible();
  await expect(row).toContainText("Keywords: devops, kubernetes");

  await row.getByRole("button", { name: "Edit RemoteOK keywords" }).click();
  await row.getByRole("button", { name: "Use target titles" }).click();
  await expect(page.getByText("RemoteOK uses your target titles.")).toBeVisible();
  await expect(row).toContainText("Keywords: your target titles");
});
