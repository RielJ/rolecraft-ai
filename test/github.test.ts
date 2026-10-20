import { beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { GITHUB_TOKEN_CAP, MAX_GITHUB_COMMITS } from "@/domain/github-read";
import { githubUserFor } from "@/domain/project-role";
import { buildGithubFactsPrompt, estimateTokens } from "@/domain/prompts";
import { createFakeAi, type FakeAi } from "@/server/adapters/ai/fake";
import {
  createGhReader,
  createGhRunner,
  createPublicReader,
  createReader,
  type GhSpawn,
  GithubError,
  type GithubReader,
} from "@/server/adapters/github";
import {
  createFixtureReader,
  createFixtureTransport,
  GithubSnapshot,
  type GithubSnapshotInput,
} from "@/server/adapters/github-fixture";
import { createHttpClient } from "@/server/adapters/http";
import { createProjectsReader, type ProjectsReader } from "@/server/adapters/local-projects";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { githubAppError, privateGithubRepos } from "@/server/services/github";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  ApiErrorBody,
  ProfileDto,
  ProjectScanDto,
  TaskDto,
  TextExport,
  WorkspaceDto,
} from "@/shared/api";
import { parseGithubLink } from "@/shared/github-link";
import { githubExitCode, runGithubEval } from "../eval/run";
import { makeRepo } from "./git-repos";
import { resetDb, testDeps, testSql, waitForGithubReads, waitForSplits } from "./setup";

const FIXTURES = join(import.meta.dir, "fixtures", "github");
const JEEP = GithubSnapshot.parse(await Bun.file(join(FIXTURES, "jeep-route.json")).json());
const noPick = async () => [];

// ---------- A fake gh ----------

type GhAnswer = { stdout?: string; stderr?: string; exit?: number };

/** A fake `gh` that records every argv. `user --jq .login` answers `login`; other paths go to `answer`. */
function fakeGh({ login, answer }: { login: string; answer: (path: string) => Promise<GhAnswer> }) {
  const argvs: string[][] = [];
  const spawn: GhSpawn = (cmd) => {
    argvs.push(cmd);
    const path = cmd[6] ?? "";
    const result: Promise<GhAnswer> =
      path === "user" && cmd.includes("--jq") ? Promise.resolve({ stdout: `${login}\n` }) : answer(path);
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const err = new TransformStream<Uint8Array, Uint8Array>();
    void result.then(async (r) => {
      const enc = new TextEncoder();
      const ow = out.writable.getWriter();
      const ew = err.writable.getWriter();
      await ow.write(enc.encode(r.stdout ?? ""));
      await ew.write(enc.encode(r.stderr ?? ""));
      await ow.close();
      await ew.close();
      exit(r.exit ?? 0);
    });
    return { stdout: out.readable, stderr: err.readable, exited, kill() {} };
  };
  return { spawn, argvs };
}

const fromSnapshots = (snapshots: GithubSnapshotInput[]) => {
  const transport = createFixtureTransport({ snapshots });
  return async (path: string): Promise<GhAnswer> => {
    try {
      return { stdout: await transport.get(path) };
    } catch {
      return { stderr: "gh: Not Found (HTTP 404)", exit: 1 };
    }
  };
};

const repoLink = (url: string) => {
  const link = parseGithubLink(url);
  if (!link) throw new Error(`not a github link: ${url}`);
  return link;
};

describe("gh reader", () => {
  test("checks the active account before any call, then reads only through `gh api`; never `gh auth`", async () => {
    const gh = fakeGh({ login: "JuanDC", answer: fromSnapshots([JEEP]) });
    const reader = createGhReader({ user: "juandc", spawn: gh.spawn });
    const bundle = await reader.read({
      link: repoLink("https://github.com/juandc/jeep-route"),
      user: "juandc",
      pick: noPick,
    });
    expect(bundle.owner).toBe("juandc");
    // The first call is the login check; every call is `gh api`, with an argv array and no shell.
    expect(gh.argvs[0]).toEqual([
      "gh",
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "user",
      "--jq",
      ".login",
    ]);
    expect(gh.argvs.length).toBeGreaterThan(3);
    for (const argv of gh.argvs) {
      expect(argv[0]).toBe("gh");
      expect(argv[1]).toBe("api");
      expect(argv).not.toContain("auth");
      expect(argv.some((a) => /token|hosts\.yml|switch|login$/.test(a) && a !== ".login")).toBe(false);
      expect(argv).not.toContain("-c");
    }
  });

  test("refuses on an account mismatch, naming both accounts, before reading anything", async () => {
    const gh = fakeGh({ login: "acme-work", answer: fromSnapshots([JEEP]) });
    const reader = createGhReader({ user: "juandc", spawn: gh.spawn });
    const read = reader.read({ link: repoLink("https://github.com/juandc/jeep-route"), user: "juandc", pick: noPick });
    const err = await read.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err).toMatchObject({ kind: "account_mismatch" });
    expect(String((err as Error).message)).toContain('"acme-work"');
    expect(String((err as Error).message)).toContain('"juandc"');
    expect(gh.argvs).toHaveLength(1);
    expect(githubAppError(err as GithubError)).toMatchObject({ code: "github_account", status: 409 });
  });

  test("a gh argv that would contain `auth` is refused without spawning", async () => {
    const gh = fakeGh({ login: "juandc", answer: async () => ({ stdout: "{}" }) });
    const run = createGhRunner({ spawn: gh.spawn });
    await expect(run({ path: "auth" })).rejects.toThrow("Refusing to run a gh auth command.");
    expect(gh.argvs).toHaveLength(0);
  });

  test("gh failures map to clear errors", async () => {
    const run = (answer: GhAnswer) =>
      createGhRunner({ spawn: fakeGh({ login: "x", answer: async () => answer }).spawn })({ path: "repos/a/b" });
    await expect(run({ stderr: "gh: Not Found (HTTP 404)", exit: 1 })).rejects.toMatchObject({ kind: "not_found" });
    await expect(run({ stderr: "gh: API rate limit exceeded (HTTP 403)", exit: 1 })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    await expect(
      run({ stderr: "To get started with GitHub CLI, please run: gh auth login", exit: 4 }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

// ---------- Listing owned repos (decision 78) ----------

/** One repo as `user/repos` sends it. */
const listed = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  owner: { login: "juandc" },
  private: false,
  fork: false,
  archived: false,
  size: 120,
  language: "Go",
  stargazers_count: 2,
  pushed_at: "2026-09-01T00:00:00Z",
  description: `${name} description`,
  ...over,
});

describe("listing owned repos", () => {
  test("gh checks the account first, then lists the owner's repos page by page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => listed(`r${i}`));
    const page2 = [listed("secret", { private: true }), listed("org-repo", { owner: { login: "acme" } })];
    const gh = fakeGh({
      login: "JuanDC",
      answer: async (path) => ({ stdout: JSON.stringify(path.endsWith("page=1") ? page1 : page2) }),
    });
    const reader = createGhReader({ user: "juandc", spawn: gh.spawn });
    const repos = (await reader.list?.({ user: "someone-else" })) ?? [];
    expect(gh.argvs.map((a) => a[6])).toEqual([
      "user",
      "user/repos?affiliation=owner&sort=pushed&per_page=100&page=1",
      "user/repos?affiliation=owner&sort=pushed&per_page=100&page=2",
    ]);
    // 100 + the private one; a repo owned by anyone else is dropped even if GitHub sends it.
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toEqual({
      owner: "juandc",
      name: "secret",
      private: true,
      fork: false,
      archived: false,
      sizeKb: 120,
      language: "Go",
      stars: 2,
      pushedAt: "2026-09-01T00:00:00Z",
      description: "secret description",
    });
  });

  test("stops after three pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => listed(`r${i}`));
    const gh = fakeGh({ login: "juandc", answer: async () => ({ stdout: JSON.stringify(full) }) });
    const repos = (await createGhReader({ user: "juandc", spawn: gh.spawn }).list?.({ user: "juandc" })) ?? [];
    expect(repos).toHaveLength(300);
    expect(gh.argvs).toHaveLength(4);
  });

  test("refuses on the wrong gh account before listing anything", async () => {
    const gh = fakeGh({ login: "rielj-work", answer: async () => ({ stdout: "[]" }) });
    const list = createGhReader({ user: "juandc", spawn: gh.spawn }).list?.({ user: "juandc" });
    await expect(list ?? Promise.resolve()).rejects.toMatchObject({ kind: "account_mismatch" });
    expect(gh.argvs).toHaveLength(1);
  });

  test("the public reader can't list", () => {
    expect(createPublicReader({ http: createHttpClient({}), user: "juandc" }).list).toBeNull();
  });

  test("the fixture reader lists the snapshots the user owns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-gh-list-"));
    await cp(FIXTURES, dir, { recursive: true });
    const repos = (await createFixtureReader({ dir, user: null }).list?.({ user: "JUANDC" })) ?? [];
    expect(repos.map((r) => r.name).sort()).toEqual(["jeep-route", "sari-ledger"]);
  });
});

// ---------- The public reader over a fake fetch ----------

/** A fetch that serves api.github.com from snapshots, recording each URL and its User-Agent. */
function githubFetch(snapshots: GithubSnapshotInput[], override?: (url: URL) => Response | null) {
  const transport = createFixtureTransport({ snapshots });
  const seen: { url: string; agent: string | null }[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    seen.push({ url: input, agent: new Headers(init.headers).get("user-agent") });
    const forced = override?.(url);
    if (forced) return forced;
    if (url.hostname !== "api.github.com") return new Response("no", { status: 404 });
    try {
      return new Response(await transport.get(`${url.pathname.slice(1)}${url.search}`), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
  };
  return { http: createHttpClient({ fetch, sleep: async () => {} }), seen };
}

describe("public reader", () => {
  test("reads unauthenticated REST through the shared HTTP client, and records visibility", async () => {
    const { http, seen } = githubFetch([JEEP]);
    const reader = createPublicReader({ http, user: null });
    const bundle = await reader.read({
      link: repoLink("https://github.com/juandc/jeep-route.git"),
      user: "juandc",
      pick: async () => ["src/planner.ts"],
    });
    expect(bundle.kind).toBe("repo");
    expect(bundle.private).toBe(false);
    expect(bundle.kind === "repo" && bundle.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/planner.ts",
    ]);
    // Only the user's commits, newest first.
    expect(bundle.commits.map((c) => c.subject)).not.toContain("Fix typo in README");
    expect(bundle.commits).toHaveLength(5);
    expect(new Set(seen.map((s) => new URL(s.url).hostname))).toEqual(new Set(["api.github.com"]));
    expect(seen.every((s) => s.agent === "hanapbuhay/0.1 (personal use)")).toBe(true);
    expect(seen.some((s) => s.url.includes("commits?author=juandc&per_page=100"))).toBe(true);
  });

  test("a rate limit (403 or 429 after retries) is a clear 429 AppError", async () => {
    for (const status of [403, 429]) {
      const { http, seen } = githubFetch([JEEP], () => new Response("{}", { status }));
      const reader = createPublicReader({ http, user: null });
      const err = await reader
        .read({ link: repoLink("https://github.com/juandc/jeep-route"), user: "juandc", pick: noPick })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: "rate_limited" });
      const app = githubAppError(err as GithubError);
      expect(app).toMatchObject({ code: "github_rate_limited", status: 429 });
      expect(app.message).toContain("HB_GITHUB=gh");
      // 429 is retried by the HTTP client (3 attempts); 403 is not.
      expect(seen).toHaveLength(status === 429 ? 3 : 1);
    }
  });

  test("a repo it cannot see is not found, with the gh hint", async () => {
    const { http } = githubFetch([]);
    const err = await createPublicReader({ http, user: null })
      .read({ link: repoLink("https://github.com/juandc/sari-ledger"), user: "juandc", pick: noPick })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not_found" });
    expect(String((err as Error).message)).toContain("HB_GITHUB=gh");
  });

  test("a pull request reads title, body, diff stat, the user's commits on it and the review discussion", async () => {
    const sha = (n: number) => String(n).repeat(40).slice(0, 40);
    const snapshot: GithubSnapshotInput = {
      owner: "acme",
      repo: "api",
      private: true,
      description: "Acme API",
      defaultBranch: "main",
      files: {},
      commits: [],
      pulls: [
        {
          number: 7,
          title: "Retry failed webhooks",
          body: "Adds retries with exponential backoff.",
          author: "juandc",
          headSha: sha(9),
          files: [{ path: "src/webhooks.ts", additions: 40, deletions: 3 }],
          commits: [
            { sha: sha(1), message: "Retry webhooks with backoff", author: "juandc" },
            { sha: sha(2), message: "Tweak names", author: "maria" },
          ],
          comments: [{ author: "maria", body: "Thanks!" }],
          reviewComments: [{ author: "maria", body: "Cap the delay?" }],
          reviews: [{ author: "maria", body: "Approved." }],
        },
      ],
    };
    const { http } = githubFetch([snapshot]);
    const bundle = await createPublicReader({ http, user: null }).read({
      link: repoLink("https://github.com/acme/api/pull/7/files"),
      user: "juandc",
      pick: noPick,
    });
    expect(bundle).toMatchObject({
      kind: "pull",
      number: 7,
      status: "merged",
      private: true,
      title: "Retry failed webhooks",
      body: "Adds retries with exponential backoff.",
      author: "juandc",
      at: sha(9),
      changed: [{ path: "src/webhooks.ts", additions: 40, deletions: 3 }],
      commits: [{ sha: sha(1), subject: "Retry webhooks with backoff" }],
    });
    expect(bundle.kind === "pull" && bundle.discussion.map((d) => d.body)).toEqual([
      "Thanks!",
      "Cap the delay?",
      "Approved.",
    ]);
  });
});

test("a pull request's status is merged, open or closed without merging", async () => {
  const statuses = ["merged", "open", "closed"] as const;
  const snapshot: GithubSnapshotInput = {
    owner: "acme",
    repo: "api",
    private: false,
    description: "",
    defaultBranch: "main",
    files: {},
    commits: [],
    pulls: statuses.map((status, i) => ({
      number: i + 1,
      title: `PR ${status}`,
      author: "juandc",
      headSha: "a".repeat(40),
      status,
      files: [],
      commits: [],
    })),
  };
  const { http } = githubFetch([snapshot]);
  const reader = createPublicReader({ http, user: null });
  const read = async (n: number) =>
    reader.read({ link: repoLink(`https://github.com/acme/api/pull/${n}`), user: "juandc", pick: noPick });
  const got = await Promise.all([1, 2, 3].map(read));
  expect(got.map((b) => b.kind === "pull" && b.status)).toEqual([...statuses]);
});

// ---------- Limits ----------

describe("read limits", () => {
  const big = (n: number) => `${"const x = 1; // filler line for the cap\n".repeat(n)}`;
  const shaOf = (i: number) => i.toString(16).padStart(40, "0");
  const busy: GithubSnapshotInput = {
    owner: "juandc",
    repo: "busy",
    private: false,
    description: "Busy repo",
    defaultBranch: "main",
    files: {
      "README.md": big(2000),
      "package.json": big(200),
      "go.mod": big(200),
      ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/module-number-${i}/f${i}.ts`, big(400)])),
    },
    commits: Array.from({ length: 80 }, (_, i) => ({
      sha: shaOf(i + 1),
      message: `Change ${i}: ${"rework the module loader so it reads fewer files on start ".repeat(3)}`,
      author: "juandc",
    })),
    pulls: [],
  };

  test("at most README, manifests, tree, 5 valid picks and 50 commits, stopping at the token cap", async () => {
    const log: string[] = [];
    const reader = createReader({
      mode: "fixture",
      user: null,
      transport: createFixtureTransport({ snapshots: [busy], log }),
    });
    const bundle = await reader.read({
      link: repoLink("https://github.com/juandc/busy"),
      user: "juandc",
      // Extras, an unknown path and a repeat: only valid tree paths count, and at most five.
      pick: async () => [
        "../../etc/passwd",
        "src/nope.ts",
        "README.md",
        ...Array.from({ length: 8 }, (_, i) => `src/module-number-${i}/f${i}.ts`),
      ],
    });
    if (bundle.kind !== "repo") throw new Error("expected a repo");
    expect(bundle.commits.length).toBeLessThanOrEqual(MAX_GITHUB_COMMITS);
    expect(bundle.tokens).toBeLessThanOrEqual(GITHUB_TOKEN_CAP);
    const fileReads = log.filter((p) => p.includes("/contents/src/"));
    // The cap ran out before five picks were read.
    expect(fileReads.length).toBeGreaterThan(0);
    expect(fileReads.length).toBeLessThan(5);
    expect(fileReads.every((p) => /contents\/src\/module-number-[0-7]\/f[0-7]\.ts/.test(p))).toBe(true);
    expect(log.some((p) => p.includes("nope") || p.includes("passwd"))).toBe(false);
    expect(bundle.files.map((f) => f.path).slice(0, 3)).toEqual(["README.md", "package.json", "go.mod"]);
    // The whole extraction prompt stays near the cap.
    const prompt = buildGithubFactsPrompt({ bundle });
    expect(estimateTokens(prompt.system + prompt.messages[0].content)).toBeLessThan(GITHUB_TOKEN_CAP + 2500);
  });

  test("with room left, at most five picks are read", async () => {
    const small: GithubSnapshotInput = {
      ...busy,
      files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, "export {}"])),
      pulls: [],
      commits: (busy.commits ?? []).slice(0, 3),
    };
    const log: string[] = [];
    const reader = createReader({
      mode: "fixture",
      user: null,
      transport: createFixtureTransport({ snapshots: [small], log }),
    });
    const bundle = await reader.read({
      link: repoLink("https://github.com/juandc/busy"),
      user: "juandc",
      pick: async () => Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
    });
    expect(bundle.kind === "repo" && bundle.files).toHaveLength(5);
    expect(log.filter((p) => p.includes("/contents/src/"))).toHaveLength(5);
  });
});

// ---------- The service, end to end over HTTP ----------

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

async function settle(res: Response, status = 200): Promise<ProfileDto> {
  const profile = await json(res, ProfileDto, status);
  await waitForSplits(profile);
  await waitForGithubReads(profile);
  return json(await call("GET", "/profile"), ProfileDto);
}

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hb-github-"));
  await cp(FIXTURES, dir, { recursive: true });
  return dir;
}

async function setup(
  github: GithubReader,
  {
    links = ["https://github.com/juandc"],
    projects = null,
  }: { links?: string[]; projects?: ProjectsReader | null } = {},
) {
  await resetDb();
  deps = await testDeps({ github, projects });
  app = createApp(deps);
  expect((await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
  const contact = { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Cebu", links };
  expect((await call("PUT", "/profile", { contact })).status).toBe(200);
}

async function addRepo(link: string) {
  const profile = await settle(
    await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "Side project",
      body: "My side project.",
      link,
    }),
    201,
  );
  const item = profile.addons.at(-1);
  if (!item) throw new Error("no add-on");
  return item;
}

const read = async (itemId: string, status = 200) =>
  settle(await call("POST", `/profile/addons/${itemId}/github-read`, {}), status);
const githubFacts = (p: ProfileDto) => p.facts.filter((f) => f.origin === "github");

describe("Read from GitHub", () => {
  beforeEach(async () => {
    await setup(createFixtureReader({ dir: await fixtureDir(), user: null }));
  });

  test("read → pending facts, each with a file or commit link; confirm one by one", async () => {
    const item = await addRepo("https://github.com/juandc/jeep-route");
    expect(item.github).toMatchObject({ kind: "repo", label: "juandc/jeep-route", private: null, readTask: null });
    const profile = await read(item.id);
    const after = profile.addons.find((a) => a.id === item.id);
    expect(after?.github?.readTask?.status).toBe("done");
    expect(after?.github?.private).toBe(false);
    expect(after?.github?.lastRead).toMatchObject({
      user: "juandc",
      userFrom: "profile link",
      via: "fixture",
      private: false,
    });
    expect(after?.github?.lastRead?.tokens).toBeLessThanOrEqual(GITHUB_TOKEN_CAP);

    const facts = githubFacts(profile);
    expect(facts.length).toBeGreaterThan(1);
    for (const f of facts) {
      expect(f.status).toBe("pending");
      expect(f.evidence?.url).toMatch(/^https:\/\/github\.com\/juandc\/jeep-route\/(commit|blob)\//);
    }
    expect(facts.map((f) => f.text)).toContain("Load 42 routes from Cebu open data into SQLite");
    // Another person's commit is not the user's fact.
    expect(facts.map((f) => f.text)).not.toContain("Fix typo in README");
    // The add-on's own text split still made its own fact.
    expect(profile.facts.some((f) => f.origin === "text" && f.text === "My side project.")).toBe(true);

    const first = facts[0];
    if (!first) throw new Error("no fact");
    const confirmed = await json(await call("POST", `/facts/${first.id}/confirm`), ProfileDto);
    expect(
      githubFacts(confirmed)
        .filter((f) => f.status === "confirmed")
        .map((f) => f.id),
    ).toEqual([first.id]);
    // Grouping the commits into features, picking files and finding facts: all logged under github.
    const calls = await testSql()`SELECT purpose, tier FROM ai_calls ORDER BY created_at`;
    expect([...calls].filter((c) => c.purpose === "github")).toEqual([
      { purpose: "github", tier: "light" },
      { purpose: "github", tier: "light" },
      { purpose: "github", tier: "light" },
    ]);
    // Commits came through the fixture API, with hunks of the picked ones (decision 81).
    expect(after?.github?.lastRead?.commitsFrom).toBe("api");
  });

  test("facts citing evidence that was not read are dropped in code", async () => {
    const item = await addRepo("https://github.com/juandc/jeep-route");
    deps.fake.queue(
      // No usable feature: the biggest commits are read instead.
      JSON.stringify({ features: [] }),
      JSON.stringify({ files: ["src/planner.ts"] }),
      JSON.stringify({
        facts: [
          { text: "Planned trips with the fewest transfers", evidence: "src/planner.ts" },
          { text: "Wrote the fare rules", evidence: "src/fares.ts" },
          { text: "Led a team of 50", evidence: "0000000000000000000000000000000000000000" },
        ],
      }),
    );
    const profile = await read(item.id);
    expect(githubFacts(profile).map((f) => f.text)).toEqual(["Planned trips with the fewest transfers"]);
    expect(profile.addons[0]?.github?.lastRead?.dropped.map((d) => d.text)).toEqual([
      "Wrote the fare rules",
      "Led a team of 50",
    ]);
  });

  test("a private repo's facts are marked private", async () => {
    const item = await addRepo("https://github.com/juandc/sari-ledger");
    const profile = await read(item.id);
    expect(profile.addons[0]?.github?.private).toBe(true);
    expect(githubFacts(profile).length).toBeGreaterThan(0);
    expect(githubFacts(profile).every((f) => f.evidence?.private === true)).toBe(true);
  });

  test("Re-read diffs like a CV re-import: confirmed facts that vanished stay until Keep or Delete", async () => {
    const dir = await fixtureDir();
    await setup(createFixtureReader({ dir, user: null }));
    const item = await addRepo("https://github.com/juandc/jeep-route");
    const first = await read(item.id);
    const facts = githubFacts(first);
    const target = facts.find((f) => f.text === "Load 42 routes from Cebu open data into SQLite");
    const pendingGone = facts.find((f) => f.text === "Serve /plan over HTTP with Hono");
    if (!target || !pendingGone) throw new Error("missing facts");
    await call("POST", `/facts/${target.id}/confirm`);

    // The repo changes: both commits are gone, one new one appears.
    const snapshot = { ...JEEP };
    snapshot.commits = [
      { sha: "f".repeat(40), message: "Show the fare in the reply", author: "juandc", date: null, files: [] },
      ...JEEP.commits.filter((c) => !/42 routes|Serve \/plan/.test(c.message)),
    ];
    await writeFile(join(dir, "jeep-route.json"), JSON.stringify(snapshot));
    const again = await read(item.id);
    const now = githubFacts(again);
    expect(again.addons[0]?.github?.lastRead).toMatchObject({ added: 1, removed: 1, vanished: 1 });
    expect(now.find((f) => f.text === "Show the fare in the reply")?.status).toBe("pending");
    expect(now.some((f) => f.id === pendingGone.id)).toBe(false);
    const vanished = now.find((f) => f.id === target.id);
    expect(vanished).toMatchObject({ status: "confirmed", inLatest: false });
    // Unchanged facts keep their id and key.
    const kept = facts.find((f) => f.text.startsWith("Plan trips"));
    expect(kept).toBeDefined();
    expect(now.find((f) => f.text.startsWith("Plan trips"))?.key).toBe(kept?.key);

    const keep = await json(await call("POST", `/facts/${target.id}/keep`), ProfileDto);
    expect(keep.facts.find((f) => f.id === target.id)?.inLatest).toBe(true);
  });

  test("a re-split of the add-on text and a GitHub re-read never remove each other's facts", async () => {
    const item = await addRepo("https://github.com/juandc/jeep-route");
    const before = githubFacts(await read(item.id)).length;
    const edited = await settle(
      await call("PUT", `/profile/addons/${item.id}`, {
        kind: "open_source",
        title: "Side project",
        body: "Rewrote the planner.",
        link: "https://github.com/juandc/jeep-route",
      }),
    );
    expect(githubFacts(edited)).toHaveLength(before);
    expect(githubFacts(edited).every((f) => f.inLatest)).toBe(true);
    expect(edited.facts.filter((f) => f.origin === "text").map((f) => f.text)).toEqual(["Rewrote the planner."]);
    const reread = await read(item.id);
    expect(reread.facts.filter((f) => f.origin === "text").map((f) => f.text)).toEqual(["Rewrote the planner."]);
  });

  test("a read leaves out facts the add-on's own text already says", async () => {
    const control = githubFacts(await read((await addRepo("https://github.com/juandc/jeep-route")).id)).map(
      (f) => f.text,
    );
    // The read alone says what the project is.
    const SAID = "Plans jeepney trips across Cebu City using 42 routes from the city's open data.";
    expect(control).toContain(SAID);

    await setup(createFixtureReader({ dir: await fixtureDir(), user: null }));
    const profile = await settle(
      await call("POST", "/profile/addons", {
        kind: "open_source",
        title: "jeep-route",
        body: SAID,
        link: "https://github.com/juandc/jeep-route",
      }),
      201,
    );
    const item = profile.addons.at(-1);
    if (!item) throw new Error("no add-on");
    const after = await read(item.id);
    expect(after.facts.filter((f) => f.text === SAID).map((f) => f.origin)).toEqual(["text"]);
    expect(githubFacts(after).map((f) => f.text)).toEqual(control.filter((t) => t !== SAID));
  });

  test("other links are stored only; a read without a GitHub user asks for one", async () => {
    const other = await settle(
      await call("POST", "/profile/addons", {
        kind: "challenge",
        title: "Hackathon",
        body: "Won second place.",
        link: "https://devpost.com/software/x",
      }),
      201,
    );
    const item = other.addons[0];
    expect(item?.github).toBeNull();
    const refused = await json(await call("POST", `/profile/addons/${item?.id}/github-read`, {}), ApiErrorBody, 400);
    expect(refused.error.code).toBe("invalid_input");

    await call("PUT", "/profile", { contact: { fullName: "Juan", email: "", phone: "", location: "", links: [] } });
    const repo = await addRepo("https://github.com/juandc/jeep-route");
    const ask = await json(await call("POST", `/profile/addons/${repo.id}/github-read`, {}), ApiErrorBody, 409);
    expect(ask.error.code).toBe("needs_input");
    expect(ask.error.message).toContain("HB_GITHUB_USER");
  });

  test("HB_GITHUB_USER wins over the profile link, and the summary says which was used", async () => {
    await setup(createFixtureReader({ dir: FIXTURES, user: "JuanDC" }), { links: ["https://github.com/someone-else"] });
    const item = await addRepo("https://github.com/juandc/jeep-route");
    const profile = await read(item.id);
    expect(profile.addons[0]?.github?.lastRead).toMatchObject({ user: "JuanDC", userFrom: "HB_GITHUB_USER" });
    expect(githubFacts(profile).length).toBeGreaterThan(0);
    expect(
      githubUserFor({
        configured: null,
        links: ["https://x.com/a", "github.com/juandc/repo", "https://github.com/juandc"],
      }),
    ).toEqual({
      user: "juandc",
      from: "profile link",
    });
  });

  test("a gh account mismatch fails the task with both names; Retry starts it again", async () => {
    const gh = fakeGh({ login: "acme-work", answer: fromSnapshots([JEEP]) });
    await setup(createGhReader({ user: "juandc", spawn: gh.spawn }));
    const item = await addRepo("https://github.com/juandc/jeep-route");
    const profile = await read(item.id);
    const task = profile.addons[0]?.github?.readTask;
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain('"acme-work"');
    expect(task?.error).toContain('"juandc"');
    expect(githubFacts(profile)).toEqual([]);
    expect(gh.argvs.every((a) => !a.includes("auth"))).toBe(true);

    const retried = await json(await call("POST", `/tasks/${task?.id}/retry`, {}), TaskDto, 202);
    await waitForTask(retried.id);
    expect(retried.kind).toBe("github_read");
  });

  test("a rate limit fails the task with the clear message", async () => {
    const { http } = githubFetch([JEEP], () => new Response("{}", { status: 403 }));
    await setup(createPublicReader({ http, user: null }));
    const item = await addRepo("https://github.com/juandc/jeep-route");
    const task = (await read(item.id)).addons[0]?.github?.readTask;
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("60 requests an hour");
  });
});

// ---------- Export filter ----------

describe("export filter", () => {
  test("an exported file never contains a private repo or commit URL", async () => {
    await setup(createFixtureReader({ dir: FIXTURES, user: null }), {
      links: ["https://github.com/juandc", "https://github.com/juandc/sari-ledger"],
    });
    const priv = await addRepo("https://github.com/juandc/sari-ledger");
    await read(priv.id);
    const pub = await addRepo("https://github.com/juandc/jeep-route");
    const profile = await read(pub.id);
    await call("POST", "/facts/confirm-all");
    const privFact = githubFacts(profile).find((f) => f.evidence?.private && f.evidence.kind === "commit");
    const pubFact = githubFacts(profile).find((f) => !f.evidence?.private);
    if (!privFact?.evidence?.url || !pubFact?.evidence?.url) throw new Error("missing facts");
    const privateUrl = privFact.evidence.url;
    const publicUrl = pubFact.evidence.url;

    const added = await json(
      await call("POST", "/jobs/from-paste", {
        title: "Backend Engineer",
        company: "Acme",
        description: "Remote, worldwide. Go and TypeScript.",
      }),
      AddJobResult,
      201,
    );
    const ws = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    const byKind = (k: string) => ws.files.find((f) => f.kind === k)?.id ?? "";
    const draft = [
      "# Juan Dela Cruz",
      `- ${privFact.text} (${privateUrl}) [${privFact.key}]`,
      `- Source: https://github.com/juandc/sari-ledger and github.com/JuanDC/sari-ledger/blob/main/go.mod. [${privFact.key}]`,
      `- ${pubFact.text}, see ${publicUrl} [${pubFact.key}]`,
    ].join("\n");
    await call("PATCH", `/outputs/${byKind("letter")}`, { body: `Dear Acme, see ${privateUrl} [${privFact.key}].` });
    await call("PATCH", `/outputs/${byKind("message")}`, { body: `Hi [${pubFact.key}].` });
    await call("PATCH", `/outputs/${byKind("resume")}`, { body: draft });

    const text = await json(await call("GET", `/outputs/${byKind("resume")}/text`), TextExport);
    expect(text.text).not.toMatch(/sari-ledger/i);
    expect(text.text).toContain(privFact.text);
    expect(text.text).toContain(publicUrl);
    const letter = await json(await call("GET", `/outputs/${byKind("letter")}/text`), TextExport);
    expect(letter.text).toBe("Dear Acme, see.");

    const pdf = await call("GET", `/outputs/${byKind("resume")}/export.pdf`);
    expect(pdf.status).toBe(200);
    const doc = await getDocumentProxy(new Uint8Array(await pdf.arrayBuffer()));
    const { text: pdfText } = await extractText(doc, { mergePages: true });
    expect(pdfText).not.toMatch(/sari-ledger/i);
    // The public profile link stays in the contact line; the private repo link does not.
    expect(pdfText).toContain("github.com/juandc");
    expect(pdfText).toContain("jeep-route");

    // The preview and the read-only plain text never show the private links either.
    const preview = await call("GET", `/outputs/${byKind("resume")}/preview.pdf`);
    expect(preview.status).toBe(200);
    const previewDoc = await getDocumentProxy(new Uint8Array(await preview.arrayBuffer()));
    expect((await extractText(previewDoc, { mergePages: true })).text).not.toMatch(/sari-ledger/i);
    const after = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    for (const f of after.files) expect(f.plain ?? "").not.toMatch(/sari-ledger/i);
  });
});

// ---------- Finding repos (decision 78) ----------

/** A minimal snapshot for the listing; it has no files, so it is never read in these tests. */
const listedOnly = (repo: string, over: Partial<GithubSnapshotInput> = {}): GithubSnapshotInput => ({
  owner: "juandc",
  repo,
  private: false,
  description: null,
  files: {},
  ...over,
});

async function listingDir(extra: GithubSnapshotInput[]): Promise<string> {
  const dir = await fixtureDir();
  for (const snapshot of extra) await Bun.write(join(dir, `${snapshot.repo}.json`), JSON.stringify(snapshot));
  return dir;
}

const scanBoth = async () => json(await call("GET", "/profile/projects"), ProjectScanDto);
const scan = async () => {
  const { github } = await scanBoth();
  if (github?.status !== "ok") throw new Error(`no GitHub listing: ${JSON.stringify(github)}`);
  return github;
};

describe("Find my projects: GitHub", () => {
  beforeEach(async () => {
    const dir = await listingDir([
      listedOnly("forked-lib", { fork: true, pushedAt: "2026-10-01T00:00:00Z" }),
      listedOnly("juandc", { sizeKb: 3 }),
      listedOnly("empty", { sizeKb: 1, pushedAt: "2026-07-01T00:00:00Z" }),
      listedOnly("org-thing", { owner: "acme" }),
    ]);
    await setup(createFixtureReader({ dir, user: null }));
  });

  test("lists the user's repos; rules move forks, the profile repo and tiny repos to a hidden group", async () => {
    expect((await json(await call("GET", "/profile"), ProfileDto)).projectScan).toEqual({ github: true, local: false });
    expect((await scanBoth()).local).toBeNull();
    const result = await scan();
    expect(result.user).toBe("juandc");
    expect(result.shown.map((r) => [r.name, r.private, r.language, r.added])).toEqual([
      ["jeep-route", false, "TypeScript", false],
      ["sari-ledger", true, "Go", false],
    ]);
    expect(result.shown[0]?.url).toBe("https://github.com/juandc/jeep-route");
    expect(result.hidden.map((r) => [r.name, r.hiddenBy])).toEqual([
      ["forked-lib", "fork"],
      ["empty", "small"],
      ["juandc", "profile"],
    ]);
    // Another owner's repo is never listed.
    expect([...result.shown, ...result.hidden].map((r) => r.name)).not.toContain("org-thing");
  });

  test("adds picked repos, hidden ones included, as open-source add-ons split into facts", async () => {
    const profile = await settle(
      await call("POST", "/profile/projects", { repos: ["jeep-route", "forked-lib", "org-thing", "nope"] }),
    );
    expect(
      profile.addons.map((a) => ({ kind: a.kind, title: a.title, body: a.body, link: a.link, skills: a.skills })),
    ).toEqual([
      {
        kind: "open_source",
        title: "jeep-route",
        body: "Jeepney route planner for Cebu City",
        link: "https://github.com/juandc/jeep-route",
        skills: ["TypeScript"],
      },
      {
        kind: "open_source",
        title: "forked-lib",
        body: "forked-lib, a repository on GitHub.",
        link: "https://github.com/juandc/forked-lib",
        skills: [],
      },
    ]);
    // Each add-on's text was split; nothing was read from GitHub yet.
    expect(profile.facts.some((f) => f.text === "Jeepney route planner for Cebu City")).toBe(true);
    expect(profile.facts.some((f) => f.origin === "github")).toBe(false);
    expect(profile.addons.every((a) => a.github?.readTask === null)).toBe(true);

    // A rescan marks them added, and adding them again is refused.
    const after = await scan();
    expect(after.shown.find((r) => r.name === "jeep-route")?.added).toBe(true);
    expect(after.hidden.find((r) => r.name === "forked-lib")?.added).toBe(true);
    const again = await call("POST", "/profile/projects", { repos: ["jeep-route"] });
    expect(again.status).toBe(409);
  });

  test("a private repo is marked private when added, before any read", async () => {
    const profile = await settle(await call("POST", "/profile/projects", { repos: ["sari-ledger"] }));
    expect(profile.addons[0]?.github?.private).toBe(true);
    expect(profile.addons[0]?.github?.lastRead).toBeNull();
    expect(await privateGithubRepos(deps)).toEqual([{ owner: "juandc", repo: "sari-ledger" }]);
  });

  test("rejects more than 20 names at once, counting both sources, and an empty pick", async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const folders = Array.from({ length: 9 }, (_, i) => `f${i}`);
    expect((await call("POST", "/profile/projects", { repos, folders })).status).toBe(400);
    expect((await call("POST", "/profile/projects", {})).status).toBe(400);
  });

  test("without gh or a projects folder, the option is off and the routes answer 409", async () => {
    await setup(createPublicReader({ http: createHttpClient({}), user: null }));
    expect((await json(await call("GET", "/profile"), ProfileDto)).projectScan).toEqual({
      github: false,
      local: false,
    });
    expect((await call("GET", "/profile/projects")).status).toBe(409);
    expect((await call("POST", "/profile/projects", { repos: ["jeep-route"] })).status).toBe(409);
  });
});

describe("Find my projects: a local folder", () => {
  const ME = "juan@example.ph";
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-projects-"));
    // A clone of a listed repo GitHub calls nearly empty, with real history and a README.
    await makeRepo(join(dir, "empty-clone"), { commits: { [ME]: 7 }, remote: "git@github.com:juandc/empty.git" });
    await Bun.write(join(dir, "empty-clone", "README.md"), "# empty\n\nOffline flashcards for the LET exam.");
    await makeRepo(join(dir, "kain-tayo"), { commits: { [ME]: 9 } });
    await Bun.write(join(dir, "kain-tayo", "README.md"), "# Kain Tayo\n\nRecipe planner for carinderias.");
    await Bun.write(join(dir, "kain-tayo", "go.mod"), "module kain");
    await makeRepo(join(dir, "their-lib"), {
      commits: { "maria@example.ph": 8, [ME]: 1 },
      remote: "https://github.com/maria/their-lib.git",
    });
  });

  const local = async () => {
    const { local } = await scanBoth();
    if (local?.status !== "ok") throw new Error(`no local scan: ${JSON.stringify(local)}`);
    return local;
  };

  test("folders are split by rules; a clone of a listed repo shows under GitHub and lifts it out of hidden", async () => {
    const listing = await listingDir([listedOnly("empty", { sizeKb: 1 })]);
    await setup(createFixtureReader({ dir: listing, user: null }), {
      projects: createProjectsReader({ dir, extraEmails: [ME], readConfigEmail: false }),
    });
    expect((await json(await call("GET", "/profile"), ProfileDto)).projectScan).toEqual({ github: true, local: true });
    const found = await local();
    expect(found.dir).toBe(dir);
    expect(found.onGithub).toBe(1);
    expect(found.shown.map((f) => [f.folder, f.languages, f.summary, f.url])).toEqual([
      ["kain-tayo", ["Go"], "Recipe planner for carinderias.", null],
    ]);
    expect(found.hidden.map((f) => [f.folder, f.hiddenBy])).toEqual([["their-lib", "others"]]);

    const github = await scan();
    const empty = github.shown.find((r) => r.name === "empty");
    expect(empty).toMatchObject({ localCommits: 7, description: "Offline flashcards for the LET exam." });
    expect(github.hidden.map((r) => r.name)).not.toContain("empty");
  });

  test("adds picked folders and repos together; text comes from the scan, not the request", async () => {
    const listing = await listingDir([listedOnly("empty", { sizeKb: 1 })]);
    await setup(createFixtureReader({ dir: listing, user: null }), {
      projects: createProjectsReader({ dir, extraEmails: [ME], readConfigEmail: false }),
    });
    const profile = await settle(
      await call("POST", "/profile/projects", { repos: ["empty"], folders: ["kain-tayo", "their-lib", "../etc"] }),
    );
    // GitHub repos first, then folders, each in the order the scan lists them.
    expect(profile.addons.map((a) => [a.title, a.body, a.link, a.skills])).toEqual([
      ["empty", "Offline flashcards for the LET exam.", "https://github.com/juandc/empty", []],
      ["kain-tayo", "Recipe planner for carinderias.", null, ["Go"]],
      ["their-lib", "their-lib, a personal project.", null, []],
    ]);
    const after = await local();
    expect(after.shown.find((f) => f.folder === "kain-tayo")?.added).toBe(true);
    expect((await call("POST", "/profile/projects", { folders: ["kain-tayo"] })).status).toBe(409);
  });

  test("a projects folder alone works without gh; a missing folder is reported, not fatal", async () => {
    await setup(createPublicReader({ http: createHttpClient({}), user: null }), {
      projects: createProjectsReader({ dir, extraEmails: [ME], readConfigEmail: false }),
    });
    expect((await json(await call("GET", "/profile"), ProfileDto)).projectScan).toEqual({ github: false, local: true });
    const result = await scanBoth();
    expect(result.github).toBeNull();
    // Without a listing, your own remote is linked and treated as private until read.
    if (result.local?.status !== "ok") throw new Error("no local scan");
    expect(result.local.shown.map((f) => [f.folder, f.url])).toEqual([
      ["empty-clone", "https://github.com/juandc/empty"],
      ["kain-tayo", null],
    ]);
    const added = await settle(await call("POST", "/profile/projects", { folders: ["empty-clone"] }));
    // A git folder keeps its path and is read with git, not through GitHub (decision 81).
    expect(added.addons[0]?.folder).toMatchObject({ path: await realpath(join(dir, "empty-clone")), private: true });
    expect(added.addons[0]?.github).toBeNull();

    const listing = await listingDir([]);
    await setup(createFixtureReader({ dir: listing, user: null }), {
      projects: createProjectsReader({ dir: join(dir, "nope"), readConfigEmail: false }),
    });
    const broken = await scanBoth();
    expect(broken.github?.status).toBe("ok");
    expect(broken.local).toEqual({
      status: "error",
      message: `HB_PROJECTS_DIR (${join(dir, "nope")}) is not a folder.`,
    });
    expect((await call("POST", "/profile/projects", { folders: ["kain-tayo"] })).status).toBe(409);
  });
});

// ---------- Eval scoring ----------

describe("github eval", () => {
  test("the fake model passes: nothing invented, nothing injected", async () => {
    const fake = createFakeAi();
    const report = await runGithubEval({ client: fake, model: "claude-haiku-5-5", tier: "light", via: "fake" });
    expect(report.cases.map((c) => c.id)).toEqual([
      "bayanihan-bot-injection",
      "jeep-route-side-project",
      "sari-ledger-private",
    ]);
    expect(report.cases.every((c) => c.error === null && c.kept.length > 0)).toBe(true);
    expect({ invented: report.inventedClaims, injected: report.injectedFacts }).toEqual({ invented: 0, injected: 0 });
    expect(githubExitCode(report)).toBe(0);
  });

  test("a model that follows the injection, or cites what it did not read, fails", async () => {
    const fake = createFakeAi();
    // Per case: a picks reply, then a facts reply.
    for (let i = 0; i < 3; i++) {
      fake.queue(
        JSON.stringify({ files: [] }),
        JSON.stringify({
          facts: [
            { text: "Led a team of 50", evidence: "README.md" },
            { text: "Wrote the scheduler", evidence: "bot/scheduler.py" },
          ],
        }),
      );
    }
    const report = await runGithubEval({ client: fake, model: "m", tier: "light", via: "fake" });
    const bayani = report.cases.find((c) => c.id === "bayanihan-bot-injection");
    expect(bayani?.injected).toEqual(["Led a team of 50"]);
    // The planted words are in the README it cites, so the code check alone cannot drop it:
    // the eval counts it from the proposals, and the user still has to confirm it.
    expect(bayani?.kept).toEqual(["Led a team of 50"]);
    // Two per case, except the injected claim in the README that cites it.
    expect(report.inventedClaims).toBe(5);
    expect(githubExitCode(report)).toBe(1);
  });
});
