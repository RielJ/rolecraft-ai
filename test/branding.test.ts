import { expect, test } from "bun:test";
import { join } from "node:path";
import { USER_AGENT } from "@/server/adapters/http";

const root = join(import.meta.dir, "..");

test("the package, page title and navigation identify Rolecraft", async () => {
  const pkg: unknown = await Bun.file(join(root, "package.json")).json();
  expect(pkg).toMatchObject({ name: "rolecraft", private: true });
  const html = await Bun.file(join(root, "index.html")).text();
  expect(html).toContain("<title>Rolecraft</title>");
  const nav = await Bun.file(join(root, "src/web/components/top-bar.tsx")).text();
  expect(nav).toContain("Rolecraft");
  expect(nav).not.toContain("Hanapbuhay");
});

test("outbound requests identify Rolecraft", () => {
  expect(USER_AGENT).toBe("rolecraft/0.1 (personal use)");
});
