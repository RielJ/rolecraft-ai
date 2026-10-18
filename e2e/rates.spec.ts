import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { RefreshDto } from "@/shared/api";
import { E2E_DATABASE_URL, E2E_FX_DIR } from "../playwright.config";
import { resetTables } from "../test/reset";

/*
 * Exchange rates fill themselves (decision 67). The server reads rate bodies from E2E_FX_DIR: this
 * spec copies the recorded ECB and currency-api bodies in, and empties it again so every other spec
 * sees unreachable sources. Nothing reaches the network.
 */

const FIXTURES = join(import.meta.dirname, "../test/fixtures/fx");

async function emptyFxDir(): Promise<void> {
  await rm(E2E_FX_DIR, { recursive: true, force: true });
  await mkdir(E2E_FX_DIR, { recursive: true });
}

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await emptyFxDir();
  await cp(FIXTURES, E2E_FX_DIR, { recursive: true });
});

test.afterEach(emptyFxDir);

/**
 * Paste a job paid in EUR (the fixture boards only pay in USD), then run a Refresh through the API
 * and wait for it to finish. Its last step fills rates.
 */
async function refresh(page: Page): Promise<void> {
  const pasted = await page.request.post("/api/jobs/from-paste", {
    data: { title: "Backend Engineer", company: "Euro Co", description: "Remote role. Pay is EUR 5,000 per month." },
  });
  expect(pasted.status()).toBe(201);
  const started = await page.request.post("/api/refresh");
  expect(started.status()).toBe(202);
  await expect
    .poll(async () => RefreshDto.parse(await (await page.request.get("/api/refresh")).json()).task?.status, {
      timeout: 30_000,
    })
    .toBe("done");
}

const rates = (page: Page) => page.getByRole("list", { name: "Rates" });
const row = (page: Page, currency: string) =>
  rates(page)
    .getByRole("listitem")
    .filter({ has: page.getByLabel(`1 ${currency}`, { exact: true }) });

test("Refresh fills rates; a typed rate is kept; Fill rates brings a removed one back", async ({ page }) => {
  await refresh(page);
  await page.goto("/settings");
  await expect(row(page, "USD").getByLabel("1 USD", { exact: true })).toHaveValue("62.9681");
  await expect(row(page, "USD")).toContainText("ECB, rate of 16 Oct");
  await expect(row(page, "EUR").getByLabel("1 EUR", { exact: true })).toHaveValue("70.858");

  // Type USD 60: the row now reads as the user's.
  await row(page, "USD").getByLabel("1 USD", { exact: true }).fill("60");
  await row(page, "USD").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 USD = 60 PHP")).toBeVisible();
  await expect(row(page, "USD")).toContainText("Set by you");

  // Remove EUR: it needs a rate again.
  await row(page, "EUR").getByRole("button", { name: "Remove" }).click();
  await expect(row(page, "EUR").getByLabel("1 EUR", { exact: true })).toHaveValue("");

  // Fill rates: EUR is back from the ECB; USD stays the user's.
  await page.getByRole("button", { name: "Fill rates" }).click();
  await expect(page.getByText(/^Filled \d+ rates?\./)).toBeVisible();
  await expect(row(page, "EUR").getByLabel("1 EUR", { exact: true })).toHaveValue("70.858");
  await expect(row(page, "EUR")).toContainText("ECB");
  await expect(row(page, "USD").getByLabel("1 USD", { exact: true })).toHaveValue("60");
  await expect(row(page, "USD")).toContainText("Set by you");
});

test("with the sources unreachable, Fill rates shows the error and keeps every rate", async ({ page }) => {
  await refresh(page);
  await page.goto("/settings");
  await row(page, "USD").getByLabel("1 USD", { exact: true }).fill("60");
  await row(page, "USD").getByRole("button", { name: "Save" }).click();
  await expect(row(page, "USD")).toContainText("Set by you");
  await expect(row(page, "EUR").getByLabel("1 EUR", { exact: true })).toHaveValue("70.858");

  await emptyFxDir();
  await page.getByRole("button", { name: "Fill rates" }).click();
  // The toast, and the note under Rates.
  await expect(
    page.locator("[data-sonner-toast]", { hasText: "Could not get ECB rates from Frankfurter" }),
  ).toBeVisible();
  await expect(page.getByText(/Your rates were kept\./)).toBeVisible();
  await expect(row(page, "USD").getByLabel("1 USD", { exact: true })).toHaveValue("60");
  await expect(row(page, "EUR").getByLabel("1 EUR", { exact: true })).toHaveValue("70.858");
});
