import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/*
 * Real git repos for tests of "Find my projects" (decision 78). Node APIs only, since the e2e
 * specs run this under Node, not Bun.
 */

/** Git with the user's global and system config out of the way: no signing, no hooks. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** A repo with `commits` empty commits per author email. Commit n is dated `2026-0{n % 9 + 1}-01`. */
export async function makeRepo(
  path: string,
  { commits, remote }: { commits: Record<string, number>; remote?: string },
): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  let n = 0;
  for (const [email, count] of Object.entries(commits)) {
    for (let i = 0; i < count; i++) {
      n += 1;
      // Both dates fixed, so the newest commit doesn't depend on when the test ran.
      const date = `2026-0${(n % 9) + 1}-01T00:00:00Z`;
      git(
        path,
        ["-c", `user.email=${email}`, "-c", "user.name=Someone", "commit", "-q", "--allow-empty", "-m", `c${n}`],
        { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
    }
  }
  if (remote) git(path, ["remote", "add", "origin", remote]);
}

export type FileCommit = {
  email: string;
  subject: string;
  /** Path to content; null deletes the file. */
  files: Record<string, string | null>;
};

/**
 * A repo whose commits write real files (decision 81 reads their hunks). Commit n is dated
 * `2026-01-01` plus n days. `ignore` lines go to `.gitignore` in the first commit.
 */
export async function makeFileRepo(
  path: string,
  { commits, remote, ignore = [] }: { commits: FileCommit[]; remote?: string; ignore?: string[] },
): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  if (ignore.length) await writeFile(join(path, ".gitignore"), `${ignore.join("\n")}\n`);
  let n = 0;
  for (const commit of commits) {
    n += 1;
    for (const [file, content] of Object.entries(commit.files)) {
      const full = join(path, file);
      if (content === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    git(path, ["add", "-A"]);
    const date = new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
    git(
      path,
      [
        "-c",
        `user.email=${commit.email}`,
        "-c",
        "user.name=Someone",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        commit.subject,
      ],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    );
  }
  if (remote) git(path, ["remote", "add", "origin", remote]);
}

/** Make `origin/main` point at HEAD, as if it had been pushed and fetched. */
export function markPushed(path: string, ref = "HEAD"): void {
  git(path, ["update-ref", "refs/remotes/origin/main", ref]);
  git(path, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}
