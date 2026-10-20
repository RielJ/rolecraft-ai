import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectsReader } from "@/server/adapters/local-projects";
import { makeRepo } from "./git-repos";

describe("local projects reader", () => {
  test("reads each folder's commits by author, remote, root files and README", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-projects-"));
    await makeRepo(join(dir, "mine"), {
      commits: { "Juan@Example.ph": 6, "pal@example.ph": 1 },
      remote: "git@github.com:juandc/mine.git",
    });
    await writeFile(join(dir, "mine", "README.md"), "# mine\n\nA tool.");
    await writeFile(join(dir, "mine", "go.mod"), "module x");
    await makeRepo(join(dir, "fresh"), { commits: {} });
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "readme.txt"), "x".repeat(100_000));
    await mkdir(join(dir, ".hidden"));
    // A symlink to a folder outside is never followed.
    const outside = await mkdtemp(join(tmpdir(), "hb-outside-"));
    await symlink(outside, join(dir, "escape"));

    const reader = createProjectsReader({ dir, extraEmails: [" Old@Example.ph "], readConfigEmail: false });
    const { folders, emails } = await reader.list();
    expect(emails).toEqual(["old@example.ph"]);
    expect(folders.map((f) => f.folder)).toEqual(["fresh", "mine", "notes"]);

    const mine = folders.find((f) => f.folder === "mine");
    expect(mine?.git?.authors).toEqual({ "juan@example.ph": 6, "pal@example.ph": 1 });
    expect(mine?.git?.lastCommitAt).toMatch(/^2026-/);
    expect(mine?.git?.remote).toBe("git@github.com:juandc/mine.git");
    expect(mine?.rootFiles.toSorted()).toEqual(["README.md", "go.mod"]);
    expect(mine?.readme).toBe("# mine\n\nA tool.");

    // A repo with no commits is still a repo.
    expect(folders.find((f) => f.folder === "fresh")?.git).toEqual({ authors: {}, lastCommitAt: null, remote: null });
    const notes = folders.find((f) => f.folder === "notes");
    expect(notes?.git).toBeNull();
    expect(notes?.readme?.length).toBe(64 * 1024);
  });

  test("git runs as an argv array with fsmonitor off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-projects-"));
    await makeRepo(join(dir, "a b; rm -rf x"), { commits: { "j@x.ph": 1 } });
    const argvs: string[][] = [];
    const reader = createProjectsReader({
      dir,
      readConfigEmail: false,
      spawn: (cmd, options) => {
        argvs.push(cmd);
        return Bun.spawn(cmd, options);
      },
    });
    const { folders } = await reader.list();
    expect(folders[0]?.git?.authors).toEqual({ "j@x.ph": 1 });
    for (const argv of argvs) {
      expect(argv.slice(0, 5)).toEqual(["git", "-C", join(dir, "a b; rm -rf x"), "-c", "core.fsmonitor=false"]);
    }
  });

  test("a missing folder is an error", async () => {
    const reader = createProjectsReader({ dir: join(tmpdir(), "hb-nope-404"), readConfigEmail: false });
    await expect(reader.list()).rejects.toThrow("is not a folder");
  });
});
