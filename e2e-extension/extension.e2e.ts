import type { Page } from "@playwright/test";
import { AddJobResult, ProfileDto } from "@/shared/api";
import {
  addJob,
  boardStatus,
  JOB,
  PROFILE,
  pairingCodeFromApi,
  pairingCodeFromSettings,
  pairPanel,
  prepareResume,
  resetDatabase,
  StoppableServer,
  seedProfile,
  sessionRows,
  startSession,
} from "./app";
import { APPROVED_ORIGIN, type ExtensionHarness, expect, test, UNAPPROVED_ORIGIN } from "./fixtures";
import { EXTENSION_E2E_PORT, STOPPABLE_SERVER_PORT } from "./server-env";

// Chrome extension (docs/EXTENSION.md): the built extension, end to end, against the real
// server. The panel is panel.html in a tab beside the job (see fixtures.ts for why), and the job
// site is a fixture served by a Playwright route.

const ENDPOINT = `http://localhost:${EXTENSION_E2E_PORT}`;
const APPLY_URL = `${APPROVED_ORIGIN}/acme/platform-engineer/apply?source=rolecraft`;

test.beforeEach(resetDatabase);

/** The fixture form's values, by input id. */
async function formValues(job: Page) {
  return job.evaluate(() => {
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? null;
    const resume = document.getElementById("resume") as HTMLInputElement | null;
    return {
      first: value("first"),
      last: value("last"),
      email: value("email"),
      phone: value("phone"),
      salary: value("salary"),
      files: resume?.files?.length ?? 0,
    };
  });
}

const UNTOUCHED = {
  first: "",
  last: "",
  email: "",
  phone: "+63 2 8123 4567",
  salary: "",
  files: 0,
} as const;

/** Pair in a panel of its own, then close it. */
async function pair(extension: ExtensionHarness, { endpoint, code }: { endpoint: string; code: string }) {
  const panel = await extension.openPanel();
  await pairPanel(panel, { endpoint, code });
  await panel.close();
}

/** Seed, pair, and record an Apply session for a job at `applyUrl`, without the workspace popup. */
async function pairedWithSession({
  page,
  extension,
  applyUrl,
}: {
  page: Page;
  extension: ExtensionHarness;
  applyUrl: string;
}): Promise<string> {
  await seedProfile(page.request);
  const opportunityId = await addJob(page.request, applyUrl);
  await pair(extension, { endpoint: ENDPOINT, code: await pairingCodeFromApi(page.request, ENDPOINT) });
  await startSession(page.request, ENDPOINT, opportunityId);
  return opportunityId;
}

/** Open the job, put the panel beside it, and wait for the panel to link the tab and offer a scan. */
async function openClaimed(extension: ExtensionHarness, applyUrl: string) {
  const { page: job, tab } = await extension.openWindow(applyUrl);
  const panel = await extension.openPanelBeside(tab);
  await expect(panel.getByRole("heading", { name: JOB.title })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Scan form" })).toBeEnabled();
  return { job, tab, panel };
}

async function scan(panel: Page) {
  await panel.getByRole("button", { name: "Scan form" }).click();
  await expect(panel.getByRole("region", { name: "Will fill" })).toBeVisible();
}

/** A panel request sent straight to the worker, as a compromised panel page could. */
function askWorker(panel: Page, request: Record<string, unknown>): Promise<unknown> {
  return panel.evaluate((message) => chrome.runtime.sendMessage(message), request);
}

test("pair, Apply, claim, scan, attach, prefill, confirm applied", async ({ page, extension }) => {
  await seedProfile(page.request);
  const opportunityId = await addJob(page.request, APPLY_URL);
  await prepareResume(page.request, opportunityId);

  // Pair: a code from Settings, typed into the panel.
  await pair(extension, { endpoint: ENDPOINT, code: await pairingCodeFromSettings(page) });
  await page.reload();
  await expect(page.getByRole("list", { name: "Extension pairings" }).getByText("Active")).toBeVisible();

  // Apply in the workspace opens the apply URL unchanged and records a session.
  await page.goto(`/jobs/${opportunityId}`);
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Apply", exact: true }).click();
  const job = await popupOpened;
  await job.waitForURL(APPLY_URL);
  await expect(job.getByRole("heading", { name: "Platform Engineer, Acme Inc" })).toBeVisible();
  expect((await sessionRows()).map((s) => s.status)).toEqual(["pending"]);

  // Claim: the panel finds the session, checks the tab address, and links this tab.
  const panel = await extension.openPanelBeside(await extension.tabAt(APPLY_URL));
  await expect(panel.getByRole("heading", { name: JOB.title })).toBeVisible();
  await expect(panel.getByText(JOB.company, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Scan form" })).toBeEnabled();
  expect((await sessionRows()).map((s) => s.status)).toEqual(["claimed"]);

  // Grant and scan. The origin grant resolves at once (pre-granted, fixtures.ts); the scan reads
  // the form and the server matches it. Nothing is written to the page yet.
  await scan(panel);
  const willFill = panel.getByRole("region", { name: "Will fill" });
  for (const label of ["First name", "Last name", "Email"]) {
    await expect(willFill.getByRole("checkbox", { name: `Fill ${label}` })).toBeChecked();
  }
  await expect(willFill.getByText(PROFILE.email)).toBeVisible();
  const leftBlank = panel.getByRole("region", { name: "Left blank" });
  await expect(leftBlank.getByRole("listitem").filter({ hasText: "Expected monthly salary (PHP)" })).toContainText(
    "Pay question, never filled",
  );
  await expect(panel.getByText(PROFILE.salary)).toHaveCount(0);
  expect(await formValues(job)).toEqual(UNTOUCHED);

  // Attach the reviewed resume to the empty upload field the user picked.
  const files = panel.getByRole("region", { name: /^Files/ });
  const upload = files.getByRole("listitem").filter({ hasText: "Resume/CV" });
  await expect(upload.getByLabel("Resume/CV")).toHaveValue(/.+/);
  await upload.getByRole("button", { name: "Attach" }).click();
  await expect(upload.getByText(/^Attached Maria Santos - Acme Inc - Resume\.pdf\./)).toBeVisible();
  const attached = await job.evaluate(() => {
    const file = (document.getElementById("resume") as HTMLInputElement).files?.[0];
    return file === undefined ? null : { name: file.name, type: file.type, size: file.size };
  });
  expect(attached).toMatchObject({ name: "Maria Santos - Acme Inc - Resume.pdf", type: "application/pdf" });
  expect(attached?.size ?? 0).toBeGreaterThan(100);

  // Prefill: empty, high-confidence fields only. The pre-filled phone and the salary stay as they were.
  await panel.getByRole("button", { name: /^Prefill \d+ fields?$/ }).click();
  await expect(panel.getByText(/^Filled 3 fields/)).toBeVisible();
  expect(await formValues(job)).toEqual({
    ...UNTOUCHED,
    first: "Maria",
    last: "Santos",
    email: PROFILE.email,
    files: 1,
  });

  // The user submits. The panel notices and asks; nothing changes until Yes.
  expect(await boardStatus(page.request, opportunityId)).toBe("saved");
  await job.getByRole("button", { name: "Submit application" }).click();
  await expect(job.getByRole("heading", { name: "Thanks for applying to Acme Inc." })).toBeVisible();
  const prompt = panel.getByRole("region", { name: "Did you submit this application?" });
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  expect(await boardStatus(page.request, opportunityId)).toBe("saved");
  await prompt.getByRole("button", { name: "Yes, mark applied" }).click();
  await expect(panel.getByText("Marked as applied in Rolecraft.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Scan form", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: JOB.title })).toHaveCount(0);
  expect((await extension.storage()).session.binding).toBeUndefined();

  // The board shows it under Applied, and the session is done.
  expect(await boardStatus(page.request, opportunityId)).toBe("applied");
  expect((await sessionRows()).map((s) => s.status)).toEqual(["completed"]);
  await page.goto("/board");
  await expect(
    page.getByRole("region", { name: /^Applied \/ Proposal sent 1/ }).getByRole("link", { name: /Platform Engineer/ }),
  ).toBeVisible();

  // Extension storage holds the endpoint, token, origins and session state only: no answers,
  // page text or file bytes.
  const stored = await extension.storage();
  expect(Object.keys(stored.local).sort()).toEqual(["endpoint", "grantedOrigins", "pairing"]);
  expect(stored.local.grantedOrigins).toEqual([APPROVED_ORIGIN]);
  const dump = JSON.stringify(stored);
  for (const secret of ["Maria", "Santos", PROFILE.email, PROFILE.phone, PROFILE.salary, "JVBERi0", "%PDF"]) {
    expect(dump).not.toContain(secret);
  }
});

test("the same panel follows a new Apply after completion without reopening", async ({ page, extension }) => {
  const firstId = await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const { job, tab, panel } = await openClaimed(extension, APPLY_URL);
  await scan(panel);
  await panel.getByRole("button", { name: /^Prefill \d+ fields?$/ }).click();
  await expect(panel.getByText(/^Filled 3 fields/)).toBeVisible();
  await job.getByRole("button", { name: "Submit application", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Did you submit this application?" })).toBeVisible({
    timeout: 15_000,
  });
  await panel.getByRole("button", { name: "Yes, mark applied", exact: true }).click();
  await expect(panel.getByText("Marked as applied in Rolecraft.")).toBeVisible();
  await expect(panel.getByRole("heading", { name: JOB.title })).toHaveCount(0);
  expect(await boardStatus(page.request, firstId)).toBe("applied");

  const nextUrl = `${APPROVED_ORIGIN}/next/backend-engineer/apply`;
  const added = await page.request.post("/api/jobs/from-paste", {
    data: { ...JOB, title: "Backend Engineer", company: "Next Co", url: nextUrl },
  });
  expect(added.status()).toBe(201);
  const nextId = AddJobResult.parse(await added.json()).opportunityId;
  await startSession(page.request, ENDPOINT, nextId);
  await extension.worker.evaluate(
    async ({ windowId, url }) => {
      await chrome.tabs.create({ windowId, url, active: true });
    },
    { windowId: tab.windowId, url: nextUrl },
  );
  await expect(panel.getByRole("heading", { name: "Backend Engineer" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Scan form", exact: true })).toBeEnabled();
  expect((await extension.storage()).session.binding).toMatchObject({ opportunityId: nextId });
  expect((await sessionRows()).map((row) => row.status)).toEqual(["completed", "claimed"]);
});

test("Refresh application discovers a new job and preserves current form values", async ({ page, extension }) => {
  await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const { job, panel } = await openClaimed(extension, APPLY_URL);
  await scan(panel);
  await panel.getByRole("button", { name: "Refresh application", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Will fill" })).toBeVisible();

  const nextUrl = `${APPROVED_ORIGIN}/next/backend-engineer/apply`;
  await job.goto(nextUrl);
  await expect(panel.getByRole("button", { name: "Scan form", exact: true })).toBeEnabled();
  await job.locator("#email").fill("already.typed@example.ph");
  const added = await page.request.post("/api/jobs/from-paste", {
    data: { ...JOB, title: "Backend Engineer", company: "Next Co", url: nextUrl },
  });
  expect(added.status()).toBe(201);
  const nextId = AddJobResult.parse(await added.json()).opportunityId;
  // Starting a session alone emits no Chrome tab event. Refresh must query the server again.
  await startSession(page.request, ENDPOINT, nextId);
  await panel.getByRole("button", { name: "Refresh application", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Backend Engineer" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: JOB.title })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Scan form", exact: true })).toBeEnabled();
  await expect(job.locator("#email")).toHaveValue("already.typed@example.ph");
  expect((await extension.storage()).session.binding).toMatchObject({ opportunityId: nextId });
  expect((await sessionRows()).map((row) => row.status)).toEqual(["expired", "claimed"]);
});

test("a page's postMessage and a subframe's runtime message get no answer", async ({ page, extension }) => {
  await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const { job, tab, panel } = await openClaimed(extension, APPLY_URL);
  await scan(panel);

  // The page cannot reach the extension's runtime: no externally_connectable.
  expect(await job.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage)).toBe("undefined");

  // Messages the extension would act on, posted by the page and by its subframe. The content
  // script has no message listener, so the page sees only its own posts and nothing changes.
  const forged = [
    { kind: "scan", nonce: "n".repeat(32) },
    { kind: "fill", nonce: "n".repeat(32), entries: [{ fieldId: "f1", value: "forged", signature: "x" }] },
    { kind: "confirm_applied" },
  ];
  await job.evaluate((messages) => {
    for (const message of messages) window.postMessage(message, "*");
  }, forged);
  await job
    .frameLocator('iframe[title="Embedded widget"]')
    .locator("body")
    .evaluate((_body, messages) => {
      for (const message of messages) window.parent.postMessage(message, "*");
    }, forged);
  await job.waitForTimeout(1_500);
  expect(await job.evaluate(() => ("received" in window ? window.received : undefined))).toEqual([
    ...forged,
    ...forged,
  ]);
  expect(await formValues(job)).toEqual(UNTOUCHED);

  // A script running in the subframe (the extension never injects one there) sends a scan result.
  // The worker drops it before parsing: only the top frame is heard.
  const replies = await extension.worker.evaluate(async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        if (window.top === window) return "top frame skipped";
        const message = {
          kind: "scan_result",
          nonce: "s".repeat(32),
          url: location.href,
          adapter: "generic",
          fields: [],
        };
        return chrome.runtime.sendMessage(message).then(
          (reply: unknown) => ({ reply: reply ?? null }),
          (error: unknown) => ({ error: String(error) }),
        );
      },
    });
    return results.map((r) => r.result);
  }, tab.tabId);
  expect(replies).toHaveLength(2);
  expect(replies).toContain("top frame skipped");
  // No listener answers: the promise settles with no reply.
  expect(replies.find((r) => r !== "top frame skipped")).toEqual({ reply: null });

  // The worker logged the refusal (metadata only), and the panel's review did not change.
  await expect(panel.getByRole("region", { name: "Will fill" })).toBeVisible();
  await panel.getByRole("button", { name: "Diagnostics" }).click();
  const refusal = panel.getByRole("listitem").filter({ hasText: "refused scan_result" });
  await expect(refusal).toContainText("not_top_frame");
  await expect(refusal).toContainText(APPROVED_ORIGIN);
  expect(await formValues(job)).toEqual(UNTOUCHED);
});

test("an origin the user never approved is refused", async ({ page, extension }) => {
  const applyUrl = `${UNAPPROVED_ORIGIN}/acme/apply`;
  await pairedWithSession({ page, extension, applyUrl });
  const { page: job, tab } = await extension.openWindow(applyUrl);
  const panel = await extension.openPanelBeside(tab);

  // Without host access Chrome hides the tab's address, so the panel cannot link it.
  await expect(panel.getByRole("heading", { name: JOB.title })).toBeVisible();
  await expect(panel.getByText("The extension can't read this tab's address.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Allow access to the job's site" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Scan form" })).toHaveCount(0);

  // Asking the worker directly does not help: it re-reads the tab and refuses.
  const [session] = await sessionRows();
  if (session === undefined) throw new Error("no session");
  const claim = await askWorker(panel, {
    kind: "session_claim",
    sessionId: session.id,
    tabId: tab.tabId,
    tabUrl: applyUrl,
    confirmMismatch: true,
  });
  expect(claim).toMatchObject({ result: { kind: "refused", reason: "unsupported_url" } });
  expect(await askWorker(panel, { kind: "scan", tabId: tab.tabId })).toMatchObject({
    result: { kind: "refused", reason: "not_bound" },
  });
  // And Chrome itself refuses to inject into the page.
  const injected = await extension.worker.evaluate(
    (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).then(
        () => "injected",
        () => "refused",
      ),
    tab.tabId,
  );
  expect(injected).toBe("refused");

  expect((await sessionRows()).map((s) => s.status)).toEqual(["pending"]);
  expect(await formValues(job)).toEqual(UNTOUCHED);
});

test("a revoked pairing puts the panel back on pairing and fills nothing", async ({ page, extension }) => {
  await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const { job, panel } = await openClaimed(extension, APPLY_URL);
  await scan(panel);

  // Revoke in Settings while the review is open.
  await page.goto("/settings");
  const pairings = page.getByRole("list", { name: "Extension pairings" });
  await pairings.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog", { name: "Revoke this pairing?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(pairings.getByText("Revoked", { exact: true })).toBeVisible();

  // Prefill checks the pairing first: the server says 401, the panel shows pairing again.
  await panel.getByRole("button", { name: /^Prefill \d+ fields?$/ }).click();
  await expect(panel.getByRole("heading", { name: "Pair with Rolecraft" })).toBeVisible();
  await expect(panel.getByText("This browser was disconnected from Rolecraft. Pair it again.")).toBeVisible();
  expect(await formValues(job)).toEqual(UNTOUCHED);

  // The token and the session binding are gone; the endpoint stays for the next pairing.
  const stored = await extension.storage();
  expect(stored.local).not.toHaveProperty("pairing");
  expect(stored.local).toHaveProperty("endpoint", ENDPOINT);
  expect(stored.session).not.toHaveProperty("binding");
});

test("with the server stopped the panel fails closed and the page is unchanged", async ({ page, extension }) => {
  const server = await StoppableServer.start(STOPPABLE_SERVER_PORT);
  try {
    await seedProfile(page.request);
    const opportunityId = await addJob(page.request, APPLY_URL);
    await pair(extension, { endpoint: server.origin, code: await pairingCodeFromApi(page.request, server.origin) });
    await startSession(page.request, server.origin, opportunityId);
    const { job, panel } = await openClaimed(extension, APPLY_URL);
    await scan(panel);

    await server.stop();
    await panel.getByRole("button", { name: /^Prefill \d+ fields?$/ }).click();
    await expect(panel.getByRole("heading", { name: "Pair with Rolecraft" })).toBeVisible();
    await expect(
      panel.getByText(`Can't reach Rolecraft at ${server.origin}. Start the server, then retry.`),
    ).toBeVisible();
    expect(await formValues(job)).toEqual(UNTOUCHED);

    // Retry with the server still down stays closed.
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect(panel.getByRole("heading", { name: "Pair with Rolecraft" })).toBeVisible();
    expect(await formValues(job)).toEqual(UNTOUCHED);
  } finally {
    await server.stop();
  }
});

const CUSTOM_QUESTION = "What is your ideal tech stack?";
async function addCustomQuestion(job: Page) {
  await job.locator("form").evaluate((form, question) => {
    const label = document.createElement("label");
    label.htmlFor = "custom-answer";
    label.textContent = question;
    const input = document.createElement("textarea");
    input.id = "custom-answer";
    input.name = "custom_answer";
    form.prepend(label, input);
  }, CUSTOM_QUESTION);
}

test("explicitly saved custom answers become review-only references on another job", async ({ page, extension }) => {
  await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const first = await openClaimed(extension, APPLY_URL);
  await addCustomQuestion(first.job);
  await scan(first.panel);
  const firstAnswers = first.panel.getByRole("region", { name: "Custom answers" });
  await first.job.getByLabel(CUSTOM_QUESTION, { exact: true }).fill("I prefer TypeScript and Postgres.");
  await expect(firstAnswers.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("");
  await firstAnswers.getByRole("button", { name: "Read from form" }).click();
  await expect(firstAnswers.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue(
    "I prefer TypeScript and Postgres.",
  );
  await firstAnswers.getByRole("button", { name: "Save reference", exact: true }).click();
  await expect(firstAnswers.getByText("Reference saved. It will only be reused when you choose it.")).toBeVisible();
  await first.panel.close();
  await first.job.close();

  const secondUrl = `${APPROVED_ORIGIN}/another-company/platform-engineer/apply`;
  const added = await page.request.post("/api/jobs/from-paste", {
    data: { ...JOB, company: "Another Company", url: secondUrl },
  });
  expect(added.status()).toBe(201);
  const secondId = AddJobResult.parse(await added.json()).opportunityId;
  await startSession(page.request, ENDPOINT, secondId);
  const second = await openClaimed(extension, secondUrl);
  await addCustomQuestion(second.job);
  await scan(second.panel);
  const answers = second.panel.getByRole("region", { name: "Custom answers" });
  await expect(answers.getByText("From Acme Inc", { exact: true })).toBeVisible();
  await expect(answers.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("");
  await expect(second.job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("");
  await answers.getByRole("button", { name: "Use as starting point" }).click();
  await expect(answers.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("I prefer TypeScript and Postgres.");
  await expect(second.job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("");
  await answers.getByRole("button", { name: "Fill this answer", exact: true }).click();
  await expect(second.job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue(
    "I prefer TypeScript and Postgres.",
  );
  await answers.getByLabel(CUSTOM_QUESTION, { exact: true }).fill("A different answer.");
  await answers.getByRole("button", { name: "Fill this answer", exact: true }).click();
  await expect(second.job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue(
    "I prefer TypeScript and Postgres.",
  );
  expect(JSON.stringify(await extension.storage())).not.toContain("I prefer TypeScript");
});

test("a newly scanned question can draft through the server without automatically filling", async ({
  page,
  extension,
}) => {
  await pairedWithSession({ page, extension, applyUrl: APPLY_URL });
  const key = await page.request.put("/api/settings/ai-key", {
    data: { provider: "anthropic", key: "sk-ant-extension-fixture-ABCD" },
  });
  expect(key.ok()).toBe(true);
  expect(
    (
      await page.request.put("/api/profile/cv", {
        data: { text: "- Built a payments API in Go serving 2M requests a day" },
      })
    ).ok(),
  ).toBe(true);
  await expect
    .poll(async () => ProfileDto.parse(await (await page.request.get("/api/profile")).json()).facts.length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  expect((await page.request.post("/api/facts/confirm-all")).ok()).toBe(true);
  const { job, panel } = await openClaimed(extension, APPLY_URL);
  await addCustomQuestion(job);
  await scan(panel);
  const answers = panel.getByRole("region", { name: "Custom answers" });
  await answers.getByRole("button", { name: "Generate draft", exact: true }).click();
  await expect(answers.getByText("Draft ready. Check every fact and company name before filling.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(answers.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue(/payments API/);
  await expect(answers.getByLabel(CUSTOM_QUESTION, { exact: true })).not.toHaveValue(/FACT-/);
  await expect(job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue("");
  await answers.getByRole("button", { name: "Fill this answer", exact: true }).click();
  await expect(job.getByLabel(CUSTOM_QUESTION, { exact: true })).toHaveValue(/payments API/);
});
