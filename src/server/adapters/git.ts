/**
 * Running git without a shell (decisions 78, 79, 81). Every call is an argv array, prompts are off,
 * `core.fsmonitor` is forced off, and diffs never run external diff or textconv programs, so a
 * repo's own config or attributes can't make a read run a program. Output is capped in bytes and
 * time; a call over either is killed and reported as failed.
 */

/** The slice of `Bun.spawn` git runs through, so tests can count or fake calls. */
export type GitSpawn = (
  cmd: string[],
  options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; env: Record<string, string | undefined> },
) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };

export type GitResult = { exit: number; stdout: string; stderr: string; cut: boolean };

export type Git = {
  /** `git <args>`, outside any repo. */
  run(args: readonly string[], limits?: GitLimits): Promise<GitResult>;
  /** `git -C <dir> -c core.fsmonitor=false <args>`. */
  repo(dir: string, args: readonly string[], limits?: GitLimits): Promise<GitResult>;
};

export type GitLimits = { timeoutMs?: number; maxBytes?: number };

export const GIT_TIMEOUT_MS = 15_000;
/** Default stdout cap: 4 MB. A cut output keeps what was read, marked `cut`. */
export const GIT_MAX_BYTES = 4 * 1024 * 1024;

const defaultSpawn: GitSpawn = (cmd, options) => Bun.spawn(cmd, options);

/** Read a stream up to `max` bytes; past that, stop and report it cut. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; cut: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), cut };
}

export function createGit({ git = "git", spawn = defaultSpawn }: { git?: string; spawn?: GitSpawn } = {}): Git {
  async function run(args: readonly string[], limits: GitLimits = {}): Promise<GitResult> {
    const { timeoutMs = GIT_TIMEOUT_MS, maxBytes = GIT_MAX_BYTES } = limits;
    const proc = spawn([git, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_EXTERNAL_DIFF: undefined,
        GIT_PAGER: "cat",
        LC_ALL: "C",
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const done = Promise.all([
        readCapped(proc.stdout, maxBytes),
        readCapped(proc.stderr, 64 * 1024),
        proc.exited.catch(() => -1),
      ]);
      const result = await Promise.race([done, timedOut]);
      if (result === "timeout") {
        proc.kill();
        return { exit: -1, stdout: "", stderr: "timed out", cut: false };
      }
      const [out, err, exit] = result;
      if (out.cut) proc.kill();
      return { exit: out.cut ? 0 : exit, stdout: out.text, stderr: err.text, cut: out.cut };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    run,
    repo: (dir, args, limits) => run(["-C", dir, "-c", "core.fsmonitor=false", ...args], limits),
  };
}
