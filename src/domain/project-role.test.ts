import { describe, expect, test } from "bun:test";
import { projectRoleOf } from "./project-role";

describe("projectRoleOf (decision 82)", () => {
  const base = { kind: "open_source", choice: null, read: null, link: null, githubUser: "juandc" } as const;

  test("only projects have a role", () => {
    expect(projectRoleOf({ ...base, kind: "experience", choice: "own" })).toBeNull();
  });

  test("the user's choice wins over the read, and the read over the link", () => {
    const link = "https://github.com/wevm/viem";
    expect(projectRoleOf({ ...base, link, read: "own", choice: "contribution" })).toEqual({
      role: "contribution",
      from: "you",
    });
    expect(projectRoleOf({ ...base, link, read: "own" })).toEqual({ role: "own", from: "read" });
  });

  test("before a read: another account's repo or any pull request is a contribution", () => {
    const role = (link: string | null, githubUser: string | null = "juandc") =>
      projectRoleOf({ ...base, link, githubUser })?.role;
    expect(role("https://github.com/wevm/viem")).toBe("contribution");
    expect(role("https://github.com/JuanDC/nyx")).toBe("own");
    expect(role("https://github.com/juandc/viem/pull/12")).toBe("contribution");
    expect(role("https://gitlab.com/someone/thing")).toBe("own");
    expect(role(null)).toBe("own");
    // No account known: a repo can't be told apart, so it stays the user's.
    expect(role("https://github.com/wevm/viem", null)).toBe("own");
  });
});
