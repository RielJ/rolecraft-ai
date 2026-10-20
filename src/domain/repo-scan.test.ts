import { describe, expect, test } from "bun:test";
import { type OwnedRepo, repoAddon, scanRepos } from "./repo-scan";

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
    expect(scanRepos({ user: "x", linked: [], repos: [repo({ name: "a", sizeKb: 5 })] }).shown).toHaveLength(1);
  });

  test("orders by last push, then stars, then name; never pushed goes last", () => {
    const scan = scanRepos({
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
