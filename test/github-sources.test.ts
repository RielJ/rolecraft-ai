import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { gitCommitSource } from "@/server/adapters/folder-read";
import { createGit } from "@/server/adapters/git";
import { createReader } from "@/server/adapters/github";
import { createFixtureTransport, type GithubSnapshotInput } from "@/server/adapters/github-fixture";
import { createFolderReader, createProjectsReader } from "@/server/adapters/local-projects";
import { CloneError, type Cloner, createCloner } from "@/server/adapters/temp-clone";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { ProfileDto } from "@/shared/api";
import { type FileCommit, makeFileRepo, markPushed } from "./git-repos";
import { resetDb, testDeps, waitForGithubReads, waitForSplits } from "./setup";

/*
 * Where a GitHub read's commits and hunks come from (decision 81): a local clone, a blob-less
 * temp clone in public mode, or the API, with real git repos and the fixture API.
 */

const ME = "juan@example.ph";
const PAL = "pal@example.ph";

function history(): FileCommit[] {
  const mine = (subject: string, files: FileCommit["files"]): FileCommit => ({ email: ME, subject, files });
  return [
    mine("feat: shift table", {
      "README.md": "# Tanod\n\nRota for barangay watch shifts.",
      "rota/table.go": "package rota\n",
    }),
    mine("feat: swap shifts", { "rota/swap.go": "package rota\n\nfunc Swap() {}\n" }),
    { email: PAL, subject: "chore: ci", files: { "ci.yml": "on: push\n" } },
    mine("fix: swap same day", { "rota/swap.go": "package rota\n\nfunc Swap() { /* same day */ }\n" }),
    mine("feat: rota view", { "rota/view.go": "package rota\n\nfunc View() {}\n" }),
    mine("feat: notify tanods", { "notify/sms.go": "package notify\n\nfunc Send() {}\n" }),
  ];
}

/** The API's view of the same repo: commits it knows, by login, without hunks. */
function snapshot(sizeKb: number): GithubSnapshotInput {
  return {
    owner: "juandc",
    repo: "tanod",
    sizeKb,
    files: { "README.md": "# Tanod\n\nRota for barangay watch shifts." },
    commits: Array.from({ length: 12 }, (_, i) => ({
      sha: `${i}`.padStart(2, "0").repeat(20),
      message: `feat: api change ${i}`,
      author: "juandc",
      files: [{ path: `api/${i}.go`, additions: 5, deletions: 0, patch: `@@ -0,0 +1 @@\n+func Api${i}() {}` }],
    })),
  };
}

let dir: string;
let source: string;
let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function settle(res: Response): Promise<ProfileDto> {
  expect(res.status).toBeLessThan(300);
  const profile = ProfileDto.parse(await res.json());
  await waitForSplits(profile);
  await waitForGithubReads(profile);
  return ProfileDto.parse(await (await call("GET", "/profile")).json());
}

async function setup({
  sizeKb = 100,
  projects = false,
  cloner = null,
}: {
  sizeKb?: number;
  projects?: boolean;
  cloner?: Cloner | null;
}) {
  const transport = createFixtureTransport({ snapshots: [snapshot(sizeKb)] });
  const options = { extraEmails: [ME], readConfigEmail: false };
  deps = await testDeps({
    // Public mode: the mode a temp clone is for.
    github: createReader({ mode: "public", user: "juandc", transport }),
    folders: createFolderReader(options),
    projects: projects ? createProjectsReader({ dir, ...options }) : null,
    cloner,
  });
  app = createApp(deps);
  await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
}

async function readRepo() {
  const added = await settle(
    await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "Tanod",
      body: "Barangay watch rota.",
      link: "https://github.com/juandc/tanod",
    }),
  );
  const item = added.addons.at(-1);
  if (!item) throw new Error("no add-on");
  const profile = await settle(await call("POST", `/profile/addons/${item.id}/github-read`, {}));
  const after = profile.addons.find((a) => a.id === item.id);
  expect(after?.github?.readTask?.status).toBe("done");
  const facts = profile.facts.filter((f) => f.itemId === item.id && f.origin === "github");
  const prompts = deps.fake.calls.map((c) => c.messages[0]?.content ?? "");
  return { lastRead: after?.github?.lastRead, facts, factsPrompt: prompts.find((p) => p.includes('"evidence"')) ?? "" };
}

/** A bare copy of `source` that serves blob-less clones over file://. */
async function bareRemote(): Promise<string> {
  const bare = join(dir, "remote.git");
  const git = createGit();
  expect((await git.run(["clone", "--quiet", "--bare", "--", source, bare])).exit).toBe(0);
  expect((await git.repo(bare, ["config", "uploadpack.allowFilter", "true"])).exit).toBe(0);
  return bare;
}

beforeEach(async () => {
  await resetDb();
  dir = await realpath(await mkdtemp(join(tmpdir(), "hb-gh-sources-")));
  source = join(dir, "tanod");
  await makeFileRepo(source, { commits: history(), remote: "git@github.com:juandc/tanod.git" });
});

describe("where a GitHub read's changes come from", () => {
  test("a clone in the projects folder: its commits and hunks, unpushed ones without a link", async () => {
    markPushed(source, "HEAD~1");
    await setup({ projects: true });
    const { lastRead, facts, factsPrompt } = await readRepo();
    expect(lastRead).toMatchObject({ commitsFrom: "local clone", share: { mine: 5, total: 6 } });
    expect(factsPrompt).toContain("+func Swap()");
    expect(factsPrompt).not.toContain("api change");
    const notify = facts.find((f) => f.text === "feat: notify tanods");
    expect(notify?.evidence).toMatchObject({ kind: "commit", url: null, private: false });
    const swap = facts.find((f) => f.text === "feat: swap shifts");
    expect(swap?.evidence?.url).toMatch(/^https:\/\/github\.com\/juandc\/tanod\/commit\/[0-9a-f]{40}$/);
  });

  test("public mode with no clone: a blob-less temp clone, deleted after the read", async () => {
    const remote = await bareRemote();
    const root = await mkdtemp(join(tmpdir(), "hb-clones-"));
    await setup({ cloner: createCloner({ git: createGit(), url: () => `file://${remote}`, protocol: "file", root }) });
    const { lastRead, factsPrompt } = await readRepo();
    expect(lastRead).toMatchObject({ commitsFrom: "temp clone", share: { mine: 5, total: 6 } });
    expect(factsPrompt).toContain("+func Send() {}");
    expect(await readdir(root)).toEqual([]);
  });

  test("a clone that fails falls back to 10 commits through the API", async () => {
    let tries = 0;
    await setup({
      cloner: {
        clone: async () => {
          tries += 1;
          throw new CloneError("Cloning juandc/tanod failed.");
        },
      },
    });
    const { lastRead, factsPrompt } = await readRepo();
    expect(tries).toBe(1);
    expect(lastRead?.commitsFrom).toBe("api");
    // 12 commits of mine, hunks for at most 10 of them.
    const changed = new Set([...factsPrompt.matchAll(/^<<< CHANGE ([0-9a-f]{12}) /gm)].map((m) => m[1]));
    expect(changed.size).toBeGreaterThan(0);
    expect(changed.size).toBeLessThanOrEqual(10);
  });

  test("a repo over 500 MB is never cloned", async () => {
    let tries = 0;
    await setup({
      sizeKb: 600 * 1024,
      cloner: {
        clone: async () => {
          tries += 1;
          throw new Error("must not clone");
        },
      },
    });
    const { lastRead } = await readRepo();
    expect(tries).toBe(0);
    expect(lastRead?.commitsFrom).toBe("api");
  });
});

describe("the temp clone", () => {
  test("lists commits without fetching a blob, then fetches only the picked commit's", async () => {
    const remote = await bareRemote();
    const root = await mkdtemp(join(tmpdir(), "hb-clones-"));
    const git = createGit();
    const cloner = createCloner({ git, url: () => `file://${remote}`, protocol: "file", root });
    const clone = await cloner.clone({ owner: "juandc", repo: "tanod", branch: "main" });
    const missing = async () =>
      (await git.repo(clone.path, ["rev-list", "--objects", "--missing=print", "HEAD"])).stdout
        .split("\n")
        .filter((l) => l.startsWith("?")).length;
    try {
      const before = await missing();
      expect(before).toBeGreaterThan(0);
      const commits = gitCommitSource(git, {
        path: clone.path,
        isMine: (e) => e === ME,
        from: "temp clone",
        sized: false,
      });
      const { mine, share } = await commits.list();
      expect(share).toEqual({ mine: 5, total: 6 });
      expect(mine[0]).toMatchObject({
        subject: "feat: notify tanods",
        sized: false,
        files: [{ path: "notify/sms.go" }],
      });
      expect(await missing()).toBe(before);

      const first = mine[0];
      if (!first) throw new Error("no commit");
      const [patch] = await commits.patches([first], async () => {});
      expect(patch?.files[0]?.patch).toContain("+func Send() {}");
      expect(await missing()).toBeLessThan(before);
    } finally {
      await clone.close();
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("only the allowed protocol is used, and a failed clone leaves nothing behind", async () => {
    const remote = await bareRemote();
    const root = await mkdtemp(join(tmpdir(), "hb-clones-"));
    const cloner = createCloner({ git: createGit(), url: () => `file://${remote}`, protocol: "https", root });
    await expect(cloner.clone({ owner: "juandc", repo: "tanod", branch: "main" })).rejects.toBeInstanceOf(CloneError);
    expect(await readdir(root)).toEqual([]);
  });
});
