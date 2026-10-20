import { describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

// Layer rules from docs/ARCHITECTURE.md, "Layers". `scanImports` drops type-only imports, so
// `import type { AppType }` in the SPA passes while any value import from the server fails.

const ROOT = join(import.meta.dir, "..");

type Layer = "shared" | "domain" | "adapters" | "db" | "services" | "http" | "web" | "root";

const RULES: Record<Layer, { layers: readonly Layer[]; npm: "any" | readonly string[] }> = {
  shared: { layers: ["shared"], npm: ["zod"] },
  domain: { layers: ["shared", "domain"], npm: [] },
  adapters: { layers: ["shared", "domain", "adapters"], npm: "any" },
  db: { layers: ["shared", "db"], npm: "any" }, // domain: types only
  services: { layers: ["shared", "domain", "db", "adapters", "services"], npm: "any" },
  http: { layers: ["shared", "services", "http"], npm: "any" },
  web: { layers: ["shared", "web"], npm: "any" },
  root: { layers: ["shared", "domain", "adapters", "db", "services", "http", "root"], npm: "any" },
};

const FORBIDDEN_FILE_IMPORTS: Record<string, readonly string[]> = {
  "src/server/services/sync.ts": ["src/server/db/client"],
};

function layerOf(path: string): Layer | null {
  const prefixes: [string, Layer][] = [
    ["src/shared/", "shared"],
    ["src/domain/", "domain"],
    ["src/server/adapters/", "adapters"],
    ["src/server/db/", "db"],
    ["src/server/services/", "services"],
    ["src/server/http/", "http"],
    ["src/web/", "web"],
    ["src/server/", "root"],
  ];
  return prefixes.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}

const transpiler = new Bun.Transpiler({ loader: "tsx" });

export function checkFile({ path, source }: { path: string; source: string }): string[] {
  const layer = layerOf(path);
  if (layer === null) return [`${path}: not in any layer`];
  const rule = RULES[layer];
  const problems: string[] = [];

  for (const { path: spec } of transpiler.scanImports(source)) {
    const local = spec.startsWith("@/") || spec.startsWith(".");
    if (!local) {
      const builtin = spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:");
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
      const allowed =
        rule.npm === "any" ? !(builtin && (layer === "domain" || layer === "shared")) : rule.npm.includes(pkg);
      if (!allowed) problems.push(`${path}: ${layer} may not import "${spec}"`);
      continue;
    }
    const target = spec.startsWith("@/") ? `src/${spec.slice(2)}` : relative(ROOT, join(ROOT, dirname(path), spec));
    const targetLayer = layerOf(target);
    if (targetLayer === null || !rule.layers.includes(targetLayer)) {
      problems.push(`${path}: ${layer} may not import ${targetLayer ?? target} ("${spec}")`);
    }
    for (const banned of FORBIDDEN_FILE_IMPORTS[path] ?? []) {
      if (target.replace(/\.tsx?$/, "") === banned) problems.push(`${path}: may not import ${banned}`);
    }
  }

  if (layer === "domain") {
    if (/\bDate\.now\s*\(/.test(source)) problems.push(`${path}: domain may not call Date.now(); pass now in`);
    if (/\bnew\s+Date\s*\(\s*\)/.test(source))
      problems.push(`${path}: domain may not call new Date() without an argument`);
    if (/\bMath\.random\s*\(/.test(source)) problems.push(`${path}: domain may not call Math.random()`);
  }
  return problems;
}

describe("architecture", () => {
  test("every source file follows the layer rules", async () => {
    const problems: string[] = [];
    let count = 0;
    for await (const path of new Glob("src/**/*.{ts,tsx}").scan({ cwd: ROOT })) {
      if (/\.test\.tsx?$/.test(path)) continue;
      count++;
      problems.push(...checkFile({ path, source: await Bun.file(join(ROOT, path)).text() }));
    }
    expect(count).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });

  describe("fixtures", () => {
    test("a domain file importing drizzle-orm fails", () => {
      const source = `import { sql } from "drizzle-orm";\nexport const q = sql\`select 1\`;`;
      expect(checkFile({ path: "src/domain/bad.ts", source })).toEqual([
        'src/domain/bad.ts: domain may not import "drizzle-orm"',
      ]);
    });

    test("a domain file importing node:crypto or the server fails", () => {
      const source = `import { createHash } from "node:crypto";\nimport { db } from "@/server/db/client";\nexport const x = [createHash, db];`;
      expect(checkFile({ path: "src/domain/bad.ts", source })).toHaveLength(2);
    });

    test("a domain file reading the clock or randomness fails", () => {
      const source = "export const a = Date.now();\nexport const b = new Date();\nexport const c = Math.random();";
      expect(checkFile({ path: "src/domain/bad.ts", source })).toHaveLength(3);
      expect(
        checkFile({ path: "src/domain/ok.ts", source: "export const d = (iso: string) => new Date(iso);" }),
      ).toEqual([]);
    });

    test("the SPA may import AppType as a type, but not server values", () => {
      const typeOnly = `import type { AppType } from "@/server/http/app";\nexport type A = AppType;`;
      expect(checkFile({ path: "src/web/api.ts", source: typeOnly })).toEqual([]);
      const value = `import { createApp } from "@/server/http/app";\nexport const a = createApp;`;
      expect(checkFile({ path: "src/web/api.ts", source: value })).toHaveLength(1);
    });

    test("sync.ts may not import the app-role client", () => {
      const source = `import { createDb } from "../db/client";\nexport const x = createDb;`;
      expect(checkFile({ path: "src/server/services/sync.ts", source })).toEqual([
        "src/server/services/sync.ts: may not import src/server/db/client",
      ]);
    });

    test("shared may import only zod", () => {
      const source = `import { z } from "zod";\nimport { Hono } from "hono";\nexport const x = [z, Hono];`;
      expect(checkFile({ path: "src/shared/x.ts", source })).toEqual(['src/shared/x.ts: shared may not import "hono"']);
    });
  });
});
