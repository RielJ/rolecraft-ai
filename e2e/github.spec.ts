import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { ProfileDto } from "@/shared/api";
import { E2E_DATABASE_URL, E2E_GITHUB_DIR } from "../playwright.config";
import { resetTables } from "../test/reset";

/*
 * Read from GitHub (slice 14) with the fake AI and the fixture reader: read → pending facts with
 * evidence links → confirm one by one; a private repo shows a lock; Re-read lists a confirmed fact
 * the repo no longer backs and asks before removing it.
 */

const FIXTURES = join(import.meta.dirname, "../test/fixtures/github");

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await rm(E2E_GITHUB_DIR, { recursive: true, force: true });
  await mkdir(E2E_GITHUB_DIR, { recursive: true });
  await cp(FIXTURES, E2E_GITHUB_DIR, { recursive: true });
});

async function api(page: Page, method: string, path: string, body?: unknown): Promise<ProfileDto> {
  const res = await page.request.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return ProfileDto.parse(await res.json());
}

async function seed(page: Page, link: string) {
  const ok = await page.request.put("/api/settings/ai-key", {
    data: { provider: "anthropic", key: "sk-ant-github-key-ABCD" },
  });
  expect(ok.ok()).toBe(true);
  await api(page, "PUT", "/profile", {
    contact: { fullName: "Juan Dela Cruz", email: "", phone: "", location: "", links: ["https://github.com/juandc"] },
  });
  await api(page, "POST", "/profile/addons", {
    kind: "open_source",
    title: "Side project",
    body: "Weekend project.",
    link,
  });
}

test("read a repo → facts with evidence links → confirm one; Re-read asks before removing", async ({ page }) => {
  await seed(page, "https://github.com/juandc/jeep-route");
  await page.goto("/profile");
  const addons = page.getByRole("list", { name: "Add-ons" });
  await addons.getByRole("button", { name: "Read from GitHub" }).click();

  const review = page.getByRole("list", { name: "Facts to review" });
  const routes = review.getByRole("listitem").filter({ hasText: "Load 42 routes from Cebu open data into SQLite" });
  await expect(routes).toBeVisible({ timeout: 15_000 });
  await expect(addons).toContainText("as juandc (from profile link)");
  // Every fact links to the file or commit it came from.
  await expect(
    routes.getByRole("link", { name: /^Evidence: commit [0-9a-f]{7} in juandc\/jeep-route$/ }),
  ).toHaveAttribute("href", /^https:\/\/github\.com\/juandc\/jeep-route\/commit\/[0-9a-f]{40}$/);
  await expect(review.getByRole("link", { name: "Evidence: README.md in juandc/jeep-route" })).toHaveAttribute(
    "href",
    "https://github.com/juandc/jeep-route/blob/main/README.md",
  );
  await expect(review).not.toContainText("Fix typo in README");
  await expect(page.getByText("Private", { exact: true })).toHaveCount(0);

  // Confirm one by one.
  await routes.getByRole("button", { name: "Confirm" }).click();
  const confirmed = page.getByRole("list", { name: "Confirmed facts" });
  await expect(confirmed).toContainText("Load 42 routes from Cebu open data into SQLite");

  // The repo moves on: that commit is gone. Re-read keeps it until the user decides.
  const file = join(E2E_GITHUB_DIR, "jeep-route.json");
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  snapshot.commits = snapshot.commits.filter((c: { message: string }) => !c.message.includes("42 routes"));
  await writeFile(file, JSON.stringify(snapshot));
  await addons.getByRole("button", { name: "Re-read" }).click();
  const vanished = page.getByRole("list", { name: "Not in the latest GitHub read of Side project" });
  await expect(vanished).toContainText("Load 42 routes from Cebu open data into SQLite", { timeout: 15_000 });
  await expect(addons).toContainText("1 to keep or delete");
  await vanished.getByRole("button", { name: "Keep" }).click();
  await expect(vanished).toBeHidden();
  await expect(confirmed).toContainText("Load 42 routes from Cebu open data into SQLite");
});

test("a private repo's facts carry a lock badge", async ({ page }) => {
  await seed(page, "https://github.com/juandc/sari-ledger");
  await page.goto("/profile");
  const addons = page.getByRole("list", { name: "Add-ons" });
  await addons.getByRole("button", { name: "Read from GitHub" }).click();
  const review = page.getByRole("list", { name: "Facts to review" });
  const evidence = review.getByRole("link", { name: /^Evidence: / });
  await expect(evidence.first()).toBeVisible({ timeout: 15_000 });
  await expect(addons.getByText("Private repo")).toBeVisible();
  // Every GitHub fact is private; the add-on's own text fact is not.
  await expect(review.getByText("Private", { exact: true })).toHaveCount(await evidence.count());
  await expect(review.getByRole("listitem").filter({ hasText: "Weekend project." })).not.toContainText("Private");

  // The read summary, evidence links and lock badges pass axe in both themes.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await expect(evidence.first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(problems, scheme).toEqual([]);
  }
});
