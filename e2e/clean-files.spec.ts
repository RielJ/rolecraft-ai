import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { extractText, getDocumentProxy } from "unpdf";
import { AddJobResult, ProfileDto, WorkspaceDto } from "@/shared/api";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Clean files (decision 70): the file card, the PDF preview, the blanks
// form, clean copy text, and a view-only applied job.

test.use({ viewport: { width: 1280, height: 900 } });

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

const any = { parse: (v: unknown) => v };

async function api<T>(page: Page, method: string, path: string, schema: { parse(v: unknown): T }, body?: unknown) {
  const res = await page.request.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return schema.parse(await res.json());
}

/** A contact name, confirmed facts from a pasted CV, and one job by paste. */
async function seed(page: Page): Promise<WorkspaceDto> {
  await api(page, "PUT", "/settings/ai-key", any, { provider: "anthropic", key: "sk-ant-clean-files-ABCD" });
  await api(page, "PUT", "/profile", ProfileDto, {
    contact: { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Manila", links: [] },
  });
  await api(page, "PUT", "/profile/cv", ProfileDto, {
    text: "- Built a payments API in Go serving 2M requests a day\n- Led a team of 4 engineers",
  });
  await expect
    .poll(async () => (await api(page, "GET", "/profile", ProfileDto)).facts.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await api(page, "POST", "/facts/confirm-all", ProfileDto);
  const { opportunityId } = await api(page, "POST", "/jobs/from-paste", AddJobResult, {
    title: "Senior Backend Engineer",
    company: "Acme Inc",
    description: "Build payment APIs in Go. Remote, worldwide.",
  });
  return api(page, "GET", `/opportunities/${opportunityId}`, WorkspaceDto);
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`the workspace has no ${kind}`);
  return found;
}

async function setBody(page: Page, id: string, body: string | null): Promise<void> {
  await api(page, "PATCH", `/outputs/${id}`, any, { body });
}

async function setIncluded(page: Page, id: string, included: boolean): Promise<void> {
  await api(page, "PATCH", `/outputs/${id}`, any, { included });
}

/** The text of the PDF the preview frame points at, after checking it is an inline PDF. */
async function previewText(page: Page, src: string): Promise<string> {
  const res = await page.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toMatch(/^inline;/);
  const bytes = new Uint8Array(await res.body());
  expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  return text;
}

const BLANK = "Employer for the 2019 role";

test("the preview shows the PDF with its blank; filling it changes the next preview and unlocks Download", async ({
  page,
}) => {
  const ws = await seed(page);
  const resume = file(ws, "resume");
  await setBody(page, resume.id, `# Juan Dela Cruz\n## Summary\n- Built payment APIs in Go at [[${BLANK}]]`);
  for (const kind of ["letter", "message"] as const) await setIncluded(page, file(ws, kind).id, false);

  await page.goto(`/jobs/${ws.opportunity.id}`);
  const card = page.getByRole("tabpanel", { name: /^Resume/ });
  await expect(card.getByText(/^Edited just now · \d+ words · 1 blank$/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Download PDF" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Copy text" })).toBeDisabled();

  // Preview works while the blank remains, and shows it.
  const open = card.getByRole("button", { name: "Preview PDF" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Resume preview" });
  const frame = dialog.locator("iframe");
  await expect(frame).toHaveAttribute("title", "Resume PDF preview");
  const before = (await frame.getAttribute("src")) ?? "";
  expect(before).toMatch(new RegExp(`^/api/outputs/${resume.id}/preview\\.pdf\\?v=`));
  const shown = await previewText(page, before);
  expect(shown).toContain(BLANK);
  // The contact header prints the name once; the body's own name line is dropped.
  expect(shown.match(/Juan Dela Cruz/g)?.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Download PDF" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Copy text" })).toBeDisabled();
  await page.screenshot({ path: "test-results/clean-files/preview.png" });
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // Fill the blank, keeping it as a fact.
  const form = page.getByRole("region", { name: /^Needs your input \(1\)/ }).filter({ has: page.getByLabel(BLANK) });
  await form.getByLabel(BLANK).fill("Acme Corp");
  await expect(form.getByLabel("Also save to my facts")).toBeChecked();
  await form.getByRole("button", { name: "Save answers" }).click();
  await expect(page.getByText("Answers saved. 1 also saved to your facts.")).toBeVisible();
  await expect(card.getByText(/^Edited just now · \d+ words$/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Download PDF" })).toBeEnabled();

  await open.click();
  const after = (await frame.getAttribute("src")) ?? "";
  expect(after).not.toBe(before);
  const filled = await previewText(page, after);
  expect(filled).toContain("Acme Corp");
  expect(filled).not.toContain(BLANK);
  await expect(dialog.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PDF" }).click();
  expect((await download).suggestedFilename()).toBe("Juan Dela Cruz - Acme Inc - Resume.pdf");
  await page.keyboard.press("Escape");

  // The answer is a fact now, in the rail, with no key.
  const rail = page.getByRole("region", { name: "Your confirmed facts" });
  await expect(rail.getByText("Filled in while drafting")).toBeVisible();
  await expect(rail.getByText(`${BLANK}: Acme Corp`)).toBeVisible();
  await expect(rail).not.toContainText("FACT-");
});

test("Copy text and the letter view carry no Markdown, markers or blanks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const ws = await seed(page);
  const [fact] = ws.facts;
  if (!fact) throw new Error("no confirmed facts");
  const resume = file(ws, "resume");
  const letter = file(ws, "letter");
  await setBody(
    page,
    resume.id,
    `# Juan Dela Cruz\n## Summary\n- **Built** a payments API in Go [${fact.key}]\n- Led a team of 4 [${fact.key}]`,
  );
  await setBody(
    page,
    letter.id,
    `Dear Acme team,\n\nI **built** a payments API in Go that serves 2M requests a day [${fact.key}].\n\nJuan Dela Cruz`,
  );
  await setIncluded(page, file(ws, "message").id, false);

  await page.goto(`/jobs/${ws.opportunity.id}`);
  const card = page.getByRole("tabpanel", { name: /^Resume/ });
  await card.getByRole("button", { name: "Copy text" }).click();
  await expect(page.getByText("Resume copied.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Built a payments API in Go");
  for (const mark of ["#", "**", "FACT", "[["]) expect(copied).not.toContain(mark);
  // The name prints in the PDF's header, so the copy does not repeat it.
  expect(copied).not.toContain("Juan Dela Cruz");

  // The letter shows its clean text under the card.
  await page.getByRole("tab", { name: "Cover letter" }).click();
  const letterCard = page.getByRole("tabpanel", { name: /^Cover letter/ });
  await expect(letterCard.getByText(/^Edited just now · \d+ words$/)).toBeVisible();
  await expect(letterCard).toContainText("I built a payments API in Go that serves 2M requests a day.");
  for (const mark of ["**", "FACT", "[["]) await expect(letterCard).not.toContainText(mark);

  // The page shows no fact keys anywhere.
  await expect(page.locator("main")).not.toContainText("FACT-");
});

test("Remove drops a Check this sentence from the letter and keeps what was typed in the other blank", async ({
  page,
}) => {
  const ws = await seed(page);
  await setBody(page, file(ws, "resume").id, "## Summary\n- Built a payments API in Go");
  const check = 'Check this: "I led a team of 40" is not backed by your facts';
  await setBody(
    page,
    file(ws, "letter").id,
    `Dear Acme team,\n\nI build payment APIs at [[${BLANK}]]. [[${check}]]\n\nJuan Dela Cruz`,
  );

  await page.goto(`/jobs/${ws.opportunity.id}`);
  await page.getByRole("tab", { name: /^Cover letter/ }).click();
  const card = page.getByRole("tabpanel", { name: /^Cover letter/ });
  const form = card.getByRole("region", { name: /^Needs your input/ });
  await expect(form).toHaveAccessibleName("Needs your input (2)");
  await expect(card).toContainText("I led a team of 40");

  // Typed but not saved yet: Remove must not lose it.
  await form.getByLabel(BLANK).fill("Acme Corp");
  await form.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Sentence removed.")).toBeVisible();

  await expect(form).toHaveAccessibleName("Needs your input (1)");
  await expect(form.getByLabel("Check this sentence")).toHaveCount(0);
  await expect(form.getByLabel(BLANK)).toHaveValue("Acme Corp");
  await expect(card).not.toContainText("I led a team of 40");
  await expect(card.getByText(/· 1 blank$/)).toBeVisible();

  // The stored letter lost the whole placeholder and nothing else.
  const after = await api(page, "GET", `/opportunities/${ws.opportunity.id}`, WorkspaceDto);
  expect(file(after, "letter").body).toBe(`Dear Acme team,\n\nI build payment APIs at [[${BLANK}]].\n\nJuan Dela Cruz`);
});

test("an applied job shows only Preview, Copy and Download", async ({ page }) => {
  const ws = await seed(page);
  const resume = file(ws, "resume");
  await setBody(page, resume.id, "## Summary\n- Built a payments API in Go");
  await setBody(page, file(ws, "letter").id, "Dear Acme team,\n\nI build payment APIs.");
  await setBody(page, file(ws, "message").id, "Hi, I build payment APIs in Go.");
  await api(page, "POST", `/opportunities/${ws.opportunity.id}/questions`, any, { question: "Why Acme?" });
  const withQuestion = await api(page, "GET", `/opportunities/${ws.opportunity.id}`, WorkspaceDto);
  const answer = withQuestion.answers.find((a) => a.question === "Why Acme?");
  if (!answer) throw new Error("the question was not added");
  await setBody(page, answer.id, "Acme runs the payment rails I want to work on.");
  await api(page, "POST", `/opportunities/${ws.opportunity.id}/status`, any, { status: "applied" });

  await page.goto(`/jobs/${ws.opportunity.id}`);
  const drafts = page.getByRole("tabpanel", { name: /^Drafts/ });
  const card = drafts.getByRole("tabpanel", { name: /^Resume/ });
  for (const name of ["Preview PDF", "Copy text", "Download PDF"]) {
    await expect(card.getByRole("button", { name })).toBeVisible();
  }
  for (const name of [/More actions/, "Edit text", "Regenerate", "Mark reviewed", "Save answers", /Draft/]) {
    await expect(drafts.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(drafts.getByRole("textbox")).toHaveCount(0);

  // The answer keeps Copy text only.
  const row = drafts.getByRole("listitem").filter({ hasText: "Why Acme?" });
  await expect(row).toContainText("Acme runs the payment rails I want to work on.");
  await expect(row.getByRole("button")).toHaveText(["Copy text"]);

  // The preview still opens.
  await card.getByRole("button", { name: "Preview PDF" }).click();
  const src = (await page.getByRole("dialog").locator("iframe").getAttribute("src")) ?? "";
  expect(await previewText(page, src)).toContain("Built a payments API in Go");
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the drafts tab passes axe with a letter, its blanks form and the editor open", async ({ page }) => {
      const ws = await seed(page);
      await setBody(page, file(ws, "resume").id, "## Summary\n- Built a payments API in Go");
      const check = 'Check this: "I led a team of 40" is not backed by your facts';
      await setBody(
        page,
        file(ws, "letter").id,
        `Dear Acme team,\n\nI build payment APIs at [[${BLANK}]]. [[${check}]]\n\nJuan Dela Cruz`,
      );

      await page.goto(`/jobs/${ws.opportunity.id}`);
      await page.getByRole("tab", { name: /^Cover letter/ }).click();
      const card = page.getByRole("tabpanel", { name: /^Cover letter/ });
      await expect(card.getByText(/· 2 blanks$/)).toBeVisible();
      await expect(card.getByLabel(BLANK)).toBeVisible();
      await expect(card.getByLabel("Check this sentence")).toHaveValue("I led a team of 40");
      await axeScan(page, `letter card, ${colorScheme}`);
      await page.screenshot({ path: `test-results/clean-files/letter-${colorScheme}.png`, fullPage: true });

      await card.getByRole("button", { name: "More actions for the cover letter" }).click();
      await page.getByRole("menuitem", { name: "Edit text" }).click();
      await expect(card.getByLabel("Cover letter text")).toBeFocused();
      await axeScan(page, `letter editor, ${colorScheme}`);
      await page.screenshot({ path: `test-results/clean-files/letter-editor-${colorScheme}.png`, fullPage: true });
    });
  });
}

/** axe over the page, color contrast included, once animations settle. */
async function axeScan(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const result = await new AxeBuilder({ page }).exclude("iframe").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(problems, label).toEqual([]);
}
