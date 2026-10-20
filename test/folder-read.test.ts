import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FolderBundle, resolveEvidence } from "@/domain/github-read";
import type { ChooseCommits } from "@/domain/project-read";
import { FolderReadError, type FolderReadInput, readFolderProject } from "@/server/adapters/folder-read";
import { createGit } from "@/server/adapters/git";
import { type FileCommit, makeFileRepo, makeRepo, markPushed } from "./git-repos";

const ME = "juan@example.ph";
const PAL = "pal@example.ph";
const SECRET = "AKIA-NEVER-READ-THIS";

/** A Go project: 4 commits of mine (one with a secret beside the code), 2 by someone else. */
function history(): FileCommit[] {
  return [
    {
      email: ME,
      subject: "feat: routes table",
      files: {
        "README.md": "# Jeep Route\n\nPlans jeepney rides across Cebu City.",
        "go.mod": "module jeep",
        "routes/table.go": "package routes\n\nfunc Table() []string { return nil }\n",
      },
    },
    {
      email: ME,
      subject: "feat: fare calculator",
      files: {
        "fare/fare.go": "package fare\n\nfunc Fare(km int) int { return 13 + km*2 }\n",
        ".env": `KEY=${SECRET}`,
      },
    },
    { email: PAL, subject: "docs: typo", files: { "CONTRIBUTING.md": "Be kind." } },
    {
      email: ME,
      subject: "fix: fare rounding",
      files: { "fare/fare.go": "package fare\n\nfunc Fare(km int) int { return 13 + (km+1)*2 }\n" },
    },
    { email: PAL, subject: "chore: deps", files: { "go.sum": "x v1\n" } },
    {
      email: ME,
      subject: "feat: keys loader",
      files: { "config/load.go": "package config\n", "config/prod.pem": `-----BEGIN ${SECRET}-----` },
    },
  ];
}

/** Picks every commit (biggest first) with no features, like the fallback. */
const takeAll: ChooseCommits = async ({ commits }) => ({ features: [], shas: commits.map((c) => c.sha) });

function input(path: string, over: Partial<FolderReadInput> = {}): FolderReadInput {
  return {
    path,
    user: ME,
    isMine: (email) => email.toLowerCase() === ME,
    choose: takeAll,
    pick: async () => [],
    publicRemote: async () => null,
    ...over,
  };
}

async function repo(over: { remote?: string; ignore?: string[] } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hb-folder-read-"));
  const path = join(dir, "jeep-route");
  await makeFileRepo(path, { commits: history(), ...over });
  return realpath(path);
}

function promptText(bundle: FolderBundle): string {
  return JSON.stringify(bundle);
}

describe("reading a folder for facts", () => {
  test("lists only my commits, counts the share, and reads hunks of the picked ones", async () => {
    const path = await repo();
    const bundle = await readFolderProject(createGit(), input(path));

    expect(bundle.kind).toBe("folder");
    expect(bundle.name).toBe("jeep-route");
    expect(bundle.share).toEqual({ mine: 4, total: 6 });
    expect(bundle.framing).toBe("own");
    expect(bundle.commits.map((c) => c.subject).toSorted()).toEqual([
      "feat: fare calculator",
      "feat: keys loader",
      "feat: routes table",
      "fix: fare rounding",
    ]);
    expect(bundle.files.map((f) => f.path)).toEqual(["README.md", "go.mod"]);
    const patched = bundle.patches.map((p) => p.path).toSorted();
    expect(patched).toContain("fare/fare.go");
    expect(patched).toContain("routes/table.go");
    expect(bundle.patches.find((p) => p.path === "fare/fare.go")?.text).toContain("+func Fare");
    // No remote: private, so facts show only the project name.
    expect(bundle.private).toBe(true);
    expect(bundle.links).toBeNull();
  });

  test("never reads a secret file, in the tree, in hunks or as a pick", async () => {
    const path = await repo();
    const argvs: string[][] = [];
    const git = createGit({
      spawn: (cmd, options) => {
        argvs.push(cmd);
        return Bun.spawn(cmd, options);
      },
    });
    const bundle = await readFolderProject(
      git,
      input(path, { pick: async () => [".env", "config/prod.pem", "fare/fare.go"] }),
    );
    const text = promptText(bundle);
    expect(text).not.toContain(SECRET);
    expect(bundle.tree).not.toContain(".env");
    expect(bundle.tree).not.toContain("config/prod.pem");
    // The pick of a secret is dropped; the code file is read.
    expect(bundle.files.map((f) => f.path)).toContain("fare/fare.go");
    // No git call names a secret path.
    for (const argv of argvs) expect(argv.join(" ")).not.toMatch(/\.env|prod\.pem/);
    // Every call is `git -C <path> -c core.fsmonitor=false …`, and diffs run no external program.
    for (const argv of argvs) expect(argv.slice(0, 5)).toEqual(["git", "-C", path, "-c", "core.fsmonitor=false"]);
    const shows = argvs.filter((a) => a[5] === "show");
    expect(shows.length).toBeGreaterThan(0);
    for (const show of shows) expect(show).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });

  test("a git-ignored file is never in the tree or read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-folder-read-"));
    const path = join(dir, "p");
    await makeFileRepo(path, {
      ignore: ["notes.txt"],
      commits: [{ email: ME, subject: "init", files: { "main.go": "package main\n" } }],
    });
    await writeFile(join(path, "notes.txt"), `password ${SECRET}`);
    const bundle = await readFolderProject(
      createGit(),
      input(await realpath(path), { pick: async () => ["notes.txt"] }),
    );
    expect(bundle.tree).toEqual([".gitignore", "main.go"]);
    expect(promptText(bundle)).not.toContain(SECRET);
  });

  test("mostly someone else's commits: framed as a contribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-folder-read-"));
    const path = join(dir, "theirs");
    await makeRepo(path, { commits: { [PAL]: 5, [ME]: 2 } });
    const bundle = await readFolderProject(createGit(), input(await realpath(path)));
    expect(bundle.share).toEqual({ mine: 2, total: 7 });
    expect(bundle.framing).toBe("contribution");
  });

  test("a folder that isn't a repo, or has no commits, can't be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-folder-read-"));
    await expect(readFolderProject(createGit(), input(await realpath(dir)))).rejects.toBeInstanceOf(FolderReadError);
    await makeRepo(join(dir, "empty"), { commits: {} });
    await expect(readFolderProject(createGit(), input(join(dir, "empty")))).rejects.toThrow(
      "empty is not a git repo with commits",
    );
  });

  test("a public remote links pushed commits and files it has; unpushed ones stay unlinked", async () => {
    const path = await repo({ remote: "git@github.com:juandc/jeep-route.git" });
    // Everything but the last commit is on the remote.
    markPushed(path, "HEAD~1");
    const bundle = await readFolderProject(
      createGit(),
      input(path, {
        publicRemote: async () => ({
          host: "github",
          web: "https://github.com/juandc/jeep-route",
          name: "juandc/jeep-route",
        }),
        pick: async () => ["config/load.go"],
      }),
    );
    expect(bundle.private).toBe(false);
    expect(bundle.name).toBe("juandc/jeep-route");
    const sha = (subject: string) => bundle.commits.find((c) => c.subject === subject)?.sha ?? "";
    const pushed = resolveEvidence({ bundle, cited: sha("fix: fare rounding") });
    expect(pushed?.url).toBe(`https://github.com/juandc/jeep-route/commit/${sha("fix: fare rounding")}`);
    expect(resolveEvidence({ bundle, cited: sha("feat: keys loader") })?.url).toBeNull();
    expect(resolveEvidence({ bundle, cited: "README.md" })?.url).toMatch(
      /^https:\/\/github\.com\/juandc\/jeep-route\/blob\/[0-9a-f]{40}\/README\.md$/,
    );
    // Added in the unpushed commit: read, but not on the remote.
    expect(resolveEvidence({ bundle, cited: "config/load.go" })).toMatchObject({ url: null, private: false });
  });

  test("a private project's evidence keeps its sha but has no link", async () => {
    const path = await repo();
    const bundle = await readFolderProject(createGit(), input(path));
    const sha = bundle.commits[0]?.sha ?? "";
    expect(resolveEvidence({ bundle, cited: sha.slice(0, 7) })).toEqual({
      kind: "commit",
      sha,
      url: null,
      repo: "jeep-route",
      private: true,
    });
  });
});
