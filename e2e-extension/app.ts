import { type ChildProcess, spawn } from "node:child_process";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { AddJobResult, BoardItemDto, WorkspaceDto } from "@/shared/api";
import { CreatePairingResult } from "@/shared/extension";
import { E2E_DATABASE_URL } from "../playwright.config";
import { resetTables } from "../test/reset";
import { serverEnv } from "./server-env";

// Server-side helpers for the extension run: seed the profile and a job, read rows the panel
// cannot show, and run a server the test can stop.

export const PROFILE = {
  // Two words, so the matcher splits it into first and last name.
  fullName: "Maria Santos",
  email: "maria.santos@example.ph",
  phone: "+63 917 555 0100",
  location: "Manila, Philippines",
  salary: "PHP 180,000 a month",
} as const;

export const JOB = {
  title: "Platform Engineer",
  company: "Acme Inc",
  description: "Build payment APIs in Go. Remote, worldwide.",
} as const;

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function resetDatabase(): Promise<void> {
  return withSql(resetTables);
}

/** Contact details and a salary answer. The salary must never reach the form. */
export async function seedProfile(request: APIRequestContext): Promise<void> {
  const res = await request.put("/api/profile", {
    data: {
      contact: {
        fullName: PROFILE.fullName,
        email: PROFILE.email,
        phone: PROFILE.phone,
        location: PROFILE.location,
        links: [],
      },
      standardAnswers: { salary: PROFILE.salary },
    },
  });
  expect(res.ok()).toBe(true);
}

/** A pasted job whose apply URL is `applyUrl`. */
export async function addJob(request: APIRequestContext, applyUrl: string): Promise<string> {
  const res = await request.post("/api/jobs/from-paste", { data: { url: applyUrl, ...JOB } });
  expect(res.status()).toBe(201);
  return AddJobResult.parse(await res.json()).opportunityId;
}

/**
 * Write and review the resume, untick the other files, so the resume exports as PDF and is the
 * only file the panel offers.
 */
export async function prepareResume(request: APIRequestContext, opportunityId: string): Promise<void> {
  const ws = WorkspaceDto.parse(await (await request.get(`/api/opportunities/${opportunityId}`)).json());
  const body = "# Summary\n- Built payment APIs in Go";
  for (const file of ws.files) {
    const data = file.kind === "resume" ? { body } : { included: false };
    expect((await request.patch(`/api/outputs/${file.id}`, { data })).ok()).toBe(true);
  }
  const resume = ws.files.find((f) => f.kind === "resume");
  if (resume === undefined) throw new Error("the workspace has no resume");
  expect((await request.post(`/api/outputs/${resume.id}/reviewed`, { data: { body } })).ok()).toBe(true);
}

/** What Apply does, without the popup: record the session. `origin` is the app's own origin. */
export async function startSession(request: APIRequestContext, origin: string, opportunityId: string): Promise<void> {
  const res = await request.post(`${origin}/api/extension-web/sessions`, {
    headers: { Origin: origin },
    data: { opportunityId },
  });
  expect(res.ok()).toBe(true);
}

/** A one-time pairing code from the server at `origin`, created the way Settings does. */
export async function pairingCodeFromApi(request: APIRequestContext, origin: string): Promise<string> {
  const res = await request.post(`${origin}/api/extension-web/pairings`, { headers: { Origin: origin }, data: {} });
  expect(res.ok()).toBe(true);
  return CreatePairingResult.parse(await res.json()).code;
}

/** Create a code in Settings and read it off the page. */
export async function pairingCodeFromSettings(page: Page): Promise<string> {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Chrome extension" });
  await section.getByRole("button", { name: "Create pairing code" }).click();
  const code = section.getByTestId("pairing-code");
  await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return (await code.textContent()) ?? "";
}

/** Fill the panel's pairing form and pair. Host access to the endpoint is pre-granted (fixtures.ts). */
export async function pairPanel(panel: Page, { endpoint, code }: { endpoint: string; code: string }): Promise<void> {
  await panel.getByLabel("Hanapbuhay address").fill(endpoint);
  await panel.getByLabel("Pairing code").fill(code);
  await panel.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(panel.getByText(`Paired with ${endpoint}`)).toBeVisible();
}

export async function boardStatus(request: APIRequestContext, opportunityId: string): Promise<string | undefined> {
  const items = z.array(BoardItemDto).parse(await (await request.get("/api/board")).json());
  return items.find((i) => i.opportunityId === opportunityId)?.status;
}

const SessionRow = z.object({ id: z.string(), status: z.string() });

/** Every application session, oldest first. */
export function sessionRows(): Promise<z.infer<typeof SessionRow>[]> {
  return withSql(async (sql) =>
    z.array(SessionRow).parse(await sql`SELECT id, status FROM application_sessions ORDER BY created_at`),
  );
}

/** A server on `port` that the test starts and kills. Same database and settings as the webServer. */
export class StoppableServer {
  private constructor(
    private readonly child: ChildProcess,
    readonly origin: string,
  ) {}

  static async start(port: number): Promise<StoppableServer> {
    const child = spawn("bun", ["src/server/main.ts"], {
      env: { ...process.env, ...serverEnv(port) },
      stdio: "ignore",
    });
    const server = new StoppableServer(child, `http://localhost:${port}`);
    await expect
      .poll(
        () =>
          fetch(`${server.origin}/api/health`).then(
            (r) => r.ok,
            () => false,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    return server;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    await exited;
    await expect
      .poll(() =>
        fetch(`${this.origin}/api/health`).then(
          () => "up",
          () => "down",
        ),
      )
      .toBe("down");
  }
}
