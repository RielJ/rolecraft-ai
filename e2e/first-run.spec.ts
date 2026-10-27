import { readFile, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { RefreshDto } from "@/shared/api";
import { E2E_DATABASE_URL, E2E_SOURCES_LOG } from "../playwright.config";
import { resetTables } from "../test/reset";

// Slice 11 acceptance. The server runs with HB_SOURCES=fixture and HB_SOURCES_LOG, so every
// request a refresh makes lands as one `host/path` line in E2E_SOURCES_LOG.

const BUILTINS = ["Jobicy", "Himalayas", "RemoteOK", "We Work Remotely", "Remotive"];

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await writeFile(E2E_SOURCES_LOG, "");
});

async function sourceRequests(): Promise<string[]> {
  return (await readFile(E2E_SOURCES_LOG, "utf8")).split("\n").filter(Boolean);
}

async function latestRefresh(page: Page): Promise<RefreshDto> {
  return RefreshDto.parse(await (await page.request.get("/api/refresh")).json());
}

const checklist = (page: Page) => page.getByRole("region", { name: "Get set up" });
const topBarRefresh = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Refresh/ });
const step = (page: Page, name: string) =>
  checklist(page).getByRole("listitem").filter({ hasText: name }).getByText(name, { exact: false });

test("the first Refresh opens the sources panel, a source turned off is never called, the second syncs", async ({
  page,
}) => {
  // A fresh database shows the checklist on Matches, Board and Profile.
  await page.goto("/");
  await expect(page).toHaveTitle("Rolecraft");
  await expect(page.getByRole("banner").getByText("Rolecraft", { exact: true })).toBeVisible();
  await expect(checklist(page)).toBeVisible();
  await expect(checklist(page)).toContainText("1 of 6 done");
  await page.getByRole("banner").getByRole("link", { name: "Board" }).click();
  await expect(checklist(page)).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "Profile" }).click();
  await expect(checklist(page)).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "Matches" }).click();

  // The first click opens the panel with the five built-ins on, and starts no sync.
  await topBarRefresh(page).click();
  const panel = page.getByRole("dialog", { name: "First refresh" });
  await expect(panel).toBeVisible();
  for (const name of BUILTINS) await expect(panel.getByRole("switch", { name })).toBeChecked();
  await expect(panel.getByRole("link", { name: "Add a company board" })).toHaveAttribute("href", "/sources#add-board");
  expect((await latestRefresh(page)).task).toBeNull();
  expect(await sourceRequests()).toEqual([]);

  // Turn RemoteOK off, then refresh from the panel. The sync runs and never calls RemoteOK.
  await panel.getByRole("switch", { name: "RemoteOK" }).click();
  await expect(panel.getByRole("switch", { name: "RemoteOK" })).not.toBeChecked();
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText(/^Refresh done\./)).toBeVisible();
  const first = await latestRefresh(page);
  expect(first.task?.status).toBe("done");
  expect(first.result?.sources.map((s) => s.label)).not.toContain("RemoteOK");
  const requests = await sourceRequests();
  // The other four built-ins were read: proof the log records this server's requests.
  for (const host of ["jobicy.com", "himalayas.app", "weworkremotely.com", "remotive.com"]) {
    expect(requests.some((r) => r.startsWith(host))).toBe(true);
  }
  expect(requests.filter((r) => r.includes("remoteok.com"))).toEqual([]);

  // Matches now lists jobs, so its checklist gives way to them (section 4: "when no jobs exist").
  // Profile still shows it, with the first-refresh step ticked.
  await expect(page.getByRole("listbox", { name: "Matches" })).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
  await page.getByRole("banner").getByRole("link", { name: "Profile" }).click();
  await expect(checklist(page)).toContainText("2 of 6 done");
  await expect(step(page, "Run your first refresh")).toContainText(", done");

  // The second click syncs directly: no panel, a new task.
  await topBarRefresh(page).click();
  await expect(page.getByRole("dialog", { name: "First refresh" })).toHaveCount(0);
  await expect.poll(async () => (await latestRefresh(page)).task?.id).not.toBe(first.task?.id);
  await expect.poll(async () => (await latestRefresh(page)).task?.status).toBe("done");
  expect((await sourceRequests()).filter((r) => r.includes("remoteok.com"))).toEqual([]);
});

test("each step ticks itself from data, and the checklist disappears when all are done", async ({ page }) => {
  await page.goto("/profile");
  await expect(checklist(page)).toContainText("1 of 6 done");
  await expect(step(page, "Pick your sources")).toContainText(", done");
  // A step's link lands on the section that does it.
  await checklist(page).getByRole("link", { name: "Set targeting" }).click();
  await expect(page).toHaveURL(/\/profile#targeting$/);
  await expect(page.getByLabel(/Target titles/)).toBeInViewport();

  // AI key (the server runs HB_AI=fake, so any key passes the check).
  await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("API key").fill("sk-ant-e2e-key-WXYZ");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("…WXYZ")).toBeVisible();

  // CV and facts.
  await page.getByRole("banner").getByRole("link", { name: "Profile" }).click();
  await expect(checklist(page)).toContainText("2 of 6 done");
  await page.getByLabel("CV text").fill("- Built a payments API in Go\n- Led a team of 4 engineers");
  await page.getByRole("button", { name: "Save and split into facts" }).click();
  await expect(page.getByRole("list", { name: "Facts to review" }).getByRole("listitem")).toHaveCount(2);
  await expect(checklist(page)).toContainText("3 of 6 done");
  await page.getByRole("button", { name: "Confirm all" }).click();
  await expect(checklist(page)).toContainText("4 of 6 done");

  // Targeting: a title and a role family.
  await page.getByLabel(/Target titles/).fill("Engineer");
  await page.getByRole("checkbox", { name: "Engineering" }).click();
  await page.getByRole("button", { name: "Save targeting" }).click();
  await expect(page.getByText("Job targeting saved.")).toBeVisible();
  await expect(checklist(page)).toContainText("5 of 6 done");

  // First refresh, from the checklist's own panel.
  await checklist(page).getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/^Refresh done\./)).toBeVisible();

  // All done: the checklist is gone from Profile, Matches and Board.
  await expect(checklist(page)).toHaveCount(0);
  await page.getByRole("banner").getByRole("link", { name: "Matches" }).click();
  await expect(page.getByRole("listbox", { name: "Matches" })).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
  await page.getByRole("banner").getByRole("link", { name: "Board" }).click();
  await expect(page.getByText("Nothing on the board yet.")).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
});
