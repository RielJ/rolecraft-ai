import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  auditHistory,
  auditWorkingTree,
  formatFinding,
  isPlaceholder,
  main,
  pathViolation,
  scanText,
} from "../scripts/public-audit";

/*
 * Every secret-shaped string here is assembled at runtime, so this file never holds a literal
 * that the audit itself would flag. The "random" bodies come from a fixed seed: real-looking,
 * reproducible, and never a real credential.
 */
function noise(length: number, seed = 7): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += chars[state % chars.length];
  }
  return out;
}

const ghToken = () => `gh${"p"}_${noise(36)}`;
const anthropicKey = () => `sk-${"ant"}-api03-${noise(93, 11)}AA`;
const awsKeyId = () => `AK${"IA"}${noise(16, 3).toUpperCase()}`;
const privateKeyBlock = () =>
  [`-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`, noise(70, 5), noise(70, 9), "-----END OPENSSH PRIVATE KEY-----"].join(
    "\n",
  );

describe("pathViolation", () => {
  test.each([
    [".pi/sessions/a.jsonl", "private-agent-state"],
    ["sub/.pi/x", "private-agent-state"],
    [".env", "env-file"],
    [".env.local", "env-file"],
    ["extension/.env.production", "env-file"],
    ["data/cv.pdf", "runtime-data"],
    ["backup.dump", "database-dump"],
    ["db/prod.sqlite3", "database-dump"],
    ["dump.sql.gz", "database-dump"],
    ["scripts/seed.sql", "database-dump"],
    ["extension/key.pem", "private-key-file"],
    ["home/.ssh/id_ed25519", "private-key-file"],
    ["certs/site.p12", "private-key-file"],
    ["dist/index.js", "build-output"],
    ["dist-extension/manifest.json", "build-output"],
    ["test-results/trace.zip", "test-output"],
    ["coverage/lcov.info", "test-output"],
    ["tsconfig.tsbuildinfo", "build-output"],
    ["node_modules/zod/index.js", "dependencies"],
    ["extension/node_modules/x.js", "dependencies"],
  ])("%s is prohibited (%s)", (path, category) => {
    expect(pathViolation(path)).toBe(category);
  });

  test.each([
    ".env.example",
    "drizzle/0001_init.sql",
    "src/server/adapters/key-store.ts",
    "src/data-table.tsx",
    "src/server/data/thing.ts",
    "docs/id_ed25519.pub.md",
    "id_ed25519.pub",
    "test/fixtures/cv.pdf",
    "e2e/environment.ts",
  ])("%s is allowed", (path) => {
    expect(pathViolation(path)).toBeNull();
  });
});

describe("scanText", () => {
  test("flags real-looking secrets by category and line, without the value", () => {
    const text = ["const a = 1;", `token = "${ghToken()}"`, `key: ${anthropicKey()}`, `id=${awsKeyId()}`].join("\n");
    const findings = scanText(text);
    expect(findings).toEqual([
      { line: 2, category: "github-token" },
      { line: 3, category: "anthropic-key" },
      { line: 4, category: "aws-access-key-id" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(ghToken());
  });

  test("flags a private key block at its header line", () => {
    expect(scanText(`intro\n${privateKeyBlock()}\n`)).toEqual([{ line: 2, category: "private-key" }]);
  });

  test("accepts the short fake keys the suite already uses", () => {
    const fixtures = [
      `key: "sk-${"ant"}-good-key-a1B2"`,
      `key: "sk-${"ant"}-api03-very-secret-key-WXYZ"`,
      `key: "sk-${"proj"}-good-key-1234"`,
      `const SECRET = "AK${"IA"}-NEVER-READ-THIS";`,
      `-----BEGIN ${"RSA"} PRIVATE KEY-----`, // a header alone, as in docs
    ];
    expect(scanText(fixtures.join("\n"))).toEqual([]);
  });

  test("accepts obvious placeholders even at full length", () => {
    const fakes = [
      `gh${"p"}_${"x".repeat(36)}`,
      `gh${"p"}_EXAMPLE${noise(29)}`,
      `sk-${"ant"}-api03-${"fake".repeat(24)}`,
      `AK${"IA"}IOSFODNN7EXAMPLE`,
      `AK${"IA"}${"0".repeat(16)}`,
    ];
    for (const fake of fakes) expect(scanText(`v = "${fake}"`)).toEqual([]);
  });

  test("isPlaceholder is narrow: random bodies are not placeholders", () => {
    expect(isPlaceholder(ghToken())).toBe(false);
    expect(isPlaceholder(anthropicKey())).toBe(false);
    expect(isPlaceholder(`gh${"p"}_PLACEHOLDER${noise(25)}`)).toBe(true);
  });
});

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "public-audit-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  await put(root, files);
  return root;
}

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

describe("auditWorkingTree", () => {
  test("a clean repo passes", async () => {
    const root = await repo({ "src/a.ts": "export const a = 1;\n", ".env.example": "KEY=\n" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    expect(auditWorkingTree(root)).toEqual([]);
  });

  test("flags secrets in tracked, staged and untracked files, normal or test", async () => {
    const root = await repo({ "src/a.ts": "export const a = 1;\n" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    await put(root, {
      "src/a.ts": `export const a = "${ghToken()}";\n`, // tracked, unstaged edit
      "test/b.test.ts": `\n\nconst k = "${anthropicKey()}";\n`, // untracked test file
      "src/c.ts": `const id = "${awsKeyId()}";\n`,
    });
    git(root, ["add", "src/c.ts"]);
    await writeFile(join(root, "src/c.ts"), "clean now\n"); // staged copy still holds the key
    const findings = auditWorkingTree(root);
    expect(findings).toEqual([
      { path: "src/a.ts", line: 1, category: "github-token", source: "worktree" },
      { path: "src/c.ts", line: 1, category: "aws-access-key-id", source: "index" },
      { path: "test/b.test.ts", line: 3, category: "anthropic-key", source: "worktree" },
    ]);
  });

  test("flags prohibited paths without reading ignored private files", async () => {
    const root = await repo({ ".gitignore": ".env\n", ".env": `TOKEN=${ghToken()}\n`, "data/x.json": "{}\n" });
    const findings = auditWorkingTree(root);
    // .env is ignored, so it is neither listed nor read; data/ is not ignored here, so its path is flagged.
    expect(findings).toEqual([{ path: "data/x.json", category: "runtime-data", source: "worktree" }]);
  });

  test("the printed report never contains the secret", async () => {
    const root = await repo({ "src/a.ts": `x = "${ghToken()}"\n` });
    const lines: string[] = [];
    const code = await main(["--cwd", root], (line) => lines.push(line));
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("src/a.ts:1");
    expect(out).toContain("github-token");
    expect(out).not.toContain(ghToken());
    expect(out).not.toContain(noise(36).slice(0, 8));
  });
});

describe("auditHistory", () => {
  test("finds secrets and prohibited paths that were removed, and scans each blob once", async () => {
    const root = await repo({ "src/a.ts": `x = "${ghToken()}"\n`, ".env.local": "A=1\n" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "leak"]);
    // The same blob under a second name, then everything removed.
    await put(root, { "src/copy.ts": `x = "${ghToken()}"\n` });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "copy"]);
    git(root, ["rm", "-q", "-r", "--cached", "src", ".env.local"]);
    await rm(join(root, "src"), { recursive: true });
    await rm(join(root, ".env.local"));
    await put(root, { "README.md": "clean\n" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "clean"]);

    expect(auditWorkingTree(root)).toEqual([]);
    const { findings, blobsScanned } = auditHistory(root);
    expect(blobsScanned).toBe(2); // a.ts/copy.ts share one blob, README.md; .env.local is never read
    expect(findings.map((f) => [f.path, f.category])).toEqual([
      [".env.local", "env-file"],
      ["src/a.ts", "github-token"],
    ]);
    const secret = findings.find((f) => f.category === "github-token");
    if (!secret) throw new Error("expected a github-token finding");
    expect(secret.line).toBe(1);
    expect(secret.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(formatFinding(secret)).not.toContain(ghToken());

    const lines: string[] = [];
    expect(await main(["--cwd", root, "--history"], (line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).not.toContain(ghToken());
  });
});
