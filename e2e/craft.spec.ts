import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { MatchList, ProfileDto, RefreshDto, SavedJob } from "@/shared/api";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

/*
 * Craft floor (section 4) in both themes: axe (including rendered color contrast), themed
 * selection, scrollbar and caret, a visible ring on every focus stop, and the empty, loading and
 * error states. Screenshots land in test-results/craft/ for a human look.
 */

const SCHEMES = ["light", "dark"] as const;

/** "/" is Matches; other paths become file-name slugs. */
const slug = (path: string) => (path === "/" ? "matches" : path.slice(1).replace(/\//g, "-"));

async function reset(): Promise<void> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function api<T>(page: Page, method: string, path: string, schema: { parse(v: unknown): T }, body?: unknown) {
  const res = await page.request.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return schema.parse(await res.json());
}

/** A profile with facts, one finished refresh, and one saved job: every screen has content. */
async function seed(page: Page): Promise<string> {
  const any = { parse: (v: unknown) => v };
  await api(page, "PUT", "/settings/ai-key", any, { provider: "anthropic", key: "sk-ant-craft-key-ABCD" });
  await api(page, "PUT", "/profile", ProfileDto, {
    contact: {
      fullName: "Juan Dela Cruz",
      email: "juan@example.ph",
      phone: "",
      location: "Manila",
      links: [],
    },
    targeting: { targetTitles: ["Engineer"], roleFamilies: ["engineering"] },
  });
  await api(page, "PUT", "/profile/cv", ProfileDto, {
    text: "- Built a payments API in Go serving 2M requests a day\n- Led a team of 4 engineers",
  });
  await expect
    .poll(async () => (await api(page, "GET", "/profile", ProfileDto)).facts.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await api(page, "POST", "/facts/confirm-all", ProfileDto);
  await api(page, "POST", "/refresh", any);
  await expect
    .poll(async () => (await api(page, "GET", "/refresh", RefreshDto)).task?.status, { timeout: 30_000 })
    .toBe("done");
  const { jobs } = await api(page, "GET", "/matches", MatchList);
  const [first] = jobs;
  if (!first) throw new Error("the fixture refresh found no jobs");
  const saved = await api(page, "POST", `/jobs/${first.id}/save`, SavedJob);
  return saved.opportunityId;
}

/** axe over the page, color contrast included, after open and close animations finish. */
async function axe(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(problems, label).toEqual([]);
}

/** Tab through the first stops and check each draws an outline or a ring. */
async function focusRings(page: Page, label: string, stops = 12): Promise<void> {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { name: "body", visible: true };
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const shadow = style.boxShadow !== "none" && style.boxShadow !== "";
      const name = `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}"`;
      return { name, visible: outline || shadow };
    });
    expect(ring.visible, `${label}: focus ring on ${ring.name}`).toBe(true);
  }
}

async function themedSurfaces(page: Page, label: string): Promise<void> {
  const surfaces = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.querySelector("h1") ?? document.body;
    return {
      selection: getComputedStyle(probe, "::selection").backgroundColor,
      selectionVar: root.getPropertyValue("--selection").trim(),
      scrollbar: root.scrollbarColor,
      caret: getComputedStyle(document.body).caretColor,
      bodyText: getComputedStyle(document.body).color,
    };
  });
  // The browser default selection is a system blue; ours comes from --selection.
  expect(surfaces.selectionVar, label).not.toBe("");
  expect(surfaces.selection, label).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
  expect(surfaces.scrollbar, label).not.toBe("auto");
  expect(surfaces.caret, label).not.toBe(surfaces.bodyText);
}

for (const colorScheme of SCHEMES) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("fresh database: the empty states and the setup checklist", async ({ page }) => {
      await reset();
      for (const [path, empty] of [
        ["/", "Get set up"],
        ["/board", "Nothing on the board yet"],
        ["/profile", "Upload your CV or paste it"],
        ["/sources", "No company boards yet"],
        ["/settings", "$0.00"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByText(empty).first()).toBeVisible();
        await axe(page, `${path} empty, ${colorScheme}`);
        await page.screenshot({ path: `test-results/craft/empty-${slug(path)}-${colorScheme}.png` });
      }
      await page.goto("/");
      await page.getByRole("banner").getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByRole("dialog", { name: "First refresh" })).toBeVisible();
      await axe(page, `first refresh panel, ${colorScheme}`);
      await page.screenshot({ path: `test-results/craft/first-refresh-panel-${colorScheme}.png` });
    });

    test("every screen with content: axe, focus rings, themed browser surfaces", async ({ page }) => {
      await reset();
      await page.goto("/");
      const opportunityId = await seed(page);
      for (const path of ["/", "/board", "/profile", "/sources", "/settings", `/jobs/${opportunityId}`]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await axe(page, `${path}, ${colorScheme}`);
        const name = path.startsWith("/jobs/") ? "workspace" : slug(path);
        await page.screenshot({ path: `test-results/craft/${name}-${colorScheme}.png`, fullPage: true });
        await themedSurfaces(page, `${path}, ${colorScheme}`);
        await focusRings(page, `${path}, ${colorScheme}`);
      }
    });

    test("loading and error states name the problem and offer Retry", async ({ page }) => {
      await reset();
      // The page's clock, so the test can skip the retry backoff (1 s, then 2 s) instead of waiting it out.
      // It runs in real time otherwise; fastForward only jumps it ahead.
      await page.clock.install();
      const screens = [
        { path: "/", api: /\/api\/matches(\?|$)/, error: "Could not load matches." },
        { path: "/board", api: /\/api\/board$/, error: "Could not load your board." },
        { path: "/profile", api: /\/api\/profile$/, error: "Could not load your profile." },
        { path: "/sources", api: /\/api\/sources$/, error: "Could not load sources." },
        { path: "/settings", api: /\/api\/settings$/, error: "Could not load settings." },
      ];
      for (const screen of screens) {
        let requests = 0;
        await page.route(screen.api, (route) => {
          requests += 1;
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }),
          });
        });
        await page.goto(screen.path);
        const alert = page.getByRole("alert").filter({ hasText: screen.error });
        // Queries retry server errors twice before showing the banner: three requests in all. Each poll
        // moves the page's clock past the next backoff timer, whenever the page has set it.
        await expect
          .poll(
            async () => {
              await page.clock.fastForward(500);
              return requests;
            },
            { intervals: [50], timeout: 15_000 },
          )
          .toBe(3);
        await expect(alert).toBeVisible();
        expect(requests, `${screen.path}: the first try and two retries`).toBe(3);
        await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
        await axe(page, `${screen.path} error, ${colorScheme}`);
        await page.screenshot({ path: `test-results/craft/error-${slug(screen.path)}-${colorScheme}.png` });
        await page.unroute(screen.api);
      }

      // Loading: hold the profile request and read the placeholder.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/profile", async (route) => {
        await held;
        await route.continue();
      });
      await page.goto("/profile");
      await expect(page.getByText("Loading your profile…")).toBeVisible();
      release();
      await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
    });
  });
}
