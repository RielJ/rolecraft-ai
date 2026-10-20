import { describe, expect, test } from "bun:test";
import {
  COUNT_CAP,
  contributionAddon,
  countPlan,
  groupContributions,
  isTinyContribution,
  type MergedPull,
  type OwnedRepo,
  repoAddon,
  scanRepos,
  staleness,
} from "./repo-scan";

const NOW = new Date("2026-10-20T00:00:00Z");

const repo = (over: Partial<OwnedRepo> & { name: string }): OwnedRepo => ({
  owner: "RielJ",
  private: false,
  fork: false,
  archived: false,
  sizeKb: 200,
  language: "TypeScript",
  stars: 0,
  pushedAt: "2026-01-01T00:00:00Z",
  description: null,
  ...over,
});

describe("scanRepos", () => {
  test("moves forks, the profile repo and near-empty repos to the hidden group, with reasons", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [],
      repos: [
        repo({ name: "nyx" }),
        repo({ name: "sqlc-gen-typescript", fork: true }),
        repo({ name: "RielJ", sizeKb: 40 }),
        repo({ name: "learning_github", sizeKb: 2 }),
        repo({ name: "tiny-fork", fork: true, sizeKb: 1 }),
        repo({ name: "old", archived: true }),
      ],
    });
    expect(scan.shown.map((r) => [r.name, r.hiddenBy])).toEqual([
      ["nyx", null],
      ["old", null],
    ]);
    // A fork that is also small is hidden as a fork only.
    expect(scan.hidden.map((r) => [r.name, r.hiddenBy])).toEqual([
      ["learning_github", "small"],
      ["RielJ", "profile"],
      ["sqlc-gen-typescript", "fork"],
      ["tiny-fork", "fork"],
    ]);
  });

  test("keeps a repo of exactly 5 KB", () => {
    expect(scanRepos({ now: NOW, user: "x", linked: [], repos: [repo({ name: "a", sizeKb: 5 })] }).shown).toHaveLength(
      1,
    );
  });

  test("orders by last push, then stars, then name; never pushed goes last", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [],
      repos: [
        repo({ name: "never", pushedAt: null, stars: 99 }),
        repo({ name: "b", pushedAt: "2026-05-01T00:00:00Z", stars: 1 }),
        repo({ name: "a", pushedAt: "2026-05-01T00:00:00Z", stars: 1 }),
        repo({ name: "starred", pushedAt: "2026-05-01T00:00:00Z", stars: 7 }),
        repo({ name: "newest", pushedAt: "2026-09-30T00:00:00Z" }),
      ],
    });
    expect(scan.shown.map((r) => r.name)).toEqual(["newest", "starred", "a", "b", "never"]);
  });

  test("marks repos an add-on already links, in any case", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [
        { owner: "rielj", repo: "NYX" },
        { owner: "RielJ", repo: "old-fork" },
      ],
      repos: [repo({ name: "nyx" }), repo({ name: "pi-adw" }), repo({ name: "old-fork", fork: true })],
    });
    expect(scan.shown.map((r) => [r.name, r.added])).toEqual([
      ["nyx", true],
      ["pi-adw", false],
    ]);
    expect(scan.hidden.map((r) => [r.name, r.added])).toEqual([["old-fork", true]]);
  });
});

describe("repoAddon", () => {
  test("uses the description, link and language", () => {
    expect(repoAddon(repo({ name: "nyx", description: "  A terminal app.  " }))).toEqual({
      title: "nyx",
      body: "A terminal app.",
      link: "https://github.com/RielJ/nyx",
      skills: ["TypeScript"],
    });
  });

  test("without a description, says what the repo is", () => {
    expect(repoAddon(repo({ name: "nyx", description: "" })).body).toBe("nyx, a TypeScript repository on GitHub.");
    const bare = repoAddon(repo({ name: "notes", language: null }));
    expect(bare.body).toBe("notes, a repository on GitHub.");
    expect(bare.skills).toEqual([]);
  });
});

describe("commit counts (decision 86)", () => {
  const counts = (entries: Record<string, [number, number]>) =>
    new Map(Object.entries(entries).map(([name, [own, total]]) => [`rielj/${name}`, { own, total }]));

  test("hides a counted repo with few of your commits, or mostly others', with reasons", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [],
      repos: [repo({ name: "mine" }), repo({ name: "few" }), repo({ name: "theirs" }), repo({ name: "half" })],
      counts: counts({ mine: [40, 41], few: [4, 4], theirs: [10, 21], half: [10, 20] }),
    });
    expect(scan.shown.map((r) => [r.name, r.ownCommits, r.totalCommits])).toEqual([
      ["mine", 40, 41],
      ["half", 10, 20],
    ]);
    expect(scan.hidden.map((r) => [r.name, r.hiddenBy])).toEqual([
      ["theirs", "others"],
      ["few", "few_commits"],
    ]);
  });

  test("an uncounted repo is never hidden for commits, and a local clone's commits count", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [],
      repos: [repo({ name: "uncounted" }), repo({ name: "cloned" })],
      counts: counts({ cloned: [1, 1] }),
      clones: new Map([["rielj/cloned", { ownCommits: 12, summary: null }]]),
    });
    expect(scan.hidden).toEqual([]);
    expect(scan.shown.map((r) => [r.name, r.ownCommits])).toEqual([
      ["cloned", 1],
      ["uncounted", null],
    ]);
  });

  test("orders counted repos by your commits, then size, then last push; uncounted after; stars never", () => {
    const scan = scanRepos({
      now: NOW,
      user: "rielj",
      linked: [],
      repos: [
        repo({ name: "starred", stars: 500, pushedAt: "2026-09-01T00:00:00Z" }),
        repo({ name: "big", sizeKb: 900 }),
        repo({ name: "small", sizeKb: 100 }),
        repo({ name: "most", sizeKb: 10 }),
        repo({ name: "new-uncounted", pushedAt: "2026-10-01T00:00:00Z" }),
        repo({ name: "old-uncounted", pushedAt: "2025-01-01T00:00:00Z" }),
      ],
      counts: counts({ starred: [6, 6], big: [20, 20], small: [20, 20], most: [90, 90] }),
    });
    expect(scan.shown.map((r) => r.name)).toEqual([
      "most",
      "big",
      "small",
      "starred",
      "new-uncounted",
      "old-uncounted",
    ]);
  });
});

describe("staleness", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  test("archived wins; no push in 18 months is old; never pushed is not judged", () => {
    expect(staleness({ repo: { archived: true, pushedAt: "2026-10-01T00:00:00Z" }, now })).toBe("archived");
    expect(staleness({ repo: { archived: false, pushedAt: "2025-04-19T00:00:00Z" }, now })).toBe("old");
    expect(staleness({ repo: { archived: false, pushedAt: "2025-04-21T00:00:00Z" }, now })).toBeNull();
    expect(staleness({ repo: { archived: false, pushedAt: null }, now })).toBeNull();
  });

  test("a stale repo is flagged in the scan, never hidden for it", () => {
    const scan = scanRepos({
      now,
      user: "rielj",
      linked: [],
      repos: [repo({ name: "old", pushedAt: "2023-01-01T00:00:00Z" }), repo({ name: "gone", archived: true })],
    });
    expect(scan.shown.map((r) => [r.name, r.stale]).toSorted()).toEqual([
      ["gone", "archived"],
      ["old", "old"],
    ]);
  });
});

describe("countPlan", () => {
  const repos = [
    repo({ name: "fork", fork: true, pushedAt: "2026-10-01T00:00:00Z" }),
    repo({ name: "RielJ", pushedAt: "2026-10-01T00:00:00Z" }),
    repo({ name: "older", pushedAt: "2026-01-01T00:00:00Z" }),
    repo({ name: "newer", pushedAt: "2026-06-01T00:00:00Z" }),
  ];
  const names = (remaining: number | null) => countPlan({ repos, user: "rielj", remaining }).map((r) => r.name);

  test("counts newest pushes first, forks and the profile repo last, keeping 10 calls back", () => {
    expect(names(12)).toEqual(["newer", "older"]);
    expect(names(10)).toEqual([]);
    expect(names(3)).toEqual([]);
  });

  test("never more than the cap without gh; everything with gh", () => {
    const many = Array.from({ length: 50 }, (_, i) => repo({ name: `r${i}` }));
    expect(countPlan({ repos: many, user: "rielj", remaining: 60 })).toHaveLength(COUNT_CAP);
    expect(countPlan({ repos: many, user: "rielj", remaining: null })).toHaveLength(50);
    expect(names(null)).toEqual(["newer", "older", "fork", "RielJ"]);
  });
});

describe("contributions", () => {
  const pull = (over: Partial<MergedPull> & { number: number }): MergedPull => ({
    owner: "wevm",
    repo: "viem",
    title: `PR ${over.number}`,
    mergedAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  test("groups by repo, most pulls first, newest merge first; your own repos are left out", () => {
    const rows = groupContributions({
      user: "rielj",
      linked: [{ owner: "Wevm", repo: "Viem" }],
      pulls: [
        pull({ number: 1, mergedAt: "2025-03-01T00:00:00Z" }),
        pull({ number: 2, mergedAt: "2026-02-01T00:00:00Z" }),
        pull({ number: 2, mergedAt: "2026-02-01T00:00:00Z" }),
        pull({ owner: "honojs", repo: "hono", number: 7, mergedAt: "2026-09-01T00:00:00Z" }),
        pull({ owner: "RielJ", repo: "nyx", number: 3 }),
      ],
    });
    expect(rows.map((r) => [`${r.owner}/${r.name}`, r.pulls.map((p) => p.number), r.added])).toEqual([
      ["wevm/viem", [2, 1], true],
      ["honojs/hono", [7], false],
    ]);
  });

  test("a contribution is tiny only when every checked pull changed under 10 lines", () => {
    expect(isTinyContribution([1, 9])).toBe(true);
    expect(isTinyContribution([1, 10])).toBe(false);
    expect(isTinyContribution([])).toBe(false);
  });

  test("the add-on names the repo, lists up to 3 titles and is a contribution", () => {
    const pulls = [1, 2, 3, 4, 5].map((n) => ({
      number: n,
      title: `Fix thing ${n}.`,
      mergedAt: "2026-01-01T00:00:00Z",
    }));
    expect(contributionAddon({ owner: "wevm", name: "viem", pulls })).toEqual({
      title: "viem",
      body: "Merged pull requests in wevm/viem: Fix thing 1; Fix thing 2; Fix thing 3, and 2 more.",
      link: "https://github.com/wevm/viem",
      skills: [],
    });
    expect(contributionAddon({ owner: "a", name: "b", pulls: pulls.slice(0, 1) }).body).toBe(
      "Merged pull request in a/b: Fix thing 1.",
    );
  });
});
