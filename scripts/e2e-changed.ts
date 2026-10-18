/**
 * The e2e step of `bun run check:changed`. Playwright's `--only-changed` follows only a spec's own
 * imports, but specs reach the app over HTTP, so a change to the app selects no spec. When the
 * uncommitted changes touch anything the running app is built from, run the whole suite instead.
 */
const APP = [/^src\/(?!.*\.test\.tsx?$)/, /^drizzle\//, /^test\/fixtures\//, /\.css$/, /^playwright\.config\.ts$/];

function git(args: string[]): string[] {
  const out = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.stdout.toString().split("\n").filter(Boolean);
}

const changed = [
  ...new Set([...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])]),
];
const app = changed.filter((file) => APP.some((pattern) => pattern.test(file)));
const args = app.length > 0 ? [] : ["--only-changed"];

console.log(
  app.length > 0
    ? `e2e: the app changed (${app.slice(0, 3).join(", ")}${app.length > 3 ? `, +${app.length - 3} more` : ""}), so every spec runs.`
    : "e2e: the app is unchanged, so only specs whose imports changed run.",
);
const run = Bun.spawnSync(["bunx", "playwright", "test", ...args, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(run.exitCode ?? 1);
