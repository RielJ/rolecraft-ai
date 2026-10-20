import { describe, expect, test } from "bun:test";
import type { CommitSource, UserCommit } from "@/domain/project-read";
import { buildGithubFactsPrompt } from "@/domain/prompts";
import { createReader, type GithubReadInput } from "@/server/adapters/github";
import { createFixtureTransport, type GithubSnapshotInput } from "@/server/adapters/github-fixture";
import { parseGithubLink } from "@/shared/github-link";

/*
 * GitHub repo reads with commit evidence (decision 81): the user's commits from the API, the
 * share from contributors, hunks from `commits/<sha>`, and the source the service picks.
 */

const sha = (c: string) => c.repeat(40);
const patch = (line: string) => `@@ -0,0 +1 @@\n+${line}`;

const SNAPSHOT: GithubSnapshotInput = {
  owner: "barangay",
  repo: "tanod",
  description: "Barangay watch rota",
  files: { "README.md": "# Tanod\n\nRota for barangay watch shifts.", "go.mod": "module tanod" },
  commits: [
    {
      sha: sha("a"),
      message: "feat: swap shifts\n\nLets two tanods swap.",
      author: "juandc",
      date: "2026-03-02T00:00:00Z",
      files: [
        { path: "rota/swap.go", additions: 40, deletions: 2, patch: patch("func Swap() {}") },
        { path: ".env.production", additions: 1, deletions: 0, patch: patch("TOKEN=NEVER-SHOW-ME") },
        { path: "go.sum", additions: 9, deletions: 0, patch: patch("lock noise") },
        { path: "logo.png", additions: 0, deletions: 0 },
      ],
    },
    { sha: sha("b"), message: "chore: ci", author: "pal", date: "2026-02-20T00:00:00Z" },
    { sha: sha("c"), message: "chore: lint", author: "pal", date: "2026-02-10T00:00:00Z" },
    {
      sha: sha("d"),
      message: "feat: rota view",
      author: "juandc",
      date: "2026-02-01T00:00:00Z",
      files: [{ path: "rota/view.go", additions: 30, deletions: 0, patch: patch("func View() {}") }],
    },
    { sha: sha("e"), message: "chore: deps", author: "pal", date: "2026-01-02T00:00:00Z" },
  ],
};

const link = parseGithubLink("https://github.com/barangay/tanod");
if (link?.kind !== "repo") throw new Error("bad link");

function reader(snapshots: GithubSnapshotInput[] = [SNAPSHOT], log?: string[]) {
  return createReader({
    mode: "fixture",
    user: "juandc",
    transport: createFixtureTransport({ snapshots, ...(log ? { log } : {}) }),
  });
}

const input = (over: Partial<GithubReadInput> = {}): GithubReadInput => ({
  link: link as GithubReadInput["link"],
  user: "juandc",
  pick: async () => [],
  ...over,
});

describe("a GitHub repo read through the API", () => {
  test("lists only my commits, counts the share from contributors, and reads hunks without secrets", async () => {
    const log: string[] = [];
    const bundle = await reader([SNAPSHOT], log).read(input());
    if (bundle.kind !== "repo") throw new Error("not a repo");

    expect(bundle.commits.map((c) => c.subject)).toEqual(["feat: swap shifts", "feat: rota view"]);
    // 2 of 5 commits: a contribution, even though the README is read.
    expect(bundle.share).toEqual({ mine: 2, total: 5 });
    expect(bundle.framing).toBe("contribution");
    expect(bundle.commitsFrom).toBe("api");
    expect(bundle.pushed).toBeNull();
    expect(bundle.patches.map((p) => [p.sha, p.path])).toEqual([
      [sha("a"), "rota/swap.go"],
      [sha("d"), "rota/view.go"],
    ]);
    expect(JSON.stringify(bundle)).not.toContain("NEVER-SHOW-ME");
    expect(log.filter((p) => p.includes("/commits/"))).toHaveLength(2);

    const prompt = buildGithubFactsPrompt({ bundle }).messages[0]?.content ?? "";
    expect(prompt).toContain("Only 2 of its 5 commits are juandc's");
    expect(prompt).toContain("+func Swap() {}");
  });

  test("most commits mine: framed as my project even in someone else's repo", async () => {
    const mostlyMine = {
      ...SNAPSHOT,
      commits: (SNAPSHOT.commits ?? []).map((c) => ({ ...c, author: "juandc" })),
    };
    const bundle = await reader([mostlyMine]).read(input());
    expect(bundle.share).toEqual({ mine: 5, total: 5 });
    expect(bundle.framing).toBe("own");
  });

  test("the chosen features decide which hunks are read", async () => {
    const seen: UserCommit[][] = [];
    const bundle = await reader().read(
      input({
        choose: async ({ commits }) => {
          seen.push([...commits]);
          return { features: [{ name: "Rota view", shas: [sha("d")] }], shas: [sha("d")] };
        },
      }),
    );
    // The API list has no files or counts; the choice still gets every commit of mine.
    expect(seen[0]?.map((c) => [c.sha, c.sized, c.files.length])).toEqual([
      [sha("a"), false, 0],
      [sha("d"), false, 0],
    ]);
    expect(bundle.features).toEqual([{ name: "Rota view", shas: [sha("d")] }]);
    expect(bundle.patches.map((p) => p.path)).toEqual(["rota/view.go"]);
    // Picked commits are listed first so a fact can cite them.
    expect(bundle.commits[0]?.sha).toBe(sha("d"));
  });

  test("a source picked by the service is used, capped and closed, even when the read fails", async () => {
    let closed = 0;
    const opened: { sizeKb: number; branch: string }[] = [];
    const bundle = await reader().read(
      input({
        source: async (repo) => {
          opened.push({ sizeKb: repo.sizeKb, branch: repo.branch });
          const api = repo.api({ maxPatchCommits: 1 });
          return {
            ...api,
            async close() {
              closed += 1;
            },
          };
        },
      }),
    );
    expect(opened).toEqual([{ sizeKb: 100, branch: "main" }]);
    expect(new Set(bundle.patches.map((p) => p.sha)).size).toBe(1);
    expect(closed).toBe(1);

    const failing: CommitSource = {
      from: "temp clone",
      maxPatchCommits: 10,
      list: async () => {
        throw new Error("clone vanished");
      },
      patches: async () => [],
      close: async () => {
        closed += 1;
      },
    };
    await expect(reader().read(input({ source: async () => failing }))).rejects.toThrow("clone vanished");
    expect(closed).toBe(2);
  });

  test("contributors that can't be listed fall back to the owner for framing", async () => {
    const transport = createFixtureTransport({ snapshots: [SNAPSHOT] });
    const bundle = await createReader({
      mode: "fixture",
      user: "juandc",
      transport: {
        get: async (path) => (path.includes("/contributors") ? "not json" : transport.get(path)),
      },
    }).read(input());
    expect(bundle.share).toBeNull();
    expect(bundle.framing).toBe("contribution");
  });
});
