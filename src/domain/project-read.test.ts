import { describe, expect, test } from "bun:test";
import {
  biggestCommits,
  capPicks,
  commitList,
  commitListLine,
  fitPatches,
  framingOf,
  isNoisePath,
  isSecretPath,
  listedCommits,
  parseNumstatLog,
  resolveSha,
  splitDiff,
  type UserCommit,
  validateFeatures,
} from "./project-read";

const commit = (sha: string, date: string, lines: number, path = "src/a.ts"): UserCommit => ({
  sha,
  subject: `change ${sha}`,
  date,
  files: [{ path, additions: lines, deletions: 0 }],
  sized: true,
});

describe("project-read", () => {
  test("secret paths are never read, wherever they are", () => {
    for (const path of [
      ".env",
      ".env.local",
      "api/.env.production",
      "certs/server.pem",
      "tls.key",
      "id_rsa",
      "home/id_ed25519.pub",
      "aws/credentials",
      "config/credentials.json",
      "secrets.yaml",
      "infra/prod.tfvars",
      ".npmrc",
    ]) {
      expect(isSecretPath(path)).toBe(true);
    }
    for (const path of ["src/env.ts", "keyboard.go", "docs/secret-sauce.md", "README.md", "src/keys.ts"]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });

  test("lock files, build output and vendored code are noise", () => {
    expect(isNoisePath("bun.lock")).toBe(true);
    expect(isNoisePath("web/package-lock.json")).toBe(true);
    expect(isNoisePath("node_modules/x/index.js")).toBe(true);
    expect(isNoisePath("dist/app.js")).toBe(true);
    expect(isNoisePath("api/user.pb.go")).toBe(true);
    expect(isNoisePath("src/build.ts")).toBe(false);
  });

  test("the project is the user's at half the commits or more", () => {
    expect(framingOf({ mine: 5, total: 10 })).toBe("own");
    expect(framingOf({ mine: 4, total: 10 })).toBe("contribution");
    expect(framingOf({ mine: 0, total: 0 })).toBe("contribution");
  });

  test("the fallback reads the biggest commits, at most two a month, skipping noise-only ones", () => {
    const commits = [
      commit("a1", "2026-01-02", 100),
      commit("a2", "2026-01-03", 90),
      commit("a3", "2026-01-04", 80),
      commit("b1", "2026-02-01", 10),
      commit("lock", "2026-03-01", 5000, "bun.lock"),
    ];
    expect(biggestCommits({ commits })).toEqual(["a1", "a2", "b1"]);
    expect(biggestCommits({ commits, max: 1 })).toEqual(["a1"]);
  });

  test("features keep only listed, unambiguous, unused shas; 3 per feature, 6 features", () => {
    const commits = [
      { ...commit("abcdef1234", "2026-01-01", 1) },
      { ...commit("abcdef1999", "2026-01-01", 1) },
      { ...commit("1234567890", "2026-01-01", 1) },
      { ...commit("2222222222", "2026-01-01", 1) },
    ];
    expect(resolveSha(commits, "abcdef1")).toBeNull();
    expect(resolveSha(commits, "ABCDEF12")).toBe("abcdef1234");
    const features = validateFeatures({
      commits,
      features: [
        { name: "  Fares  ", commits: ["abcdef12", "abcdef1", "deadbeef", "1234567"] },
        { name: "Again", commits: ["1234567"] },
        { name: "", commits: ["2222222"] },
        { name: "Routes", commits: ["2222222"] },
      ],
    });
    expect(features).toEqual([
      { name: "Fares", shas: ["abcdef1234", "1234567890"] },
      { name: "Routes", shas: ["2222222222"] },
    ]);
    const many = Array.from({ length: 9 }, (_, i) => commit(`${i}`.repeat(8), "2026-01-01", 1));
    expect(
      validateFeatures({ commits: many, features: many.map((c) => ({ name: c.sha, commits: [c.sha] })) }),
    ).toHaveLength(6);
  });

  test("the commit list shows month, size and top files, and stops at its budget", () => {
    const commits = Array.from({ length: 50 }, (_, i) => commit(`${i}`.padStart(12, "a"), "2026-04-09", 12));
    const { lines, more } = commitList({ commits, maxTokens: 100 });
    expect(lines[0]).toBe("aaaaaaaaaaa0 2026-04 +12 -0 change aaaaaaaaaaa0 [src/a.ts]");
    expect(lines.length + more).toBe(50);
    expect(more).toBeGreaterThan(0);
  });

  test("picked commits are listed first so a fact can cite them", () => {
    const commits = [commit("new1", "2026-03-01", 1), commit("old1", "2026-01-01", 1)];
    const listed = listedCommits({ commits, picked: ["old1"], maxTokens: 1000 });
    expect(listed.map((c) => c.sha)).toEqual(["old1", "new1"]);
    expect(listedCommits({ commits, picked: ["old1"], maxTokens: 6 }).map((c) => c.sha)).toEqual(["old1"]);
  });

  test("a numstat log parses into commits with their files", () => {
    const log =
      "\x1eaaa\x1fJ@x.ph\x1f2026-01-02T00:00:00Z\x1ffeat: one\n\n3\t1\tsrc/a.ts\n-\t-\tlogo.png\n" +
      "\x1ebbb\x1fp@x.ph\x1f2026-01-01T00:00:00Z\x1fempty\n";
    expect(parseNumstatLog(log)).toEqual([
      {
        sha: "aaa",
        email: "J@x.ph",
        date: "2026-01-02T00:00:00Z",
        subject: "feat: one",
        files: [
          { path: "src/a.ts", additions: 3, deletions: 1 },
          { path: "logo.png", additions: 0, deletions: 0 },
        ],
        sized: true,
      },
      { sha: "bbb", email: "p@x.ph", date: "2026-01-01T00:00:00Z", subject: "empty", files: [], sized: true },
    ]);
  });

  test("a name-only log lists paths without counts", () => {
    const log = "\x1eaaa\x1fJ@x.ph\x1f2026-01-02T00:00:00Z\x1ffeat: one\n\nsrc/a.ts\nbun.lock\n";
    const [c] = parseNumstatLog(log, { sized: false });
    expect(c).toMatchObject({ sized: false, files: [{ path: "src/a.ts" }, { path: "bun.lock" }] });
    if (!c) throw new Error("no commit");
    expect(commitListLine(c)).toBe("aaa 2026-01 feat: one [src/a.ts]");
  });

  test("without line counts, the fallback weighs files, and a commit with no file list still counts", () => {
    const paths = (sha: string, date: string, files: string[]): UserCommit => ({
      sha,
      subject: sha,
      date,
      files: files.map((path) => ({ path, additions: 0, deletions: 0 })),
      sized: false,
    });
    const commits = [
      paths("one", "2026-01-01", ["a.ts"]),
      paths("three", "2026-02-01", ["a.ts", "b.ts", "c.ts"]),
      paths("lock", "2026-03-01", ["bun.lock"]),
      { ...paths("api", "2026-04-01", []) },
    ];
    expect(biggestCommits({ commits })).toEqual(["three", "one", "api"]);
  });

  test("a capped pick keeps one commit of every feature before a second of any", () => {
    const choice = {
      features: [
        { name: "A", shas: ["a1", "a2", "a3"] },
        { name: "B", shas: ["b1", "b2"] },
        { name: "C", shas: ["c1"] },
      ],
      shas: ["a1", "a2", "a3", "b1", "b2", "c1"],
    };
    expect(capPicks({ choice, max: 4 })).toEqual({
      features: [
        { name: "A", shas: ["a1", "a2"] },
        { name: "B", shas: ["b1"] },
        { name: "C", shas: ["c1"] },
      ],
      shas: ["a1", "a2", "b1", "c1"],
    });
    expect(capPicks({ choice, max: 10 })).toBe(choice);
    expect(capPicks({ choice: { features: [], shas: ["x", "y", "z"] }, max: 2 }).shas).toEqual(["x", "y"]);
  });

  test("a diff splits per file, dropping secrets, noise and binaries", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -0,0 +1 @@",
      "+KEY=1",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/bun.lock b/bun.lock",
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    expect(splitDiff(diff)).toEqual([{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }]);
  });

  test("hunks share the budget evenly and are cut rather than skipped", () => {
    const patch = (n: number) => "+".repeat(n);
    const out = fitPatches({
      maxTokens: 200,
      patches: [
        { sha: "a", files: [{ path: "big.ts", patch: patch(2000) }] },
        { sha: "b", files: [{ path: "small.ts", patch: patch(40) }] },
        { sha: "c", files: [] },
      ],
    });
    expect(out.map((p) => [p.sha, p.path, p.truncated])).toEqual([
      ["a", "big.ts", true],
      ["b", "small.ts", false],
    ]);
    expect(out[0]?.text.length).toBe(400);
  });
});
