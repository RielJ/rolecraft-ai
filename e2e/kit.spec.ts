import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

const CV = [
  "Juan Dela Cruz",
  "- Built a payments API in Go serving 2M requests a day",
  "- Led a team of 4 engineers at Acme Corp",
].join("\n");

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("paste a CV and a job, write the resume, clear the gate, export a PDF", async ({ page }) => {
  // 1. Profile: contact, CV, confirm facts.
  await page.goto("/profile");
  await page.getByLabel("Full name").fill("Juan Dela Cruz");
  await page.getByLabel("Email").fill("juan@example.ph");
  await page.getByLabel("Location").fill("Manila, Philippines");
  await page.getByRole("button", { name: "Save contact" }).click();
  await expect(page.getByText("Contact details saved.")).toBeVisible();

  await page.getByLabel("CV text").fill(CV);
  await page.getByRole("button", { name: "Save and split into facts" }).click();
  const review = page.getByRole("list", { name: "Facts to review" });
  await expect(review.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Confirm all" }).click();
  await expect(page.getByRole("list", { name: "Confirmed facts" }).getByRole("listitem")).toHaveCount(3);

  // 2. Add a job by pasting it.
  await page.getByRole("button", { name: "Add job" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a job" });
  await dialog.getByLabel("Job title").fill("Senior Backend Engineer");
  await dialog.getByLabel("Company").fill("Acme Inc");
  await dialog.getByLabel("Description").fill("Build payment APIs in Go. Remote, worldwide.");
  await dialog.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Senior Backend Engineer" })).toBeVisible();
  await expect(page.getByText("Needs your input (3)")).toBeVisible();

  // 3. Write the resume, citing facts.
  await page
    .getByLabel("Resume text")
    .fill("# Summary\n- Built a payments API in Go [FACT-2]\n- Led a team of 4 [FACT-3]");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Facts cited in the resume" }).getByText("FACT-2")).toBeVisible();

  // 4. Untick the letter and the message.
  for (const name of ["Cover letter", "Short message"]) {
    await page.getByRole("tab", { name }).click();
    await page.getByLabel(`Include the ${name.toLowerCase()} in this application`).click();
  }
  await expect(page.getByText("Nothing. Every included file and answer is filled in.")).toBeVisible();

  // 5. A salary question blocks export until the profile answers it.
  await page.getByLabel("Add a question").fill("What are your salary expectations?");
  await page.getByRole("button", { name: "Add a question" }).click();
  await expect(page.getByText("Needs your input (1)")).toBeVisible();
  await page.getByRole("tab", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Export PDF" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mark ready" })).toBeDisabled();

  await page.getByLabel("Salary expectations for your profile").fill("PHP 180,000 a month");
  await page.getByRole("button", { name: "Save to profile" }).click();
  await expect(page.getByText("Nothing. Every included file and answer is filled in.")).toBeVisible();

  // 6. Export the PDF.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Juan Dela Cruz - Acme Inc - Resume.pdf");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");

  // 7. Copy as text and Mark ready are available once the gate passes.
  await expect(page.getByRole("button", { name: "Copy as text" })).toBeEnabled();
  await page.getByRole("button", { name: "Mark ready" }).click();
  await expect(page.getByText("Ready to apply")).toBeVisible();

  await page.getByRole("link", { name: "Board" }).click();
  const row = page.getByRole("link", { name: /Senior Backend Engineer/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("Ready")).toBeVisible();
});
