import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_ISOLATION_ENV, E2E_SERVER_ARGS } from "../scripts/e2e-isolation";

test("browser test servers ignore personal dotenv files and inherited GitHub accounts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rolecraft-env-test-"));
  try {
    await writeFile(join(cwd, ".env"), "HB_GITHUB_USER=dotenv-account\nROLECRAFT_PRIVATE_TEST=loaded\n");
    const child = Bun.spawn(
      [
        "bun",
        ...E2E_SERVER_ARGS.slice(0, -1),
        "-e",
        `import { isolateE2EEnvironment } from ${JSON.stringify(join(import.meta.dir, "../scripts/e2e-isolation.ts"))}; isolateE2EEnvironment(process.env); console.log(JSON.stringify({user: process.env.HB_GITHUB_USER ?? null, privateSetting: process.env.ROLECRAFT_PRIVATE_TEST ?? null}))`,
      ],
      {
        cwd,
        env: { ...process.env, HB_GITHUB_USER: "parent-account", ...E2E_ISOLATION_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ user: null, privateSetting: null });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("browser servers always bind to loopback without inherited host exceptions", () => {
  expect(E2E_ISOLATION_ENV).toMatchObject({ HB_HOST: "127.0.0.1", HB_ALLOWED_HOSTS: "" });
});
