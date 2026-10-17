import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

/** Drop a file on a target the way a browser does: dragenter, dragover, then drop. */
async function dropFile(page: Page, target: Locator, file: { name: string; type: string; bytes: Buffer }) {
  const dataTransfer = await page.evaluateHandle(
    ({ name, type, data }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], name, { type }));
      return transfer;
    },
    { name: file.name, type: file.type, data: [...file.bytes] },
  );
  for (const event of ["dragenter", "dragover", "drop"]) await target.dispatchEvent(event, { dataTransfer });
}

test("a CV dropped on the zone is read, hides the paste box, and fills empty contact fields", async ({ page }) => {
  await page.goto("/profile");
  const zone = page.locator('[data-slot="file-drop-zone"]');
  await expect(zone).toContainText("Upload your CV here");
  await expect(page.getByLabel("CV text")).toBeVisible();

  // A file of the wrong kind is refused before it is sent.
  await dropFile(page, zone, { name: "notes.txt", type: "text/plain", bytes: Buffer.from("hello") });
  await expect(page.getByRole("alert")).toHaveText("That file is not a PDF or DOCX. Choose a PDF or DOCX.");

  const pdf = await readFile(join(import.meta.dirname, "../test/fixtures/cv.pdf"));
  await dropFile(page, zone, { name: "cv.pdf", type: "application/pdf", bytes: pdf });
  await expect(page.getByText("Read cv.pdf. Its facts appear below. Filled your name under Contact.")).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveValue("Maria Santos");
  await expect(zone).toContainText("Last read from cv.pdf.");
  await expect(zone).toContainText("Upload a new version of your CV");

  // The text came from the file, so the paste box stays out of the way until asked for.
  await expect(page.getByLabel("CV text")).toBeHidden();
  await page.getByRole("button", { name: "Paste the text instead" }).click();
  await expect(page.getByLabel("CV text")).toHaveValue(/^Maria Santos\nBackend Engineer, Cebu City/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("CV text")).toBeHidden();
});

test("links are one line, and a fact edits in a multi-line box that grows with its text", async ({ page }) => {
  await page.goto("/profile");
  const links = page.getByLabel("Links");
  expect(await links.evaluate((el) => el.tagName)).toBe("INPUT");
  await links.fill("https://github.com/maria, https://maria.dev");
  await page.getByRole("button", { name: "Save contact" }).click();
  await expect(page.getByText("Contact details saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Links")).toHaveValue("https://github.com/maria, https://maria.dev");

  await page.getByLabel("CV text").fill("- Built a payments API in Go");
  await page.getByRole("button", { name: "Save and split into facts" }).click();
  const review = page.getByRole("list", { name: "Facts to review" });
  await expect(review.getByRole("listitem")).toHaveCount(1);

  await review.getByRole("button", { name: "Edit" }).click();
  const box = review.getByRole("textbox", { name: /^Edit FACT-/ });
  expect(await box.evaluate((el) => el.tagName)).toBe("TEXTAREA");
  const oneLine = await box.evaluate((el) => el.getBoundingClientRect().height);
  const long = `Built a payments API in Go ${"that settled invoices across many banks and wallets, ".repeat(4)}`.trim();
  await box.fill(long);
  expect(await box.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(oneLine * 2);
  // Confirm and Discard step aside while editing.
  await expect(review.getByRole("button", { name: "Confirm" })).toBeHidden();

  await box.press("ControlOrMeta+Enter");
  await expect(box).toBeHidden();
  await expect(review.getByRole("listitem")).toContainText(long);

  // Esc cancels and keeps the saved text.
  await review.getByRole("button", { name: "Edit" }).click();
  await box.fill("Something else");
  await box.press("Escape");
  await expect(review.getByRole("listitem")).toContainText(long);
});
