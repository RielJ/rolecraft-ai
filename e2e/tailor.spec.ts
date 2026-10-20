import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { extractText, getDocumentProxy } from "unpdf";
import { AddJobResult, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { E2E_DATABASE_URL } from "../playwright.config";
import { PAREN_CV } from "../test/fixtures/roles-cv";
import { resetTables } from "../test/reset";

// Tailor from the base CV (decision 75, docs/plans/base-cv-tailoring.md): a resume drafted from a
// CV with roles lists its changes under the card; Undo puts the CV's version back in the resume.
// The fake AI's default tailor reply reverses the first role's bullets and shortens Tala's bullet.
// Screenshots land in test-results/tailor/ for a human look.

/** Tala's bullet in the CV, and the fake's shorter reword of it. */
const LONG = "Migrated the API from Express to Hono on Cloudflare Workers.";
const SHORT = "Migrated the API from Express to Hono.";

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

async function axe(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(problems, label).toEqual([]);
}

/** A CV split with AI into roles and facts, all confirmed, and a job drafted as a resume. */
async function seed(page: Page, options: { project?: boolean } = {}): Promise<string> {
  await api(page, "PUT", "/settings/ai-key", any, { provider: "anthropic", key: "sk-ant-tailor-key-ABCD" });
  await api(page, "PUT", "/profile", ProfileDto, {
    contact: { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] },
  });
  await api(page, "PUT", "/profile/cv", ProfileDto, { text: PAREN_CV });
  await expect
    .poll(async () => (await api(page, "GET", "/profile", ProfileDto)).cv?.roles.length, { timeout: 15_000 })
    .toBe(3);
  if (options.project) {
    // A project the CV lacks (decision 82): the fake tailor adds the first one listed.
    await api(page, "POST", "/profile/addons", ProfileDto, {
      kind: "open_source",
      title: "Nyx",
      body: "Nyx is a CLI that schedules Go jobs on Kubernetes.",
      link: "https://github.com/maria/nyx",
      skills: ["Go", "Kubernetes"],
      projectRole: "own",
    });
    await expect
      .poll(async () => (await api(page, "GET", "/profile", ProfileDto)).facts.some((f) => f.text.startsWith("Nyx")), {
        timeout: 15_000,
      })
      .toBe(true);
  }
  await api(page, "POST", "/facts/confirm-all", ProfileDto);
  const { opportunityId } = await api(page, "POST", "/jobs/from-paste", AddJobResult, {
    title: "Senior Backend Engineer",
    company: "Acme Inc",
    description: "Build payment APIs in TypeScript. Remote, worldwide.",
  });
  const task = await api(page, "POST", `/opportunities/${opportunityId}/draft`, TaskDto, { kinds: ["resume"] });
  await expect
    .poll(async () => (await api(page, "GET", `/tasks/${task.id}`, TaskDto)).status, { timeout: 15_000 })
    .toBe("done");
  return opportunityId;
}

async function resumeBody(page: Page, opportunityId: string): Promise<string> {
  const ws = await api(page, "GET", `/opportunities/${opportunityId}`, WorkspaceDto);
  return ws.files.find((f) => f.kind === "resume")?.body ?? "";
}

async function previewText(page: Page, card: Locator): Promise<string> {
  await card.getByRole("button", { name: "Preview PDF" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume preview" });
  const src = (await dialog.locator("iframe").getAttribute("src")) ?? "";
  const res = await page.request.get(src);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(await res.body())), { mergePages: true });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  return text.replace(/\s+/g, " ");
}

test("a tailored resume lists its changes; Undo puts the CV's line back in the PDF; Keep all restores both", async ({
  page,
}) => {
  const opportunityId = await seed(page);
  const ws = await api(page, "GET", `/opportunities/${opportunityId}`, WorkspaceDto);
  const tailoring = ws.files.find((f) => f.kind === "resume")?.tailoring;
  expect(tailoring?.changes.map((c) => c.op)).toEqual(["order", "reword"]);
  const [first, second] = tailoring?.changes[0]?.afterList ?? [];
  expect(first && second).toBeTruthy();
  const tailored = await resumeBody(page, opportunityId);
  expect(tailored.indexOf(first ?? "")).toBeLessThan(tailored.indexOf(second ?? ""));
  expect(tailored).toContain(SHORT);
  expect(tailored).not.toContain(LONG);

  await page.goto(`/jobs/${opportunityId}`);
  const card = page.getByRole("tabpanel", { name: /^Resume/ });
  const changes = card.getByRole("region", { name: "Changes from your CV" });
  await expect(changes.getByText("2 of 2 kept")).toBeVisible();
  await expect(changes.getByText("New order")).toBeVisible();
  await expect(changes.getByText(LONG)).toHaveCSS("text-decoration-line", "line-through");
  await expect(changes.getByRole("button", { name: "Keep all" })).toBeDisabled();
  await axe(page, "resume with its changes");
  await changes.screenshot({ path: "test-results/tailor/changes.png" });
  expect(await previewText(page, card)).toContain(SHORT);

  // Undo the reword: the body and the PDF get the CV's line back; the order stays.
  const reword = changes.getByRole("group", { name: /^Reworded/ });
  await reword.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(changes.getByText("1 of 2 kept")).toBeVisible();
  await expect(reword.getByRole("button", { name: "Undo", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(changes.getByText("Undone. Your CV's version is used.")).toBeVisible();
  const undone = await resumeBody(page, opportunityId);
  expect(undone).toContain(LONG);
  expect(undone.indexOf(first ?? "")).toBeLessThan(undone.indexOf(second ?? ""));
  expect(await previewText(page, card)).toContain(LONG);

  // Undo the order too: the row shows the CV's order, which the resume now uses.
  await changes
    .getByRole("group", { name: /^Reordered/ })
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(changes.getByText("0 of 2 kept")).toBeVisible();
  await expect(changes.getByText("Your CV's order")).toBeVisible();
  await expect(changes.locator("ol > li").first()).toHaveText(second ?? "");
  await axe(page, "resume with its changes undone");
  await changes.screenshot({ path: "test-results/tailor/undone.png" });

  // The decisions survive a reload; Keep all brings the tailored resume back.
  await page.reload();
  await expect(changes.getByText("0 of 2 kept")).toBeVisible();
  await changes.getByRole("button", { name: "Keep all" }).click();
  await expect(changes.getByText("2 of 2 kept")).toBeVisible();
  expect(await resumeBody(page, opportunityId)).toBe(tailored);
});

test("a project the CV lacks is added with its head; Undo takes it out of the PDF", async ({ page }) => {
  const opportunityId = await seed(page, { project: true });
  await page.goto(`/jobs/${opportunityId}`);
  const card = page.getByRole("tabpanel", { name: /^Resume/ });
  const changes = card.getByRole("region", { name: "Changes from your CV" });
  const row = changes.getByRole("group", { name: "Added project, Projects" });
  await expect(changes.getByText("3 of 3 kept")).toBeVisible();
  await expect(changes.getByText("Nyx · github.com/maria/nyx", { exact: true })).toBeVisible();
  await expect(changes.getByText("Nyx is a CLI that schedules Go jobs on Kubernetes.")).toBeVisible();
  await axe(page, "resume with an added project");
  await changes.screenshot({ path: "test-results/tailor/project.png" });
  const pdf = await previewText(page, card);
  expect(pdf).toContain("Projects");
  expect(pdf).toContain("github.com/maria/nyx");

  await row.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(changes.getByText("2 of 3 kept")).toBeVisible();
  await expect(changes.getByText("Undone. The project is left out.")).toBeVisible();
  const undone = await previewText(page, card);
  expect(undone).not.toContain("Nyx");
  expect(await resumeBody(page, opportunityId)).not.toContain("## Projects");
});
