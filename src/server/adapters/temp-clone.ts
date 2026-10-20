import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubRepoRef } from "@/shared/github-link";
import type { Git } from "./git";

/**
 * A temp clone of a public GitHub repo, for reading the user's hunks when there is no local clone
 * and no gh (decision 81). It is blob-less (`--filter=blob:none`) and has no checkout, so it holds
 * commits and trees only; `git show` fetches just the picked commits' blobs. Only https is allowed
 * while cloning. The clone has 2 minutes, and its folder is removed however the read ends: on a
 * failed clone here, and by `close` after the read.
 */

export const CLONE_TIMEOUT_MS = 120_000;
/** GitHub's `size` (KB) above which a repo is not cloned: 500 MB. */
export const MAX_CLONE_KB = 500 * 1024;
/** Each `git show` in a temp clone may fetch blobs, so it gets longer than a local one. */
export const CLONE_SHOW_TIMEOUT_MS = 60_000;

export type TempClone = { path: string; close(): Promise<void> };

export type Cloner = { clone(input: GithubRepoRef & { branch: string }): Promise<TempClone> };

export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

export function createCloner({
  git,
  url = ({ owner, repo }) => `https://github.com/${owner}/${repo}.git`,
  protocol = "https",
  timeoutMs = CLONE_TIMEOUT_MS,
  root = tmpdir(),
}: {
  git: Git;
  /** Where a repo is cloned from. Tests point it at a local bare repo over `file://`. */
  url?: (ref: GithubRepoRef) => string;
  /** The one protocol the clone may use. */
  protocol?: "https" | "file";
  timeoutMs?: number;
  root?: string;
}): Cloner {
  return {
    async clone(ref) {
      const dir = await mkdtemp(join(root, "hb-clone-"));
      const path = join(dir, "repo");
      const close = () => rm(dir, { recursive: true, force: true });
      try {
        const result = await git.run(
          [
            "-c",
            "protocol.allow=never",
            "-c",
            `protocol.${protocol}.allow=always`,
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--single-branch",
            "--no-tags",
            "--quiet",
            `--branch=${ref.branch}`,
            "--",
            url(ref),
            path,
          ],
          { timeoutMs },
        );
        if (result.exit !== 0) {
          const why = result.stderr === "timed out" ? `took over ${timeoutMs / 1000}s` : "failed";
          throw new CloneError(`Cloning ${ref.owner}/${ref.repo} ${why}.`);
        }
        return { path, close };
      } catch (err) {
        await close();
        throw err;
      }
    },
  };
}
