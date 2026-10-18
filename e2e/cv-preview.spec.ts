import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// The CV preview (decision 69): the kept PDF beside the text read from it, and the CV's facts.

const fixture = (name: string) => join(import.meta.dirname, "../test/fixtures", name);
const KNOWN_LINE = "Cut invoice processing time from 40 minutes to 6 minutes";

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

async function uploadCv(page: Page, name: string): Promise<void> {
  await page.goto("/profile");
  await page.getByLabel(/^Upload your CV here/).setInputFiles(fixture(name));
  await expect(page.getByText(`Read ${name}.`)).toBeVisible();
  await expect(page.locator('[data-slot="file-drop-zone"]')).toContainText(`Last read from ${name} · View`);
}

async function openView(page: Page, name: string) {
  await page.getByRole("button", { name: `View ${name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Your CV" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("at 1280 px", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("a PDF opens in the PDF tab, the text is a tab away, and the facts sit beside the tabs", async ({ page }) => {
    await uploadCv(page, "cv.pdf");
    const dialog = await openView(page, "cv.pdf");
    const tabs = dialog.getByRole("tablist", { name: "Show the CV as" });
    await expect(tabs.getByRole("tab")).toHaveText(["PDF", "Text"]);
    await expect(tabs.getByRole("tab", { name: "PDF" })).toHaveAttribute("aria-selected", "true");

    const frame = dialog.locator("iframe");
    await expect(frame).toHaveAttribute("title", "Your CV as uploaded: cv.pdf");
    const src = (await frame.getAttribute("src")) ?? "";
    expect(src).toMatch(/^\/api\/profile\/cv\/file\?v=\d{4}-\d{2}-\d{2}T/);
    const res = await page.request.get(src);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["content-disposition"]).toBe(`inline; filename="cv.pdf"; filename*=UTF-8''cv.pdf`);
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");

    // Facts beside the tabs, not in a tab of their own.
    const facts = dialog.getByRole("complementary", { name: /Facts from this CV/ });
    await expect(facts).toBeVisible();
    await expect(facts.getByRole("list", { name: "Facts from this CV" })).toContainText(KNOWN_LINE);
    await expect(tabs.getByRole("tab", { name: /Facts/ })).toHaveCount(0);
    const [tabBox, factsBox] = [await tabs.boundingBox(), await facts.boundingBox()];
    expect(factsBox?.x ?? 0).toBeGreaterThan((tabBox?.x ?? 0) + (tabBox?.width ?? 0));

    await tabs.getByRole("tab", { name: "Text" }).click();
    await expect(dialog.getByRole("tabpanel", { name: "Text" }).locator("pre")).toContainText(KNOWN_LINE);
    await expect(frame).toBeHidden();

    // The iframe's PDF viewer is not part of the page, so axe checks the dialog around it.
    const result = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .exclude("iframe")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "View cv.pdf" })).toBeFocused();
  });

  test("a DOCX has no PDF tab, and the Text tab says why", async ({ page }) => {
    await uploadCv(page, "cv.docx");
    const dialog = await openView(page, "cv.docx");
    await expect(dialog.getByRole("tab")).toHaveText(["Text"]);
    await expect(dialog.locator("iframe")).toHaveCount(0);
    await expect(dialog.getByText("Word files show as the text the AI read.")).toBeVisible();
    await expect(dialog.locator("pre")).toContainText(KNOWN_LINE);
    expect((await page.request.get("/api/profile/cv/file")).status()).toBe(404);
  });
});

test.describe("at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the facts move to a Facts tab", async ({ page }) => {
    await uploadCv(page, "cv.pdf");
    const dialog = await openView(page, "cv.pdf");
    const tabs = dialog.getByRole("tablist", { name: "Show the CV as" });
    await expect(tabs.getByRole("tab")).toHaveText(["PDF", "Text", /^Facts \(\d+\)$/]);
    await expect(dialog.getByRole("complementary")).toHaveCount(0);
    await tabs.getByRole("tab", { name: /Facts/ }).click();
    await expect(dialog.getByRole("list", { name: "Facts from this CV" })).toContainText(KNOWN_LINE);
    await expect(dialog.locator("iframe")).toBeHidden();
  });
});
