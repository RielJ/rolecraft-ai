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
  await expect(zone).toContainText("Last read from cv.pdf · View");
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

test("confirmed facts group by job: closed past 8 facts, a search opens the groups that match", async ({ page }) => {
  const cv = [
    "EXPERIENCE",
    "Lakbay Labs — Senior Engineer, 2021 to 2024",
    "- Built a billing service in TypeScript and Postgres",
    "- Cut invoice processing time from 40 minutes to 5 minutes",
    "- Mentored 3 junior engineers through code review",
    "- Moved deploys from a VM to Fly.io",
    "",
    "Jeepney Data Co — Engineer, 2018 to 2021",
    "- Loaded 42 routes from Cebu open data into SQLite",
    "- Wrote the route search API in Go",
    "- Ran the weekly on-call rotation",
    "- Added tracing with OpenTelemetry",
  ].join("\n");
  await page.goto("/profile");
  await page.getByLabel("CV text").fill(cv);
  await page.getByRole("button", { name: "Save and split into facts" }).click();
  const review = page.getByRole("list", { name: "Facts to review" });
  await expect(review).toContainText("Wrote the route search API in Go");
  // Outside a group, a fact to review names its job.
  await expect(review.getByText("Jeepney Data Co — Engineer, 2018 to 2021").first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm all" }).click();

  const confirmed = page.getByRole("region", { name: "Confirmed facts" });
  const lakbay = confirmed.locator("details").filter({ hasText: "Lakbay Labs" });
  const jeepney = confirmed.locator("details").filter({ hasText: "Jeepney Data Co" });
  await expect(lakbay.locator("summary")).toContainText("5");
  await expect(jeepney.locator("summary")).toContainText("5");
  await expect(lakbay).not.toHaveAttribute("open");
  await expect(confirmed.getByText("Wrote the route search API in Go")).toBeHidden();

  await jeepney.locator("summary").click();
  await expect(confirmed.getByText("Wrote the route search API in Go")).toBeVisible();
  await jeepney.locator("summary").click();

  await page.getByRole("searchbox", { name: "Search confirmed facts" }).fill("sqlite cebu");
  await expect(confirmed.getByText("Loaded 42 routes from Cebu open data into SQLite")).toBeVisible();
  await expect(lakbay).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search confirmed facts" }).fill("");
  await expect(jeepney).not.toHaveAttribute("open");
});

test("skills used for matching: hide one found in facts, restore it, add your own and remove it", async ({ page }) => {
  // A stored job that names Hasura, read before Hasura was on the list: it asks for Go only.
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    await sql`
      INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, skills,
        content_hash, description_key, eligibility, eligibility_phrase)
      VALUES (${user?.id ?? ""}, 'source', 'Platform Engineer', 'Acme', 'engineer platform', 'acme',
        'Go services behind Hasura. This role is open worldwide.', '{Go}', 'platform', 'platform',
        'worldwide', 'open worldwide')`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const row = page.getByRole("listbox", { name: "Matches" }).getByRole("option", { name: /Platform Engineer/ });

  await page.goto("/profile");
  await page.getByLabel("CV text").fill("- Built a payments API in Go and Postgres");
  await page.getByRole("button", { name: "Save and split into facts" }).click();
  await page.getByRole("button", { name: "Confirm all" }).click();

  const chips = page.getByRole("list", { name: "Skills used for matching" });
  await expect(chips.getByRole("listitem")).toHaveText(["Go", "PostgreSQL", "Add skill"]);

  await chips.getByRole("button", { name: "Hide Go from matching" }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["PostgreSQL", "Add skill"]);
  await page.getByText("Hidden from matching (1)").click();
  await page.getByRole("button", { name: "Restore Go" }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["Go", "PostgreSQL", "Add skill"]);
  await expect(page.getByText(/Hidden from matching/)).toBeHidden();

  // A built-in skill from the picker.
  await chips.getByRole("button", { name: "Add skill" }).click();
  await page.getByRole("searchbox", { name: "Find or type a skill" }).fill("kube");
  await page.getByRole("button", { name: "Kubernetes", exact: true }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["Go", "PostgreSQL", "Kubernetes", "Add skill"]);

  // One of your own, typed in. The stored job gains it at once, with no Refresh (decision 68).
  await chips.getByRole("button", { name: "Add skill" }).click();
  await page.getByRole("searchbox", { name: "Find or type a skill" }).fill("Hasura");
  await page.getByRole("button", { name: "Add “Hasura” as your own skill" }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["Go", "PostgreSQL", "Kubernetes", "Hasura", "Add skill"]);
  await expect(page.getByText(/next Refresh/)).toBeHidden();
  await page.goto("/");
  await expect(row).toContainText("2 of 2 skills");

  await page.goto("/profile");
  await chips.getByRole("button", { name: "Remove Hasura" }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["Go", "PostgreSQL", "Kubernetes", "Add skill"]);
  await page.goto("/");
  await expect(row).toContainText("1 of 1 skills");
});
