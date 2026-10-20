/**
 * `bun run app`: the app you apply with (docs/MVP.md, "Daily app"). It runs from this checkout
 * against the real database with pi, on its own port and its own build folder, so the dev server
 * (3200), the tests and `bun run e2e` (which rebuilds ./dist) never change what it serves.
 *
 * It starts only from a clean, committed tree: uncommitted edits would otherwise reach the app on
 * the next restart. Restart it after a commit that passed `bun run check`.
 */
const PORT = Number(process.env.HB_APP_PORT ?? 3300);
const STATIC_DIR = "./dist-app";

function run(cmd: string[]): string {
  const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
  if (out.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out.stdout.toString();
}

const dirty = run(["git", "status", "--porcelain"]).trimEnd();
if (dirty.trim() !== "") {
  console.error(
    `The daily app starts only from a committed tree, and these files have changes:\n${dirty}\n` +
      "Commit them (after bun run check passes) or set them aside, then run bun run app again.",
  );
  process.exit(1);
}

const busy = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(
  () => true,
  () => false,
);
if (busy) {
  console.error(`Port ${PORT} is already serving. Stop that app first (Ctrl-C in its terminal), then run bun run app.`);
  process.exit(1);
}

const commit = run(["git", "log", "-1", "--format=%h %s"]).trim();
console.log(`Building ${commit} into ${STATIC_DIR}…`);
run(["bunx", "vite", "build", "--outDir", STATIC_DIR, "--emptyOutDir", "--logLevel", "error"]);

console.log(`Starting the daily app on http://localhost:${PORT}`);
const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: { ...process.env, PORT: String(PORT), HB_STATIC_DIR: STATIC_DIR },
  stdio: ["inherit", "inherit", "inherit"],
});
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
process.exit(await server.exited);

export {};
