import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";

// The manifest is the extension's permission surface (docs/EXTENSION.md).

const Manifest = z.looseObject({
  manifest_version: z.literal(3),
  permissions: z.array(z.string()),
  optional_host_permissions: z.array(z.string()),
  background: z.strictObject({ service_worker: z.string(), type: z.literal("module") }),
  side_panel: z.strictObject({ default_path: z.string() }),
  action: z.looseObject({}),
});

const raw: unknown = await Bun.file(join(import.meta.dir, "..", "manifest.json")).json();
const manifest = Manifest.parse(raw);
const text = JSON.stringify(raw);

describe("manifest", () => {
  test("asks for exactly the planned permissions", () => {
    expect([...manifest.permissions].sort()).toEqual(
      ["activeTab", "downloads", "scripting", "sidePanel", "storage"].sort(),
    );
  });

  test("host access is optional: loopback plus per-domain https only", () => {
    expect([...manifest.optional_host_permissions].sort()).toEqual(
      ["http://127.0.0.1/*", "http://localhost/*", "https://*/*"].sort(),
    );
  });

  test("never grants access everywhere", () => {
    expect(text).not.toContain("<all_urls>");
    expect(text).not.toContain("*://*/*");
    expect(text).not.toContain("http://*/*");
  });

  test.each(["host_permissions", "content_scripts", "externally_connectable", "web_accessible_resources"])(
    "has no %s",
    (key) => {
      expect(Object.hasOwn(manifest, key)).toBe(false);
    },
  );

  test("the panel and the worker point at built files", () => {
    expect(manifest.side_panel.default_path).toBe("panel.html");
    expect(manifest.background.service_worker).toBe("background.js");
  });
});
