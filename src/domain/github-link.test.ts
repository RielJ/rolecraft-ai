import { describe, expect, test } from "bun:test";
import {
  commitUrl,
  fileUrl,
  githubLabel,
  githubProfileUser,
  isPrivateGithubUrl,
  parseGithubLink,
  stripPrivateGithubUrls,
} from "./github-link";

describe("parseGithubLink", () => {
  test("repo links parse with or without .git, a trailing slash or a deeper path", () => {
    for (const link of [
      "https://github.com/juandc/jeep-route",
      "https://github.com/juandc/jeep-route/",
      "https://github.com/juandc/jeep-route.git",
      "http://www.github.com/juandc/jeep-route/tree/main/src",
      "https://github.com/juandc/jeep-route/blob/main/README.md#usage",
      "github.com/juandc/jeep-route",
    ]) {
      expect(parseGithubLink(link)).toEqual({ kind: "repo", owner: "juandc", repo: "jeep-route" });
    }
  });

  test("pull request links parse with their number, trailing paths included", () => {
    expect(parseGithubLink("https://github.com/oven-sh/bun/pull/1234")).toEqual({
      kind: "pull",
      owner: "oven-sh",
      repo: "bun",
      number: 1234,
    });
    expect(parseGithubLink("https://github.com/oven-sh/bun/pull/1234/files")).toMatchObject({ number: 1234 });
  });

  test("other links stay stored only", () => {
    for (const link of [
      "https://gitlab.com/juandc/jeep-route",
      "https://github.com/juandc",
      "https://github.com/",
      "https://github.com/orgs/acme/people",
      "https://github.com/settings/profile",
      "https://github.com/juandc/jeep-route/pull/abc",
      "https://github.com/juandc/jeep-route/pull/0",
      "https://gist.github.com/juandc/abc123",
      "https://github.com.evil.example/juandc/jeep-route",
      "https://github.com:8443/juandc/jeep-route",
      "ftp://github.com/juandc/jeep-route",
      "https://example.com",
      "not a link",
    ]) {
      expect(parseGithubLink(link)).toBeNull();
    }
  });

  test("labels name the repo, and the pull request number", () => {
    expect(githubLabel({ kind: "repo", owner: "a", repo: "b" })).toBe("a/b");
    expect(githubLabel({ kind: "pull", owner: "a", repo: "b", number: 7 })).toBe("a/b#7");
  });
});

describe("githubProfileUser", () => {
  test("a profile link gives its account name; repo and other links give null", () => {
    expect(githubProfileUser("https://github.com/juandc")).toBe("juandc");
    expect(githubProfileUser("github.com/JuanDC/")).toBe("JuanDC");
    expect(githubProfileUser("https://github.com/juandc/jeep-route")).toBeNull();
    expect(githubProfileUser("https://github.com/explore")).toBeNull();
    expect(githubProfileUser("https://linkedin.com/in/juandc")).toBeNull();
  });
});

describe("URLs", () => {
  test("file links escape each path segment and keep the slashes", () => {
    expect(fileUrl({ owner: "o", repo: "r", at: "main", path: "src/a b.ts" })).toBe(
      "https://github.com/o/r/blob/main/src/a%20b.ts",
    );
    expect(commitUrl({ owner: "o", repo: "r", sha: "abc1234" })).toBe("https://github.com/o/r/commit/abc1234");
  });
});

describe("stripPrivateGithubUrls", () => {
  const repos = [{ owner: "juandc", repo: "secret-app" }];

  test("removes the repo, commit and file links of a private repo, any spelling", () => {
    const text = [
      "Built the routing engine (https://github.com/juandc/secret-app).",
      "Fixed the cache in https://github.com/juandc/secret-app/commit/0123456789abcdef0123456789abcdef01234567.",
      "See github.com/JuanDC/Secret-App/blob/main/src/cache.ts for details.",
      "Also www.github.com/juandc/secret-app.git",
    ].join("\n");
    const out = stripPrivateGithubUrls({ text, repos });
    expect(out).not.toMatch(/secret-app/i);
    expect(out).toBe(["Built the routing engine.", "Fixed the cache in.", "See for details.", "Also"].join("\n"));
  });

  test("leaves public repos and repos that only share a prefix", () => {
    const text = "Public: https://github.com/juandc/secret-app-docs and https://github.com/juandc/jeep-route.";
    expect(stripPrivateGithubUrls({ text, repos })).toBe(text);
    expect(stripPrivateGithubUrls({ text, repos: [] })).toBe(text);
  });

  test("isPrivateGithubUrl tells a contact link apart", () => {
    expect(isPrivateGithubUrl({ link: "https://github.com/juandc/secret-app", repos })).toBe(true);
    expect(isPrivateGithubUrl({ link: "https://github.com/juandc", repos })).toBe(false);
  });
});
