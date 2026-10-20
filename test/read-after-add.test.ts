import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeAi } from "@/server/adapters/ai/fake";
import type { GithubReader } from "@/server/adapters/github";
import { createFixtureReader, type GithubSnapshotInput } from "@/server/adapters/github-fixture";
import { createFolderReader, createProjectsReader, type FolderReader } from "@/server/adapters/local-projects";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { ProfileDto, ProjectScanDto } from "@/shared/api";
import { type FileCommit, makeFileRepo } from "./git-repos";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Reading projects for facts as they are added (decision 81, slice 3): from Find my projects, one
 * at a time with one cap check for the batch, and from the add-on form.
 */

const ME = "juan@example.ph";

function history(name: string): FileCommit[] {
  const mine = (subject: string, files: FileCommit["files"]): FileCommit => ({ email: ME, subject, files });
  return [
    mine(`feat: ${name} core`, {
      "README.md": `# ${name}\n\nA tool for barangay offices.`,
      "main.go": "package main\n",
    }),
    mine(`feat: ${name} export`, { "export.go": "package main\n\nfunc Export() {}\n" }),
  ];
}

const SNAPSHOT: GithubSnapshotInput = {
  owner: "juandc",
  repo: "tanod",
  description: "Barangay watch rota",
  language: "Go",
  sizeKb: 400,
  files: { "README.md": "# Tanod\n\nRota for barangay watch shifts.", "go.mod": "module tanod" },
  commits: [
    {
      sha: "a".repeat(40),
      message: "feat: swap shifts",
      author: "juandc",
      files: [{ path: "rota/swap.go", additions: 4, deletions: 0, patch: "@@ -0,0 +1 @@\n+func Swap() {}" }],
    },
  ],
};

let dir: string;
let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;
/** Reads in progress at once, across GitHub and folders, and the most seen. */
let running = 0;
let most = 0;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }): Promise<T> {
  return schema.parse(await res.json());
}

async function counted<T>(work: () => Promise<T>): Promise<T> {
  running += 1;
  most = Math.max(most, running);
  try {
    // Give a second read the chance to overlap, if anything let it.
    await Bun.sleep(5);
    return await work();
  } finally {
    running -= 1;
  }
}

async function setup({ githubUser = "juandc", ai = true }: { githubUser?: string | null; ai?: boolean } = {}) {
  const listing = await mkdtemp(join(tmpdir(), "hb-read-add-gh-"));
  await Bun.write(join(listing, "tanod.json"), JSON.stringify(SNAPSHOT));
  const fixture = createFixtureReader({ dir: listing, user: githubUser });
  const github: GithubReader = { ...fixture, read: (input) => counted(() => fixture.read(input)) };
  const options = { extraEmails: [ME], readConfigEmail: false };
  const plain = createFolderReader(options);
  const folders: FolderReader = { ...plain, deep: (input) => counted(() => plain.deep(input)) };
  deps = await testDeps({ github, folders, projects: createProjectsReader({ dir, ...options }) });
  app = createApp(deps);
  if (ai) await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
}

async function profile(): Promise<ProfileDto> {
  return json(await call("GET", "/profile"), ProfileDto);
}

const readTask = (a: ProfileDto["addons"][number]) => a.github?.readTask ?? a.folder?.readTask ?? null;

async function settleReads(p: ProfileDto): Promise<ProfileDto> {
  await waitForSplits(p);
  for (const a of p.addons) {
    const task = readTask(a);
    if (task) await waitForTask(task.id);
  }
  return profile();
}

beforeEach(async () => {
  await resetDb();
  running = 0;
  most = 0;
  dir = await realpath(await mkdtemp(join(tmpdir(), "hb-read-add-")));
  await makeFileRepo(join(dir, "kain-tayo"), { commits: history("Kain Tayo") });
  await makeFileRepo(join(dir, "sukli"), { commits: history("Sukli") });
  await mkdir(join(dir, "notes"));
  await Bun.write(join(dir, "notes", "README.md"), "# Notes\n\nMeeting notes.");
});

describe("Find my projects, read for facts", () => {
  test("the scan gives one read's cost with an AI key, and none without", async () => {
    await setup({ ai: false });
    expect((await json(await call("GET", "/profile/projects"), ProjectScanDto)).readEstimateUsd).toBeNull();
    await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
    const { readEstimateUsd } = await json(await call("GET", "/profile/projects"), ProjectScanDto);
    expect(readEstimateUsd).toBeGreaterThan(0);
  });

  test("reads each repo and git folder one at a time, each with its own progress", async () => {
    await setup();
    const res = await call("POST", "/profile/projects", {
      repos: ["tanod"],
      folders: ["kain-tayo", "sukli", "notes"],
      read: true,
    });
    expect(res.status).toBe(200);
    const started = await json(res, ProfileDto);
    const titles = started.addons.map((a) => a.title);
    expect(titles).toEqual(["tanod", "kain-tayo", "sukli", "notes"]);
    // A task for each readable add-on at once; the later ones wait their turn.
    const tasks = started.addons.map(readTask);
    expect(tasks.map((t) => t?.status ?? null)).toEqual(["running", "running", "running", null]);
    expect(tasks[2]?.step).toBe("Waiting for the 2 reads before it");

    const after = await settleReads(started);
    expect(after.addons.map((a) => readTask(a)?.status ?? null)).toEqual(["done", "done", "done", null]);
    expect(most).toBe(1);
    const read = new Set(after.facts.filter((f) => f.origin === "github").map((f) => f.itemId));
    expect(read.size).toBe(3);
    expect([...read]).not.toContain(after.addons[3]?.id);
  });

  test("one cap check covers the splits and the reads; confirming runs them all", async () => {
    await setup();
    const scan = await json(await call("GET", "/profile/projects"), ProjectScanDto);
    const oneRead = scan.readEstimateUsd ?? 0;
    // A $1 cap with room for one read and the splits, not three reads.
    await call("PATCH", "/settings", { monthlyCapUsd: 1 });
    await testSql()`
      INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (${deps.userId}, 'light', 'split', 'anthropic', 'claude-haiku-5-5', 1, 1, ${1 - oneRead * 1.5}, ${deps.clock.now()})`;
    const body = { repos: ["tanod"], folders: ["kain-tayo", "sukli"], read: true };
    const over = await call("POST", "/profile/projects", body);
    expect(over.status).toBe(402);
    const { details } = ((await over.json()) as { error: { details: { estimateUsd: number } } }).error;
    expect(details.estimateUsd).toBeGreaterThan(oneRead * 3 - 0.0001);
    expect((await profile()).addons).toEqual([]);

    const confirmed = await settleReads(
      await json(await call("POST", "/profile/projects", { ...body, confirmOverCap: true }), ProfileDto),
    );
    expect(confirmed.addons.map((a) => readTask(a)?.status)).toEqual(["done", "done", "done"]);
  });

  test("a read that can't know whose commits are mine stops the add before anything is saved", async () => {
    await setup({ githubUser: null });
    const res = await call("POST", "/profile/projects", { repos: ["tanod"], read: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("GitHub profile link");
    expect((await profile()).addons).toEqual([]);
  });
});

describe("the add-on form, read for facts", () => {
  test("a folder saved with Read for facts is read once saved", async () => {
    await setup();
    const res = await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "Kain Tayo",
      body: "Recipe planner.",
      folder: join(dir, "kain-tayo"),
      read: true,
    });
    expect(res.status).toBe(201);
    const after = await settleReads(await json(res, ProfileDto));
    const item = after.addons[0];
    expect(item?.folder?.readTask?.status).toBe("done");
    expect(after.facts.some((f) => f.itemId === item?.id && f.origin === "github")).toBe(true);
  });

  test("a GitHub link saved with Read for facts is read; one that can't be read is refused", async () => {
    await setup();
    const res = await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "Tanod",
      body: "Barangay watch rota.",
      link: "https://github.com/juandc/tanod",
      read: true,
    });
    expect(res.status).toBe(201);
    const after = await settleReads(await json(res, ProfileDto));
    expect(after.addons[0]?.github?.readTask?.status).toBe("done");

    const gitlab = await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "Other",
      body: "On GitLab.",
      link: "https://gitlab.com/juandc/other",
      read: true,
    });
    expect(gitlab.status).toBe(400);
    expect((await profile()).addons).toHaveLength(1);
  });
});
