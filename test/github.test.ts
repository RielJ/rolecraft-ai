import { beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { parseGithubLink } from "@/domain/github-link";
import { GITHUB_TOKEN_CAP, MAX_GITHUB_COMMITS } from "@/domain/github-read";
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
import { createFixtureReader, createFixtureTransport, type GithubSnapshot } from "@/server/adapters/github-fixture";
import { createHttpClient } from "@/server/adapters/http";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { githubAppError, githubUserFor } from "@/server/services/github";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ApiErrorBody, ProfileDto, TaskDto, TextExport, WorkspaceDto } from "@/shared/api";
import { githubExitCode, runGithubEval } from "../eval/run";
import { resetDb, testDeps, testSql, waitForGithubReads, waitForSplits } from "./setup";

const FIXTURES = join(import.meta.dir, "fixtures", "github");
const JEEP: GithubSnapshot = await Bun.file(join(FIXTURES, "jeep-route.json")).json();
const SARI: GithubSnapshot = await Bun.file(join(FIXTURES, "sari-ledger.json")).json();
const noPick = async () => [];

// ---------- A fake gh ----------

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

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

const fromSnapshots = (snapshots: GithubSnapshot[]) => {
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

// ---------- The public reader over a fake fetch ----------

/** A fetch that serves api.github.com from snapshots, recording each URL and its User-Agent. */
function githubFetch(snapshots: GithubSnapshot[], override?: (url: URL) => Response | null) {
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
    expect(seen.some((s) => s.url.includes(`commits?author=juandc&per_page=${MAX_GITHUB_COMMITS}`))).toBe(true);
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
    const snapshot: GithubSnapshot = {
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

// ---------- Limits ----------

describe("read limits", () => {
  const big = (n: number) => `${"const x = 1; // filler line for the cap\n".repeat(n)}`;
  const shaOf = (i: number) => i.toString(16).padStart(40, "0");
  const busy: GithubSnapshot = {
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
    const small: GithubSnapshot = {
      ...busy,
      files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, "export {}"])),
      pulls: [],
      commits: busy.commits.slice(0, 3),
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

async function setup(github: GithubReader, { links = ["https://github.com/juandc"] } = {}) {
  await resetDb();
  deps = await testDeps({ github });
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
    // Both AI calls are logged under the github purpose.
    const calls = await testSql()`SELECT purpose, tier FROM ai_calls ORDER BY created_at`;
    expect([...calls].filter((c) => c.purpose === "github")).toEqual([
      { purpose: "github", tier: "light" },
      { purpose: "github", tier: "light" },
    ]);
  });

  test("facts citing evidence that was not read are dropped in code", async () => {
    const item = await addRepo("https://github.com/juandc/jeep-route");
    deps.fake.queue(
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
      { sha: "f".repeat(40), message: "Show the fare in the reply", author: "juandc" },
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
    if (!privFact?.evidence || !pubFact?.evidence) throw new Error("missing facts");
    const privateUrl = privFact.evidence.url;

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
      `- ${pubFact.text}, see ${pubFact.evidence.url} [${pubFact.key}]`,
    ].join("\n");
    await call("PATCH", `/outputs/${byKind("letter")}`, { body: `Dear Acme, see ${privateUrl} [${privFact.key}].` });
    await call("PATCH", `/outputs/${byKind("message")}`, { body: `Hi [${pubFact.key}].` });
    await call("PATCH", `/outputs/${byKind("resume")}`, { body: draft });

    const text = await json(await call("GET", `/outputs/${byKind("resume")}/text`), TextExport);
    expect(text.text).not.toMatch(/sari-ledger/i);
    expect(text.text).toContain(privFact.text);
    expect(text.text).toContain(pubFact.evidence.url);
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
