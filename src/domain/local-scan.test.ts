import { describe, expect, test } from "bun:test";
import {
  guessLanguages,
  isOwnEmail,
  type LocalFolder,
  localAddon,
  MAX_SUMMARY_CHARS,
  parseGithubRemote,
  readmeSummary,
  scanLocal,
} from "./local-scan";
import { type OwnedRepo, scanRepos } from "./repo-scan";

const ME = "juan@example.ph";

const folder = (name: string, over: Partial<LocalFolder> = {}): LocalFolder => ({
  folder: name,
  git: { authors: { [ME]: 12 }, lastCommitAt: "2026-09-01T00:00:00Z", remote: null },
  rootFiles: ["package.json", "tsconfig.json"],
  readme: null,
  ...over,
});

const scan = (folders: LocalFolder[], over: Partial<Parameters<typeof scanLocal>[0]> = {}) =>
  scanLocal({ folders, emails: [ME], githubUser: "juandc", listed: null, linked: [], titles: [], ...over });

describe("parseGithubRemote", () => {
  test.each([
    ["git@github.com:RielJ/akashic.git", "RielJ", "akashic"],
    ["https://github.com/leohenon/pi-mux.git", "leohenon", "pi-mux"],
    ["https://token@github.com/o/r", "o", "r"],
    ["ssh://git@github.com/o/my.repo.git", "o", "my.repo"],
  ])("%s", (url, owner, repo) => {
    expect(parseGithubRemote(url)).toEqual({ owner, repo });
  });

  test("other hosts are not GitHub", () => {
    expect(parseGithubRemote("git@gitlab.com:o/r.git")).toBeNull();
    expect(parseGithubRemote("https://github.com.evil.example/o/r")).toBeNull();
  });
});

describe("isOwnEmail", () => {
  const emails = new Set([ME]);
  test("configured emails in any case, and the account's noreply addresses", () => {
    expect(isOwnEmail({ email: "JUAN@example.ph", emails, githubUser: "juandc" })).toBe(true);
    expect(isOwnEmail({ email: "51821413+JuanDC@users.noreply.github.com", emails, githubUser: "juandc" })).toBe(true);
    expect(isOwnEmail({ email: "juandc@users.noreply.github.com", emails, githubUser: "juandc" })).toBe(true);
    expect(isOwnEmail({ email: "1+juandcx@users.noreply.github.com", emails, githubUser: "juandc" })).toBe(false);
    expect(isOwnEmail({ email: "kyle@conroy.org", emails, githubUser: "juandc" })).toBe(false);
    expect(isOwnEmail({ email: "1+juandc@users.noreply.github.com", emails, githubUser: null })).toBe(false);
  });
});

describe("guessLanguages", () => {
  test("TypeScript hides package.json's JavaScript; at most three", () => {
    expect(guessLanguages(["package.json", "tsconfig.json"])).toEqual(["TypeScript"]);
    expect(guessLanguages(["go.mod", "package.json"])).toEqual(["Go", "JavaScript"]);
    expect(guessLanguages(["requirements.txt", "pyproject.toml"])).toEqual(["Python"]);
    expect(guessLanguages(["go.mod", "Cargo.toml", "Gemfile", "pom.xml"])).toEqual(["Go", "Rust", "Ruby"]);
    expect(guessLanguages(["notes.md"])).toEqual([]);
  });
});

describe("readmeSummary", () => {
  test("skips the title, badges and HTML; strips markdown", () => {
    const readme = [
      "# pi-adw",
      "",
      "[![CI](https://x/badge.svg)](https://x)",
      '<p align="center"><img src="logo.png"></p>',
      "",
      "AI Developer Workflows for [Pi](https://github.com/badlogic/pi-mono). Runs **real** `checks`.",
      "Second line of the same paragraph.",
      "",
      "Another paragraph.",
    ].join("\n");
    expect(readmeSummary(readme)).toBe(
      "AI Developer Workflows for Pi. Runs real checks. Second line of the same paragraph.",
    );
  });

  test("a paragraph ending in a colon keeps its list", () => {
    const readme = "# Hanapbuhay\n\nIt does three things:\n\n- Reads job boards.\n- Drafts [files](x).\n\n## Run";
    expect(readmeSummary(readme)).toBe("It does three things:\n- Reads job boards.\n- Drafts files.");
  });

  test("skips code blocks, setext underlines and box drawing", () => {
    const readme = "Title\n=====\n\n```\nnpm install\n```\n╔══╗\n║ X ║\n╚══╝\n\nThe real text.";
    expect(readmeSummary(readme)).toBe("The real text.");
  });

  test("generator boilerplate is no summary", () => {
    const next =
      "This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://x).\n\n## Getting Started";
    expect(readmeSummary(next)).toBeNull();
    expect(readmeSummary("# app\n\nThis project was bootstrapped with Create React App.")).toBeNull();
    expect(readmeSummary("This template should help get you started developing with Vue 3 in Vite.")).toBeNull();
  });

  test("caps long text at a sentence", () => {
    const long = `${"A sentence that goes on. ".repeat(100)}`;
    const out = readmeSummary(long) ?? "";
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.endsWith("on.")).toBe(true);
  });

  test("null without prose", () => {
    expect(readmeSummary(null)).toBeNull();
    expect(readmeSummary("# Title\n\n- only\n- a list")).toBeNull();
  });
});

describe("scanLocal", () => {
  test("hides non-git folders, repos with few of your commits, and repos mostly by others", () => {
    const result = scan([
      folder("hanapbuhay"),
      folder("notes", { git: null }),
      folder("jersey", { git: { authors: { [ME]: 4 }, lastCommitAt: "2026-07-15T00:00:00Z", remote: null } }),
      folder("pi-mux-ref", {
        git: {
          authors: { "leo@users.noreply.github.com": 31 },
          lastCommitAt: "2026-04-21T00:00:00Z",
          remote: "https://github.com/leohenon/pi-mux.git",
        },
      }),
      folder("mixed", {
        git: { authors: { [ME]: 3, "kyle@conroy.org": 14 }, lastCommitAt: "2025-12-17T00:00:00Z", remote: null },
      }),
      folder("empty", { git: { authors: {}, lastCommitAt: null, remote: null } }),
      // "local" names no one, so it isn't someone else's commit.
      folder("anon", { git: { authors: { local: 1 }, lastCommitAt: null, remote: null } }),
    ]);
    expect(result.shown.map((r) => r.folder)).toEqual(["hanapbuhay"]);
    expect(result.hidden.map((r) => [r.folder, r.hiddenBy])).toEqual([
      ["jersey", "few_commits"],
      ["pi-mux-ref", "others"],
      ["mixed", "others"],
      ["anon", "few_commits"],
      ["empty", "few_commits"],
      ["notes", "not_git"],
    ]);
    // Someone else's remote is never linked.
    expect(result.hidden.find((r) => r.folder === "pi-mux-ref")?.github).toBeNull();
  });

  test("a clone of a listed GitHub repo shows under GitHub, with its commits and README", () => {
    const result = scan(
      [
        folder("akashic", {
          git: {
            authors: { [ME]: 32 },
            lastCommitAt: "2026-03-31T00:00:00Z",
            remote: "git@github.com:JuanDC/akashic.git",
          },
          readme: "Music on a flash drive.",
        }),
        folder("pos-2", {
          git: { authors: { [ME]: 78 }, lastCommitAt: "2026-01-01T00:00:00Z", remote: "git@github.com:juandc/pos.git" },
        }),
        folder("point-of-sale", {
          git: {
            authors: { [ME]: 276 },
            lastCommitAt: "2026-10-05T00:00:00Z",
            remote: "git@github.com:juandc/pos.git",
          },
        }),
      ],
      { listed: new Set(["juandc/akashic", "juandc/pos"]) },
    );
    expect(result.shown).toEqual([]);
    expect(result.onGithub).toBe(3);
    expect(result.clones.get("juandc/akashic")).toEqual({ ownCommits: 32, summary: "Music on a flash drive." });
    // Two clones of one repo: the one with more of your commits.
    expect(result.clones.get("juandc/pos")?.ownCommits).toBe(276);

    // GitHub calls akashic nearly empty; the clone's commits keep it shown.
    const repo = (name: string): OwnedRepo => ({
      owner: "juandc",
      name,
      private: true,
      fork: false,
      archived: false,
      sizeKb: 1,
      language: null,
      stars: 0,
      pushedAt: "2026-03-31T00:00:00Z",
      description: null,
    });
    const github = scanRepos({
      user: "juandc",
      repos: [repo("akashic"), repo("tiny")],
      linked: [],
      clones: result.clones,
    });
    expect(github.shown.map((r) => [r.name, r.localCommits, r.localSummary])).toEqual([
      ["akashic", 32, "Music on a flash drive."],
    ]);
    expect(github.hidden.map((r) => [r.name, r.hiddenBy])).toEqual([["tiny", "small"]]);
  });

  test("without a gh listing, your own remote is linked; a second folder on it is hidden", () => {
    const result = scan([
      folder("pos-2", {
        git: { authors: { [ME]: 78 }, lastCommitAt: "2026-01-01T00:00:00Z", remote: "git@github.com:juandc/pos.git" },
      }),
      folder("point-of-sale", {
        git: { authors: { [ME]: 276 }, lastCommitAt: "2026-10-05T00:00:00Z", remote: "git@github.com:juandc/pos.git" },
      }),
    ]);
    expect(result.shown.map((r) => [r.folder, r.github])).toEqual([
      ["point-of-sale", { owner: "juandc", repo: "pos" }],
    ]);
    expect(result.hidden.map((r) => [r.folder, r.hiddenBy])).toEqual([["pos-2", "same_remote"]]);
  });

  test("with a gh listing, your remote that isn't listed is gone, so no link", () => {
    const result = scan(
      [
        folder("portfolio-next", {
          git: { authors: { [ME]: 80 }, lastCommitAt: null, remote: "git@github.com:juandc/portfolio-next.git" },
        }),
      ],
      { listed: new Set(["juandc/other"]) },
    );
    expect(result.shown.map((r) => [r.folder, r.github])).toEqual([["portfolio-next", null]]);
  });

  test("marks folders already added, by link or by title", () => {
    const result = scan(
      [
        folder("hanapbuhay"),
        folder("pi-adw"),
        folder("linked", {
          git: {
            authors: { [ME]: 9 },
            lastCommitAt: "2026-01-01T00:00:00Z",
            remote: "git@github.com:juandc/linked.git",
          },
        }),
      ],
      { titles: ["Hanapbuhay"], linked: [{ owner: "JuanDC", repo: "linked" }] },
    );
    expect(result.shown.map((r) => [r.folder, r.added])).toEqual([
      ["hanapbuhay", true],
      ["pi-adw", false],
      ["linked", true],
    ]);
  });

  test("orders by newest commit, then your commits, then name", () => {
    const at = (iso: string | null, n: number) => ({ authors: { [ME]: n }, lastCommitAt: iso, remote: null });
    const result = scan([
      folder("b", { git: at("2026-05-01T00:00:00Z", 10) }),
      folder("a", { git: at("2026-05-01T00:00:00Z", 10) }),
      folder("more", { git: at("2026-05-01T00:00:00Z", 50) }),
      folder("newest", { git: at("2026-09-30T00:00:00Z", 6) }),
    ]);
    expect(result.shown.map((r) => r.folder)).toEqual(["newest", "more", "a", "b"]);
  });
});

describe("localAddon", () => {
  test("README paragraph, languages; no link without a GitHub remote", () => {
    const [repo] = scan([folder("pi-adw", { readme: "# pi-adw\n\nAI Developer Workflows." })]).shown;
    if (!repo) throw new Error("no repo");
    expect(localAddon(repo)).toEqual({
      title: "pi-adw",
      body: "AI Developer Workflows.",
      link: null,
      skills: ["TypeScript"],
      githubPrivate: null,
    });
  });

  test("without a README, says what it is; an unlisted GitHub remote is treated as private", () => {
    const [repo] = scan([
      folder("tool", {
        rootFiles: ["Cargo.toml"],
        git: { authors: { [ME]: 9 }, lastCommitAt: null, remote: "git@github.com:juandc/tool.git" },
      }),
    ]).shown;
    if (!repo) throw new Error("no repo");
    expect(localAddon(repo)).toMatchObject({
      body: "tool, a Rust project.",
      link: "https://github.com/juandc/tool",
      githubPrivate: true,
    });
  });
});
