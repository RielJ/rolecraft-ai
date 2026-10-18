import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, test as base, chromium, expect, type Page, type Worker } from "@playwright/test";
import { z } from "zod";

// Playwright fixtures for the extension run: a persistent Chromium context with the built
// extension loaded, routes that serve the job application fixture, and helpers that place the
// panel where Chrome's side panel would be.
//
// Two things Chrome does not let a test do, and how this file works around them:
// - The side panel cannot be opened or driven by automation. The panel is panel.html opened in a
//   tab of the job's own window, behind the job tab. Its `chrome.tabs.query({ active: true,
//   currentWindow: true })` then finds the job tab, as it does from the real side panel.
// - `chrome.permissions.request` shows a native prompt that Playwright cannot click. The test
//   copy of the extension lists the endpoint and the approved fixture origin as install-time
//   `host_permissions`, so the panel's request resolves "granted" without a prompt. Every other
//   origin stays optional and ungranted. The prompt itself is a manual check (docs/EXTENSION.md).

/** The job site the user approves in the happy path. Served by a route, never the network. */
export const APPROVED_ORIGIN = "https://jobs.hb-fixture.test";
/** A job site the user never approved. */
export const UNAPPROVED_ORIGIN = "https://other.hb-fixture.test";

const BUILT_EXTENSION = resolve("dist-extension");
const FIXTURES = join(import.meta.dirname, "fixtures");
const APPLICATION_HTML = readFileSync(join(FIXTURES, "application.html"), "utf8");
const FRAME_HTML = readFileSync(join(FIXTURES, "frame.html"), "utf8");
const JOB_SITES = /^https:\/\/(?:jobs|other)\.hb-fixture\.test\//;

/** Install-time grants in the test copy only. The shipped manifest has none. */
const PRE_GRANTED_ORIGINS = ["http://localhost/*", `${APPROVED_ORIGIN}/*`] as const;

const Manifest = z.looseObject({
  manifest_version: z.literal(3),
  optional_host_permissions: z.array(z.string()),
});

/** Copy dist-extension to a temp dir and add the two install-time grants to its manifest. */
function testCopyOfExtension(): string {
  try {
    statSync(join(BUILT_EXTENSION, "manifest.json"));
  } catch {
    throw new Error("dist-extension/manifest.json is missing. Run `bun run build:extension` first.");
  }
  const dir = join(mkdtempSync(join(tmpdir(), "hb-extension-e2e-")), "extension");
  cpSync(BUILT_EXTENSION, dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (Object.hasOwn(manifest, "host_permissions")) {
    throw new Error("The shipped manifest declares host_permissions. It must ask for origins at runtime only.");
  }
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, host_permissions: PRE_GRANTED_ORIGINS }, null, 2));
  return dir;
}

export const TabRef = z.object({ tabId: z.number().int().min(0), windowId: z.number().int().min(0) });
export type TabRef = z.infer<typeof TabRef>;

/** The loaded extension: its service worker, its id, and the tab helpers the spec needs. */
export class ExtensionHarness {
  constructor(
    readonly context: BrowserContext,
    readonly worker: Worker,
    readonly id: string,
  ) {}

  get panelUrl(): string {
    return `chrome-extension://${this.id}/panel.html`;
  }

  /** Run `open`, then wait for a page this context did not have before, at `url`. */
  private async newPageAt(url: string, open: () => Promise<unknown>): Promise<Page> {
    const before = new Set(this.context.pages());
    await open();
    let found: Page | undefined;
    await expect
      .poll(() => {
        found = this.context.pages().find((p) => !before.has(p) && p.url() === url);
        return found !== undefined;
      })
      .toBe(true);
    if (found === undefined) throw new Error(`no new page at ${url}`);
    await found.waitForLoadState();
    return found;
  }

  /** panel.html in a window of its own: for pairing, which does not depend on the active tab. */
  async openPanel(): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(this.panelUrl);
    return page;
  }

  /** Open `url` in a new focused window. Works for origins the extension cannot read. */
  async openWindow(url: string): Promise<{ page: Page; tab: TabRef }> {
    let tab: TabRef | undefined;
    const page = await this.newPageAt(url, async () => {
      tab = TabRef.parse(
        await this.worker.evaluate(async (target) => {
          const win = await chrome.windows.create({ url: target, focused: true });
          return { tabId: win?.tabs?.[0]?.id, windowId: win?.id };
        }, url),
      );
    });
    if (tab === undefined) throw new Error("the window did not open");
    return { page, tab };
  }

  /** The one tab at `url`. Only finds origins the extension holds host access to. */
  async tabAt(url: string): Promise<TabRef> {
    const tabs = z.array(TabRef).parse(
      await this.worker.evaluate(async (target) => {
        const found = await chrome.tabs.query({});
        return found.filter((t) => t.url === target).map((t) => ({ tabId: t.id, windowId: t.windowId }));
      }, url),
    );
    const [tab, ...rest] = tabs;
    if (tab === undefined || rest.length > 0) throw new Error(`expected one tab at ${url}, found ${tabs.length}`);
    return tab;
  }

  /**
   * panel.html as a background tab in the job tab's window, where the side panel would be. The
   * job tab stays the active tab of that window.
   */
  async openPanelBeside(tab: TabRef): Promise<Page> {
    return this.newPageAt(this.panelUrl, () =>
      this.worker.evaluate(
        ({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }).then(() => undefined),
        { windowId: tab.windowId, url: this.panelUrl },
      ),
    );
  }

  /** Everything the extension keeps in chrome.storage.local and chrome.storage.session. */
  async storage(): Promise<{ local: Record<string, unknown>; session: Record<string, unknown> }> {
    return this.worker.evaluate(async () => ({
      local: await chrome.storage.local.get(null),
      session: await chrome.storage.session.get(null),
    }));
  }
}

const EXTENSION_LOAD_TIMEOUT_MS = 15_000;

export const test = base.extend<{ extension: ExtensionHarness }>({
  context: async ({ baseURL }, use) => {
    const extensionDir = testCopyOfExtension();
    const profileDir = mkdtempSync(join(tmpdir(), "hb-extension-profile-"));
    // `channel: "chromium"` runs full Chromium in the new headless mode, which loads extensions.
    // The default headless shell does not. HEADED=1 shows the window for debugging.
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      headless: process.env.HEADED !== "1",
      ...(baseURL === undefined ? {} : { baseURL }),
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    await context.route(JOB_SITES, (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: "text/html", body: path.endsWith("/frame") ? FRAME_HTML : APPLICATION_HTML });
    });
    await use(context);
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(resolve(extensionDir, ".."), { recursive: true, force: true });
  },

  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },

  extension: async ({ context }, use, testInfo) => {
    const ours = (w: Worker) => w.url().startsWith("chrome-extension://") && w.url().endsWith("/background.js");
    const worker =
      context.serviceWorkers().find(ours) ??
      (await context
        .waitForEvent("serviceworker", { predicate: ours, timeout: EXTENSION_LOAD_TIMEOUT_MS })
        .catch(() => null));
    testInfo.skip(
      worker === null,
      "Chromium did not start the extension's service worker. Headless extension loading needs " +
        '`channel: "chromium"` and Playwright\'s full Chromium build (`bunx playwright install chromium`). ' +
        "Follow the manual run in docs/EXTENSION.md instead.",
    );
    if (worker === null) return;
    await use(new ExtensionHarness(context, worker, new URL(worker.url()).host));
  },
});

export { expect };
