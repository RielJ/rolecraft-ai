import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { extractText, getDocumentProxy } from "unpdf";
import { AddJobResult, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { E2E_DATABASE_URL } from "../playwright.config";
import { PAREN_CV } from "../test/fixtures/roles-cv";
import { resetTables } from "../test/reset";

// Roles (decision 71, docs/plans/roles.md): Read roles for a CV split before roles existed, edit
// and save them, then draft a resume whose job headers come from them. Screenshots land in
// test-results/roles/ for a human look.

test.use({ viewport: { width: 1280, height: 900 } });

async function sql<T>(run: (db: postgres.Sql) => Promise<T>): Promise<T> {
  const db = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

test.beforeEach(() => sql(resetTables));

const any = { parse: (v: unknown) => v };

async function api<T>(page: Page, method: string, path: string, schema: { parse(v: unknown): T }, body?: unknown) {
  const res = await page.request.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return schema.parse(await res.json());
}

/** A CV with role headers, split with AI and confirmed, then its roles deleted: an old CV. */
async function seed(page: Page): Promise<void> {
  await api(page, "PUT", "/settings/ai-key", any, { provider: "anthropic", key: "sk-ant-roles-key-ABCD" });
  await api(page, "PUT", "/profile", ProfileDto, {
    contact: { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] },
  });
  await api(page, "PUT", "/profile/cv", ProfileDto, { text: PAREN_CV });
  await expect
    .poll(async () => (await api(page, "GET", "/profile", ProfileDto)).cv?.roles.length, { timeout: 15_000 })
    .toBe(3);
  await api(page, "POST", "/facts/confirm-all", ProfileDto);
  await sql((db) => db`DELETE FROM roles`);
}

async function axe(page: Page, label: string, exclude?: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
  const result = await (exclude ? builder.exclude(exclude) : builder).analyze();
  const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(problems, label).toEqual([]);
}

test("Read roles from your CV, edit and save them, then draft a resume with their headers", async ({ page }) => {
  await seed(page);
  await page.goto("/profile#cv");
  const roles = page.getByRole("form", { name: "Roles" });
  await expect(roles.getByText("No roles yet.")).toBeVisible();
  await axe(page, "profile, no roles");

  await roles.getByRole("button", { name: "Read roles from your CV" }).click();
  await expect(page.getByText("Reading the roles in your CV.")).toBeVisible();
  const list = roles.getByRole("list", { name: "Roles in your CV" });
  await expect(list.getByRole("listitem")).toHaveCount(3, { timeout: 15_000 });

  const first = list.getByRole("group", { name: "Full-stack Software Engineer at Lakbay Labs" });
  await expect(first.getByLabel("Title")).toHaveValue("Full-stack Software Engineer");
  await expect(first.getByLabel("Company")).toHaveValue("Lakbay Labs");
  await expect(first.getByLabel("Location (optional)")).toHaveValue("Remote");
  await expect(first.getByLabel("Start (optional)")).toHaveValue("Jan, 2026");
  await expect(first.getByLabel("End (optional)")).toHaveValue("Jun, 2026");
  await expect(first.getByText("2 facts")).toBeVisible();
  await expect(list.getByRole("group", { name: "Backend Engineer at Tala.video" }).getByText("1 fact")).toBeVisible();

  // A new role without a title or company is refused in the browser, focused on the first problem.
  await roles.getByRole("button", { name: "Add a role" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await roles.getByRole("button", { name: "Save roles" }).click();
  const blankTitle = list.getByRole("group", { name: "Role 4" }).getByLabel("Title");
  await expect(blankTitle).toBeFocused();
  await expect(list.getByText("Each role needs a title.")).toBeVisible();
  await list.getByRole("button", { name: "Remove Role 4" }).click();

  // Edit one role and remove another, then save.
  await first.getByLabel("Title").fill("Senior Full-stack Engineer");
  await list.getByRole("button", { name: "Remove Software Engineer at Sinag Inc." }).click();
  await expect(roles.getByText("Unsaved changes")).toBeVisible();
  await roles.getByRole("button", { name: "Save roles" }).click();
  await expect(page.getByText("Roles saved.")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(roles.getByText("Unsaved changes")).toBeHidden();

  await page.reload();
  await expect(list.getByRole("group", { name: "Senior Full-stack Engineer at Lakbay Labs" })).toBeVisible();
  await axe(page, "profile with roles");
  await roles.scrollIntoViewIfNeeded();
  await roles.screenshot({ path: "test-results/roles/profile-roles.png" });

  // Draft a resume: the headers are the saved roles, word for word.
  const { opportunityId } = await api(page, "POST", "/jobs/from-paste", AddJobResult, {
    title: "Senior Backend Engineer",
    company: "Acme Inc",
    description: "Build payment APIs in TypeScript. Remote, worldwide.",
  });
  const task = await api(page, "POST", `/opportunities/${opportunityId}/draft`, TaskDto, { kinds: ["resume"] });
  await expect
    .poll(async () => (await api(page, "GET", `/tasks/${task.id}`, TaskDto)).status, { timeout: 15_000 })
    .toBe("done");
  const ws = await api(page, "GET", `/opportunities/${opportunityId}`, WorkspaceDto);
  const resume = ws.files.find((f) => f.kind === "resume");
  expect(resume?.body).toContain("### Senior Full-stack Engineer | Lakbay Labs, Remote | Jan, 2026 – Jun, 2026");
  expect(resume?.body).toContain("### Backend Engineer | Tala.video, Remote, Part-time | Oct, 2025 – Apr, 2026");
  expect(resume?.body).not.toContain("Sinag");

  await page.goto(`/jobs/${opportunityId}`);
  const card = page.getByRole("tabpanel", { name: /^Resume/ });
  await card.getByRole("button", { name: "Preview PDF" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume preview" });
  const src = (await dialog.locator("iframe").getAttribute("src")) ?? "";
  const res = await page.request.get(src);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  const bytes = new Uint8Array(await res.body());
  writeFileSync("test-results/roles/resume-preview.pdf", bytes);
  const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true });
  for (const part of ["Senior Full-stack Engineer", "Jan, 2026 – Jun, 2026", "Lakbay Labs, Remote", "Tala.video"]) {
    expect(text).toContain(part);
  }
  expect(text).not.toContain("###");
  // Headless Chromium draws no PDF in a frame; the PDF itself is saved above for a human look.
  await axe(page, "resume preview", "iframe");
});
