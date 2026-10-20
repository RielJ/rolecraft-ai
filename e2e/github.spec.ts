import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { ProfileDto } from "@/shared/api";
import { E2E_DATABASE_URL, E2E_GIT_EMAIL, E2E_GITHUB_DIR, E2E_PROJECTS_DIR } from "../playwright.config";
import { makeFileRepo, makeRepo } from "../test/git-repos";
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
  await rm(E2E_PROJECTS_DIR, { recursive: true, force: true });
  await mkdir(E2E_PROJECTS_DIR, { recursive: true });
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
  const confirmed = page.getByRole("region", { name: "Confirmed facts" });
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

test("a private repo's facts show only its name and a lock badge", async ({ page }) => {
  await seed(page, "https://github.com/juandc/sari-ledger");
  await page.goto("/profile");
  const addons = page.getByRole("list", { name: "Add-ons" });
  await addons.getByRole("button", { name: "Read from GitHub" }).click();
  const review = page.getByRole("list", { name: "Facts to review" });
  const evidence = review.getByText("juandc/sari-ledger", { exact: true });
  await expect(evidence.first()).toBeVisible({ timeout: 15_000 });
  await expect(addons.getByText("Private repo")).toBeVisible();
  // Decision 81: no path, sha or link of a private repo is shown.
  await expect(review.getByRole("link", { name: /^Evidence: / })).toHaveCount(0);
  await expect(review).not.toContainText(/commit [0-9a-f]{7}/);
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

test("find my projects → pick a repo, a hidden repo and a folder → all become add-ons", async ({ page }) => {
  // A fork the rules hide, and the user's profile README repo.
  await writeFile(
    join(E2E_GITHUB_DIR, "forked-lib.json"),
    JSON.stringify({ owner: "juandc", repo: "forked-lib", fork: true, description: "A fork", files: {} }),
  );
  await writeFile(
    join(E2E_GITHUB_DIR, "juandc.json"),
    JSON.stringify({ owner: "juandc", repo: "juandc", sizeKb: 2, files: {} }),
  );
  // A local folder of the user's, a clone of jeep-route, and someone else's library.
  await makeRepo(join(E2E_PROJECTS_DIR, "kain-tayo"), { commits: { [E2E_GIT_EMAIL]: 9 } });
  await writeFile(join(E2E_PROJECTS_DIR, "kain-tayo", "README.md"), "# Kain Tayo\n\nRecipe planner for carinderias.");
  await writeFile(join(E2E_PROJECTS_DIR, "kain-tayo", "go.mod"), "module kain");
  await makeRepo(join(E2E_PROJECTS_DIR, "jeep-route"), {
    commits: { [E2E_GIT_EMAIL]: 6 },
    remote: "git@github.com:juandc/jeep-route.git",
  });
  await makeRepo(join(E2E_PROJECTS_DIR, "their-lib"), { commits: { "maria@example.ph": 8 } });
  const ok = await page.request.put("/api/settings/ai-key", {
    data: { provider: "anthropic", key: "sk-ant-github-key-ABCD" },
  });
  expect(ok.ok()).toBe(true);
  await api(page, "PUT", "/profile", {
    contact: { fullName: "Juan Dela Cruz", email: "", phone: "", location: "", links: ["https://github.com/juandc"] },
  });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Find my projects" }).click();

  const dialog = page.getByRole("dialog", { name: "Find my projects" });
  const onGithub = dialog.getByRole("region", { name: "On GitHub · juandc" });
  const shown = onGithub.getByRole("list", { name: "Shown" });
  await expect(shown.getByRole("listitem")).toHaveCount(2);
  // The local clone's commits show on the GitHub repo; the folder isn't listed twice.
  await expect(shown.getByRole("listitem").first()).toContainText("jeep-route");
  await expect(shown.getByRole("listitem").first()).toContainText("6 commits by you locally");
  await expect(shown.getByRole("listitem").filter({ hasText: "sari-ledger" })).toContainText("Private");
  await expect(onGithub.getByRole("list", { name: "Hidden by rules" })).toBeHidden();

  // The hidden group opens, and a hidden repo can still be picked.
  await onGithub.getByText("Hidden by rules: 1 fork, your profile README").click();
  const hidden = onGithub.getByRole("list", { name: "Hidden by rules" });
  await expect(hidden.getByRole("listitem").filter({ hasText: "forked-lib" })).toContainText("Fork");

  const local = dialog.getByRole("region", { name: `In ${E2E_PROJECTS_DIR}` });
  const folders = local.getByRole("list", { name: "Shown" });
  await expect(folders.getByRole("listitem").first()).toContainText("kain-tayo");
  await expect(folders.getByRole("listitem").first()).toContainText("Go · 9 commits by you");
  await expect(folders.getByRole("listitem").first()).toContainText("Recipe planner for carinderias.");
  await expect(folders).toContainText("1 folder is a clone of a repo below, so it shows there.");
  await local.getByText("Hidden by rules: 1 mostly by others").click();
  await expect(local.getByRole("list", { name: "Hidden by rules" })).toContainText("their-lib");

  // The rules, the badges and the hidden group pass axe in both themes.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const result = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(problems, scheme).toEqual([]);
  }

  await dialog.getByRole("checkbox", { name: "jeep-route" }).check();
  await dialog.getByRole("checkbox", { name: "forked-lib" }).check();
  await dialog.getByRole("checkbox", { name: "kain-tayo" }).check();
  await expect(dialog).toContainText("3 picked");
  await dialog.getByRole("button", { name: "Add 3 projects" }).click();
  await expect(dialog).toBeHidden();

  const addons = page.getByRole("list", { name: "Add-ons" });
  await expect(addons.getByRole("listitem").filter({ hasText: "jeep-route" })).toContainText("github.com");
  await expect(addons.getByRole("listitem").filter({ hasText: "forked-lib" })).toBeVisible();
  await expect(addons.getByRole("listitem").filter({ hasText: "kain-tayo" })).toBeVisible();
  const review = page.getByRole("list", { name: "Facts to review" });
  await expect(review).toContainText("Jeepney route planner for Cebu City", { timeout: 15_000 });
  await expect(review).toContainText("Recipe planner for carinderias.");

  // Reopening marks them added; they can't be picked again.
  await page.getByRole("button", { name: "Find my projects" }).click();
  await expect(dialog.getByRole("checkbox", { name: "kain-tayo" })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "jeep-route" })).toBeDisabled();
  await expect(shown.getByRole("listitem").filter({ hasText: "jeep-route" })).toContainText("Added");
});

test("fill the add-on form from a private repo link and a folder path; save keeps the link out of exports", async ({
  page,
}) => {
  await api(page, "PUT", "/profile", {
    contact: { fullName: "Juan Dela Cruz", email: "", phone: "", location: "", links: ["https://github.com/juandc"] },
  });
  await makeRepo(join(E2E_PROJECTS_DIR, "kain-tayo"), { commits: { [E2E_GIT_EMAIL]: 9 } });
  await writeFile(join(E2E_PROJECTS_DIR, "kain-tayo", "README.md"), "# Kain Tayo\n\nRecipe planner for carinderias.");
  await writeFile(join(E2E_PROJECTS_DIR, "kain-tayo", "go.mod"), "module kain");

  await page.goto("/profile");
  await page.getByRole("button", { name: "Add an add-on" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an add-on" });
  const source = dialog.getByLabel("Fill from a project (optional)");

  // A folder, then a link: the second fill replaces the first.
  await source.fill(join(E2E_PROJECTS_DIR, "kain-tayo"));
  await source.press("Enter");
  await expect(dialog.getByLabel("What you did")).toHaveValue("Recipe planner for carinderias.");
  await expect(dialog.getByLabel("Title")).toHaveValue("kain-tayo");
  await expect(dialog.getByRole("radio", { name: "Open source" })).toBeChecked();

  await source.fill("https://example.com/x");
  await dialog.getByRole("button", { name: "Fill" }).click();
  await expect(dialog).toContainText("Paste a GitHub or GitLab link, or a folder path starting with / or ~/.");

  await source.fill("github.com/juandc/sari-ledger");
  await dialog.getByRole("button", { name: "Fill" }).click();
  await expect(dialog.getByLabel("Title")).toHaveValue("sari-ledger");
  await expect(dialog.getByLabel("Link (optional)")).toHaveValue("https://github.com/juandc/sari-ledger");
  await expect(dialog.getByLabel(/^Skills/)).toHaveValue("Go");

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const result = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(problems, scheme).toEqual([]);
  }

  // A fill turns on Read for facts; without it the add-on is only split.
  const read = dialog.getByRole("checkbox", { name: "Read for facts" });
  await expect(read).toBeChecked();
  await read.uncheck();
  await dialog.getByRole("button", { name: "Save and split into facts" }).click();
  await expect(dialog).toBeHidden();
  const addon = page.getByRole("list", { name: "Add-ons" }).getByRole("listitem").filter({ hasText: "sari-ledger" });
  await expect(addon.getByText("Private repo")).toBeVisible();
});

test("find my projects with Read each project for facts → a repo and a folder are read, one at a time", async ({
  page,
}) => {
  await makeFileRepo(join(E2E_PROJECTS_DIR, "kain-tayo"), {
    commits: [
      {
        email: E2E_GIT_EMAIL,
        subject: "feat: weekly menu",
        files: { "README.md": "# Kain Tayo\n\nRecipe planner for carinderias.", "menu.go": "package main\n" },
      },
      {
        email: E2E_GIT_EMAIL,
        subject: "feat: shopping list",
        files: { "list.go": "package main\n\nfunc List() {}\n" },
      },
      // Five commits of the user's, so the scan shows it.
      ...["prices", "servings", "leftovers"].map((what) => ({
        email: E2E_GIT_EMAIL,
        subject: `feat: ${what}`,
        files: { [`${what}.go`]: `package main\n\n// ${what}\n` },
      })),
    ],
  });
  const ok = await page.request.put("/api/settings/ai-key", {
    data: { provider: "anthropic", key: "sk-ant-github-key-ABCD" },
  });
  expect(ok.ok()).toBe(true);
  await api(page, "PUT", "/profile", {
    contact: { fullName: "Juan Dela Cruz", email: "", phone: "", location: "", links: ["https://github.com/juandc"] },
  });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Find my projects" }).click();
  const dialog = page.getByRole("dialog", { name: "Find my projects" });
  await dialog.getByRole("checkbox", { name: "jeep-route" }).check();
  await dialog.getByRole("checkbox", { name: "kain-tayo" }).check();

  const read = dialog.getByRole("checkbox", { name: "Read each project for facts" });
  await expect(read).not.toBeChecked();
  await read.check();
  await expect(dialog).toContainText(/2 reads, at most \$\d+\.\d\d with AI\. They run one at a time after adding\./);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const result = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(problems, scheme).toEqual([]);
  }
  await dialog.getByRole("button", { name: "Add 2 projects" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Added 2 projects. Reading 2 projects for facts, one at a time.")).toBeVisible();

  // Each add-on shows its own read, and ends ready to re-read.
  const addons = page.getByRole("list", { name: "Add-ons" });
  for (const name of ["jeep-route", "kain-tayo"]) {
    const item = addons.getByRole("listitem").filter({ hasText: name });
    await expect(item.getByRole("button", { name: "Re-read" })).toBeVisible({ timeout: 20_000 });
  }
  const folder = addons.getByRole("listitem").filter({ hasText: "kain-tayo" });
  await expect(folder).toContainText(E2E_PROJECTS_DIR);
  await expect(page.getByRole("list", { name: "Facts to review" })).toContainText("feat: shopping list");
});
