import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Slice 13: the Board's "Filtered out" section (decision 53). Seeded straight into the database:
// 52 US-only jobs, one UK-only job, and two role drops from one company board.
// Runs on the playwright config's own port (HB_E2E_PORT, default 3100) and database.

const SALES_URL = "https://boards.greenhouse.io/hooli/jobs/9001";

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeEach(() =>
  withSql(async (sql) => {
    await resetTables(sql);
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const userId = user?.id ?? "";
    const jobs = [
      ...Array.from({ length: 52 }, (_, i) => ({
        title: `US Role ${String(i).padStart(2, "0")}`,
        phrase: "This role is US-only.",
        minutesAgo: 100 - i,
      })),
      { title: "UK Platform Engineer", phrase: "Candidates must be based in the UK.", minutesAgo: 1 },
    ];
    for (const job of jobs) {
      const key = job.title.toLowerCase();
      await sql`
        INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, apply_url, description,
          content_hash, description_key, eligibility, eligibility_phrase, first_seen_at)
        VALUES (${userId}, 'source', ${job.title}, 'Globex', ${key}, 'globex',
          ${`https://example.com/jobs/${encodeURIComponent(key)}`},
          ${`${job.title} at Globex, building the web app in React and TypeScript. ${job.phrase}`}, ${key}, ${key},
          'excluded', ${job.phrase}, now() - ${job.minutesAgo} * interval '1 minute')`;
    }
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO sources (user_id, kind, board, label) VALUES (${userId}, 'greenhouse', 'hooli', 'Hooli')
      RETURNING id`;
    const drops = [
      { id: "9001", title: "Sales Rep", reason: "Title: sales", url: SALES_URL },
      {
        id: "9002",
        title: "Product Designer",
        reason: "Role: Design",
        url: "https://boards.greenhouse.io/hooli/jobs/9002",
      },
    ];
    for (const d of drops) {
      await sql`
        INSERT INTO role_drops (source_id, external_id, user_id, title, company, url, reason, seen_at)
        VALUES (${source?.id ?? ""}, ${d.id}, ${userId}, ${d.title}, 'Hooli', ${d.url}, ${d.reason}, now())`;
    }
  }),
);

const section = (page: Page) => page.getByRole("region", { name: /^Filtered out/ });
const disclosure = (page: Page) => section(page).getByRole("button", { name: /^Filtered out/ });
const search = (page: Page) =>
  section(page).getByRole("searchbox", { name: "Search filtered out by title or company" });

test("collapsed by default with the total; opens to groups by reason with counts, newest 50 each", async ({ page }) => {
  await page.goto("/board");
  // The board itself is empty; the section shows anyway.
  await expect(page.getByText("Nothing on the board yet.")).toBeVisible();
  const toggle = disclosure(page);
  await expect(toggle).toHaveAccessibleName("Filtered out 55");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(search(page)).toHaveCount(0);

  // Keyboard reachable: focus it and press Enter.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(search(page)).toBeVisible();

  const groups = section(page).getByRole("region");
  await expect(groups).toHaveCount(4);
  await expect(groups.nth(0)).toHaveAccessibleName("US only 52");
  await expect(groups.nth(1)).toHaveAccessibleName("UK only 1");
  await expect(groups.nth(2)).toHaveAccessibleName(/^(Role: Design|Title: sales) 1$/);
  const us = section(page).getByRole("region", { name: "US only 52" });
  await expect(us.getByRole("listitem")).toHaveCount(50);
  await expect(us.getByRole("listitem").first()).toContainText("US Role 51");
  await expect(us.getByRole("listitem").last()).toContainText("US Role 02");
  await expect(us.getByText("Showing the newest 50 of 52. Search to find the rest.")).toBeVisible();

  // axe over the open section, color contrast included, once the chevron has turned.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const axe = await new AxeBuilder({ page }).include("section").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // The search spans every item: the two oldest US jobs are past the newest 50.
  await search(page).fill("us role 0");
  await expect(groups).toHaveCount(1);
  await expect(section(page).getByRole("region", { name: "US only 10" })).toBeVisible();
  await expect(section(page).getByText("US Role 00")).toBeVisible();
  // By company too.
  await search(page).fill("hooli");
  await expect(groups).toHaveCount(2);
  await expect(section(page).getByText("Sales Rep")).toBeVisible();
  // The total in the heading is every item, whatever the search.
  await expect(toggle).toHaveAccessibleName("Filtered out 55");

  // Collapsing hides it all again.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(search(page)).toHaveCount(0);
});

test("Show in Matches moves an excluded job out of the section and into Matches", async ({ page }) => {
  await page.goto("/");
  const list = page.getByRole("listbox", { name: "Matches" });
  await expect(page.getByRole("button", { name: "Excluded 53" })).toBeVisible();
  await expect(list.getByRole("option", { name: /UK Platform Engineer/ })).toHaveCount(0);

  await page.goto("/board");
  await disclosure(page).click();
  const uk = section(page).getByRole("region", { name: "UK only 1" });
  await uk.getByRole("button", { name: "Show in Matches" }).click();
  await expect(uk).toHaveCount(0);
  await expect(disclosure(page)).toHaveAccessibleName("Filtered out 54");
  await expect(page.getByText('"UK Platform Engineer" now shows in Matches.')).toBeVisible();

  // After a reload too: the override is stored.
  await page.reload();
  await expect(disclosure(page)).toHaveAccessibleName("Filtered out 54");

  await page.getByRole("link", { name: "Matches" }).first().click();
  await expect(list.getByRole("option", { name: /UK Platform Engineer/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Excluded 52" })).toBeVisible();
});

test("Add by link on a role drop opens the Add a job dialog with its link filled in", async ({ page }) => {
  await page.goto("/board");
  await disclosure(page).click();
  const sales = section(page).getByRole("region", { name: "Title: sales 1" });
  await expect(sales.getByRole("listitem")).toContainText("Sales Rep");
  await expect(sales.getByRole("listitem")).toContainText("Hooli · Hooli");
  // Its name stays short; the row's title says which posting it adds.
  await expect(sales.getByRole("button", { name: "Add by link" })).toHaveAccessibleDescription("Sales Rep");
  await sales.getByRole("button", { name: "Add by link" }).click();

  const dialog = page.getByRole("dialog", { name: "Add a job" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Link to the posting" })).toHaveValue(SALES_URL);

  // Closed and opened from another drop, it fills in that one's link.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await section(page)
    .getByRole("region", { name: "Role: Design 1" })
    .getByRole("button", { name: "Add by link" })
    .click();
  await expect(dialog.getByRole("textbox", { name: "Link to the posting" })).toHaveValue(
    "https://boards.greenhouse.io/hooli/jobs/9002",
  );
});
