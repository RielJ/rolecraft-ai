import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { AddJobResult, BoardItemDto, WorkspaceDto } from "@/shared/api";
import { ActiveSessionResponse, ClaimPairingResult } from "@/shared/extension";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";

// Chrome extension (docs/EXTENSION.md): pairing in Settings, Apply in the workspace, and
// Mark reviewed. The job site is never reached: a context route answers for it.

test.beforeEach(async () => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await resetTables(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

/** A well-formed unpacked-extension origin (32 letters a-p). */
const EXTENSION_ORIGIN = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;

/** Query and path kept on purpose: Apply must open this string exactly, with nothing added. */
const APPLY_URL = "https://jobs.lever.co/acme/7f3c2a9e-apply-test/apply?lever-source=LinkedIn&team=Platform";

async function addJob(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/jobs/from-paste", {
    data: {
      url: APPLY_URL,
      title: "Platform Engineer",
      company: "Acme Inc",
      description: "Build payment APIs in Go. Remote, worldwide.",
    },
  });
  expect(res.status()).toBe(201);
  return AddJobResult.parse(await res.json()).opportunityId;
}

async function boardStatus(request: APIRequestContext, opportunityId: string): Promise<string | undefined> {
  const items = z.array(BoardItemDto).parse(await (await request.get("/api/board")).json());
  return items.find((i) => i.opportunityId === opportunityId)?.status;
}

async function workspace(request: APIRequestContext, opportunityId: string): Promise<WorkspaceDto> {
  return WorkspaceDto.parse(await (await request.get(`/api/opportunities/${opportunityId}`)).json());
}

/** Create a code in Settings, then claim it the way the extension does. Returns the bearer token. */
async function pairFromSettings(page: Page): Promise<string> {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Chrome extension" });
  await section.getByRole("button", { name: "Create pairing code" }).click();
  const code = (await section.getByTestId("pairing-code").textContent()) ?? "";
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const claim = await page.request.post("/api/extension/pair/claim", {
    headers: { Origin: EXTENSION_ORIGIN },
    data: { code },
  });
  expect(claim.status()).toBe(200);
  return ClaimPairingResult.parse(await claim.json()).token;
}

test("Settings: create a code, see it claimed and used, revoke it", async ({ page }) => {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Chrome extension" });
  await expect(section.getByText("No extension paired yet.")).toBeVisible();

  await section.getByRole("button", { name: "Create pairing code" }).click();
  // Large, grouped 4-4, counting down from ten minutes, with a copy button.
  const code = section.getByTestId("pairing-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(code.locator("span:not(.sr-only)")).toHaveText([/^[A-Z2-9]{4}$/, /^[A-Z2-9]{4}$/]);
  await expect(section.getByText(/^Expires in (10:00|9:\d\d)\. It works once\.$/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Copy code" })).toBeVisible();
  const pairings = section.getByRole("list", { name: "Extension pairings" });
  await expect(pairings.getByRole("listitem")).toHaveCount(1);
  await expect(pairings.getByText("Waiting")).toBeVisible();

  // The extension claims it; the list polls while a code waits, so it turns active by itself.
  const claim = await page.request.post("/api/extension/pair/claim", {
    headers: { Origin: EXTENSION_ORIGIN },
    data: { code: await code.textContent() },
  });
  expect(claim.status()).toBe(200);
  const { token } = ClaimPairingResult.parse(await claim.json());
  await expect(pairings.getByText("Active")).toBeVisible({ timeout: 10_000 });
  await expect(section.getByText("Paired. The extension can prefill application forms now.")).toBeVisible();
  await expect(pairings.getByText("Not used yet.")).toBeVisible();

  const ping = () => page.request.get("/api/extension/ping", { headers: { Authorization: `Bearer ${token}` } });
  expect((await ping()).status()).toBe(200);
  await page.reload();
  await expect(pairings.getByText(/Last used just now\./)).toBeVisible();

  // Revoke asks first; Cancel keeps it.
  await pairings.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke this pairing?" });
  await expect(dialog.getByText("The extension stops working with Hanapbuhay right away.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(pairings.getByText("Active")).toBeVisible();

  await pairings.getByRole("button", { name: "Revoke" }).click();
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Pairing revoked.")).toBeVisible();
  await expect(pairings.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(pairings.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  expect((await ping()).status()).toBe(401);
});

test("Apply opens the stored apply URL unchanged, records a session, and leaves the board alone", async ({
  page,
  context,
}) => {
  const token = await pairFromSettings(page);
  const opportunityId = await addJob(page.request);
  expect((await workspace(page.request, opportunityId)).job.applyUrl).toBe(APPLY_URL);
  expect(await boardStatus(page.request, opportunityId)).toBe("saved");

  const jobSite: { url: string; referer: string | undefined }[] = [];
  await context.route("https://jobs.lever.co/**", async (route) => {
    jobSite.push({ url: route.request().url(), referer: route.request().headers().referer });
    await route.fulfill({ contentType: "text/html", body: "<title>Apply</title><h1>Acme application</h1>" });
  });

  await page.goto(`/jobs/${opportunityId}`);
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Apply", exact: true }).click();
  const popup = await popupOpened;
  await popup.waitForURL(APPLY_URL);
  expect(popup.url()).toBe(APPLY_URL);
  await expect(popup.getByRole("heading", { name: "Acme application" })).toBeVisible();
  expect(jobSite).toEqual([{ url: APPLY_URL, referer: undefined }]);
  expect(await popup.evaluate(() => window.opener)).toBeNull();

  // The extension finds the session by asking the server.
  const active = await page.request.get("/api/extension/sessions/active", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(active.status()).toBe(200);
  const found = ActiveSessionResponse.parse(await active.json());
  expect(found.kind).toBe("active");
  if (found.kind !== "active") return;
  expect(found.session).toMatchObject({ opportunityId, applyUrl: APPLY_URL, status: "pending" });

  // Apply is not "applied".
  expect(await boardStatus(page.request, opportunityId)).toBe("saved");
  await expect(page.getByRole("button", { name: "Mark applied" })).toBeVisible();
});

test("Apply still opens the page when the session cannot be recorded, and says so", async ({ page, context }) => {
  const opportunityId = await addJob(page.request);
  await context.route("https://jobs.lever.co/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Acme application</h1>" }),
  );
  await page.route("**/api/extension-web/sessions", (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: "Something went wrong on the server." } },
    }),
  );

  await page.goto(`/jobs/${opportunityId}`);
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Apply", exact: true }).click();
  const popup = await popupOpened;
  await popup.waitForURL(APPLY_URL);
  await expect(page.getByText("The apply page opened, but the extension won't pick it up.")).toBeVisible();
  expect(await boardStatus(page.request, opportunityId)).toBe("saved");
});

test("Mark reviewed on a file and an answer; an edit clears it", async ({ page }) => {
  const opportunityId = await addJob(page.request);
  const question = "Why do you want to work at Acme?";
  const added = await page.request.post(`/api/opportunities/${opportunityId}/questions`, { data: { question } });
  expect(added.ok()).toBe(true);
  const ws = await workspace(page.request, opportunityId);
  const resume = ws.files.find((f) => f.kind === "resume");
  const answer = ws.answers.find((a) => a.question === question);
  if (!resume || !answer) throw new Error("the workspace has no resume or no answer");
  for (const [id, body] of [
    [resume.id, "# Summary\n- Built payment APIs in Go"],
    [answer.id, "I build payment systems, and Acme runs one."],
  ] as const) {
    expect((await page.request.patch(`/api/outputs/${id}`, { data: { body } })).ok()).toBe(true);
  }

  await page.goto(`/jobs/${opportunityId}`);

  // The resume tab. Something is written, so the job opens on Drafts.
  const file = page.getByRole("tabpanel", { name: /^Resume/ });
  await file.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(file.getByText("Any change clears it.")).toBeVisible();
  await expect(file.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);

  // The answer.
  const row = page.getByRole("listitem").filter({ hasText: question });
  await row.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(row.getByText("Any change clears it.")).toBeVisible();
  const reviewed = await workspace(page.request, opportunityId);
  expect(reviewed.answers.find((a) => a.id === answer.id)?.reviewedAt).not.toBeNull();
  expect(reviewed.files.find((f) => f.id === resume.id)?.reviewedAt).not.toBeNull();

  // Editing the answer clears its review, and the page says it needs a new one.
  await row.getByRole("button", { name: "Edit text" }).click();
  await row.getByLabel(question, { exact: true }).fill("I build payment systems. Acme runs the biggest one in Manila.");
  await expect(row.getByText("Saving this change clears it.")).toBeVisible();
  // A double click must send one save.
  let patches = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/api/outputs/${answer.id}`)) patches += 1;
  });
  await row.getByRole("button", { name: "Save answer" }).dblclick();
  await expect(page.getByText("Answer saved. Mark it reviewed again so the extension can use it.")).toBeVisible();
  expect(patches).toBe(1);
  await expect(row).toContainText("Acme runs the biggest one in Manila.");
  await expect(row.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
  await expect(row.getByText("Any change clears it.")).toHaveCount(0);
  // Unsaved text cannot be marked reviewed: the review would cover the old body.
  await row.getByRole("button", { name: "Edit text" }).click();
  await row.getByLabel(question, { exact: true }).fill("I build payment systems.");
  await expect(row.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
  await row.getByRole("button", { name: "Save answer" }).click();
  await expect(row.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();

  // So does editing the resume, from the card's overflow menu. The box holds clean text.
  await file.getByRole("button", { name: "More actions for the resume" }).click();
  await page.getByRole("menuitem", { name: "Edit text" }).click();
  const box = file.getByLabel("Resume text");
  await expect(box).toHaveValue("# Summary\n- Built payment APIs in Go");
  await box.fill("# Summary\n- Built payment APIs in Go for 2M requests a day");
  let filePatches = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/api/outputs/${resume.id}`)) filePatches += 1;
  });
  await file.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Resume saved. Mark it reviewed again so the extension can use it.")).toBeVisible();
  expect(filePatches).toBe(1);
  await expect(file.getByRole("button", { name: "Mark reviewed" })).toBeVisible();

  const after = await workspace(page.request, opportunityId);
  expect(after.answers.find((a) => a.id === answer.id)?.reviewedAt).toBeNull();
  expect(after.files.find((f) => f.id === resume.id)?.reviewedAt).toBeNull();
});

test("Mark reviewed on text another tab changed is refused; the page reloads the new text", async ({ page }) => {
  const opportunityId = await addJob(page.request);
  const question = "Why do you want to work at Acme?";
  const added = await page.request.post(`/api/opportunities/${opportunityId}/questions`, { data: { question } });
  expect(added.ok()).toBe(true);
  const answer = (await workspace(page.request, opportunityId)).answers.find((a) => a.question === question);
  if (!answer) throw new Error("the workspace has no answer");
  const shown = "I build payment systems, and Acme runs one.";
  expect((await page.request.patch(`/api/outputs/${answer.id}`, { data: { body: shown } })).ok()).toBe(true);

  await page.goto(`/jobs/${opportunityId}`);
  const row = page.getByRole("listitem").filter({ hasText: question });
  await expect(row).toContainText(shown);

  // Another tab saves new text after this page showed the old one.
  const newer = "I want to work on Acme's payment rails.";
  expect((await page.request.patch(`/api/outputs/${answer.id}`, { data: { body: newer } })).ok()).toBe(true);

  await row.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(
    page.getByText("This text changed since you opened it. Read the new version, then mark it reviewed."),
  ).toBeVisible();
  await expect(row).toContainText(newer);
  await expect(row.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
  expect((await workspace(page.request, opportunityId)).answers.find((a) => a.id === answer.id)?.reviewedAt).toBeNull();
});
