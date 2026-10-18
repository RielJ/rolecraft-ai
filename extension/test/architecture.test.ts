import { beforeAll, describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DiagnosticEntry } from "@shared/extension";
import { z } from "zod";

// Rules the extension's safety depends on (docs/plans/chrome-extension.md, "Extension runtime" and
// "Diagnostics"), checked by reading the source and the built package. Each check names the file
// and line that broke it.

const EXTENSION = resolve(import.meta.dir, "..");
const ROOT = resolve(EXTENSION, "..");
const SRC = join(EXTENSION, "src");
const SERVER = join(ROOT, "src", "server");
const DIST = join(ROOT, "dist-extension");

type Source = { path: string; raw: string; code: string };

const tsx = new Bun.Transpiler({ loader: "tsx" });

/** Every .ts and .tsx file under `dir`. `code` is the transpiled JavaScript: no comments, no types. */
async function sources(dir: string): Promise<Source[]> {
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir, absolute: true })].sort();
  return Promise.all(
    files.map(async (path) => {
      const raw = await Bun.file(path).text();
      return { path, raw, code: tsx.transformSync(raw) };
    }),
  );
}

/**
 * `file:line: text` for each source line that matches, in files whose comment-free code matches.
 * A match only in a comment is not an offence.
 */
function offenders(files: readonly Source[], pattern: RegExp): string[] {
  return files.flatMap((file) => {
    if (!file.code.split("\n").some((line) => pattern.test(line))) return [];
    const lines = file.raw.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
    return (lines.length > 0 ? lines : ["(in transpiled code)"]).map((l) => `${relative(ROOT, file.path)}:${l}`);
  });
}

let all: Source[] = [];
let extension: Source[] = [];
let content: Source[] = [];

beforeAll(async () => {
  all = await sources(SRC);
  extension = await sources(EXTENSION);
  content = all.filter((file) => file.path.startsWith(join(SRC, "content") + sep));
});

describe("source rules", () => {
  test("content scripts never touch chrome.storage", () => {
    expect(content.length).toBeGreaterThan(0);
    expect(offenders(content, /\bchrome\s*(?:\.\s*storage\b|\[\s*["'`]storage["'`])/)).toEqual([]);
  });

  test("nothing uses chrome.storage.sync", () => {
    expect(offenders(all, /\bstorage\s*(?:\.\s*sync\b|\[\s*["'`]sync["'`])/)).toEqual([]);
  });

  test("nothing listens for window messages", () => {
    // chrome.runtime.onMessage is the only channel; a page can post to any `message` listener.
    expect(offenders(all, /addEventListener\s*\(\s*["'`]message(?:error)?["'`]/)).toEqual([]);
    expect(offenders(all, /\bonmessage(?:error)?\b/)).toEqual([]);
  });

  test("no eval or Function constructor", () => {
    expect(offenders(all, /(?<![\w$.])eval\s*\(|\bnew\s+Function\b|(?<![\w$.])Function\s*\(/)).toEqual([]);
  });

  test("extension code never imports the server", () => {
    // Raw text, so `import type` counts too. Specifiers resolve the way tsconfig paths and Vite do.
    const specifier = /\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
    const found = extension.flatMap((file) =>
      file.raw.split("\n").flatMap((line, i) =>
        [...line.matchAll(specifier)].flatMap((match) => {
          const spec = match[1] ?? "";
          const target = spec.startsWith(".")
            ? resolve(dirname(file.path), spec)
            : spec.startsWith("@shared/")
              ? resolve(ROOT, "src", "shared", spec.slice("@shared/".length))
              : spec.startsWith("@/")
                ? resolve(ROOT, "src", spec.slice(2))
                : resolve(ROOT, spec);
          const server =
            target === SERVER || target.startsWith(SERVER + sep) || /(?:^|\/)src\/server(?:\/|$)/.test(spec);
          return server ? [`${relative(ROOT, file.path)}:${i + 1}: ${line.trim()}`] : [];
        }),
      ),
    );
    expect(found).toEqual([]);
  });
});

/** Every object schema inside `schema`, with the path to it. */
function objectsIn(schema: z.core.$ZodType, path = "DiagnosticEntry"): { path: string; object: z.ZodObject }[] {
  if (schema instanceof z.ZodObject) {
    return [
      { path, object: schema },
      ...Object.entries(schema.shape).flatMap(([key, child]) => objectsIn(child, `${path}.${key}`)),
    ];
  }
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return objectsIn(schema.unwrap(), path);
  if (schema instanceof z.ZodArray) return objectsIn(schema.element, `${path}[]`);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => objectsIn(option, path));
  return [];
}

/** Every leaf schema inside `schema` that is a free string, with the path to it. */
function stringsIn(schema: z.core.$ZodType, path = "DiagnosticEntry"): { path: string; string: z.ZodString }[] {
  if (schema instanceof z.ZodString) return [{ path, string: schema }];
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => stringsIn(child, `${path}.${key}`));
  }
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return stringsIn(schema.unwrap(), path);
  if (schema instanceof z.ZodArray) return stringsIn(schema.element, `${path}[]`);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => stringsIn(option, path));
  return [];
}

describe("diagnostics schema", () => {
  const FORBIDDEN = /value|label|text|url|token|code|title|description|name|message|email|phone/i;
  const objects = objectsIn(DiagnosticEntry);

  test("no object in it has a key that could hold what the user typed or the page showed", () => {
    expect(objects.length).toBeGreaterThan(1);
    const keys = objects.flatMap(({ path, object }) => Object.keys(object.shape).map((key) => `${path}.${key}`));
    expect(keys.filter((key) => FORBIDDEN.test(key.split(".").at(-1) ?? ""))).toEqual([]);
  });

  test("every object in it is strict, so an extra key fails to parse", () => {
    expect(objects.filter(({ object }) => !(object.def.catchall instanceof z.ZodNever)).map((o) => o.path)).toEqual([]);
    const entry = {
      ts: 1,
      kind: "request",
      request: "fill",
      origin: "https://jobs.example",
      adapter: "generic",
      counts: { fields: 1, matched: 1, filled: 1, skipped: 0, unresolved: 0 },
      outcome: "ok",
    };
    expect(DiagnosticEntry.safeParse(entry).success).toBe(true);
    for (const key of ["value", "label", "text", "url", "token"]) {
      expect(DiagnosticEntry.safeParse({ ...entry, [key]: "x" }).success).toBe(false);
      expect(DiagnosticEntry.safeParse({ ...entry, counts: { ...entry.counts, [key]: "x" } }).success).toBe(false);
    }
  });

  test("every string in it is capped and pattern-checked", () => {
    const strings = stringsIn(DiagnosticEntry);
    expect(strings.length).toBeGreaterThan(0);
    const loose = strings.filter(({ string }) => string.maxLength === null || string.maxLength > 300);
    expect(loose.map((s) => s.path)).toEqual([]);
    const unpatterned = strings.filter(
      ({ string }) => !string.def.checks?.some((c) => c._zod.def.check === "string_format"),
    );
    expect(unpatterned.map((s) => s.path)).toEqual([]);
  });
});

describe("built package", () => {
  beforeAll(() => {
    // The manifest and content.js as Chrome loads them. Takes about a second.
    const built = Bun.spawnSync(["bun", "run", "build:extension"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`build:extension failed:\n${built.stderr.toString()}`);
  }, 60_000);

  test.each(["host_permissions", "content_scripts", "externally_connectable", "web_accessible_resources"])(
    "the built manifest has no %s",
    async (key) => {
      const manifest: unknown = await Bun.file(join(DIST, "manifest.json")).json();
      expect(z.record(z.string(), z.unknown()).parse(manifest)).not.toHaveProperty(key);
    },
  );

  test("content.js is a classic script: no import or export", async () => {
    // chrome.scripting.executeScript runs classic scripts only, and an import would need a
    // web-accessible chunk the manifest does not list.
    const code = await Bun.file(join(DIST, "content.js")).text();
    const { imports, exports } = new Bun.Transpiler({ loader: "js" }).scan(code);
    expect(imports).toEqual([]);
    expect(exports).toEqual([]);
  });

  test("content.js never touches chrome.storage, including through what it bundles", async () => {
    const code = await Bun.file(join(DIST, "content.js")).text();
    // Report the surrounding 60 characters, not the whole minified bundle.
    const near = [...code.matchAll(/\bchrome\s*(?:\.\s*storage\b|\[\s*["'`]storage["'`])/g)].map((m) =>
      code.slice(Math.max(0, m.index - 30), m.index + 30),
    );
    expect(near).toEqual([]);
  });
});
