import { describe, expect, test } from "bun:test";
import type { LocalFolder } from "./local-scan";
import {
  folderPrefill,
  type GithubAbout,
  githubPrefill,
  gitlabPrefill,
  parseProjectSource,
  SOURCE_HELP,
} from "./project-source";

const parse = (raw: string, gitlabHosts: string[] = []) => parseProjectSource({ raw, gitlabHosts });

describe("parseProjectSource", () => {
  test("GitHub repos and pull requests, with or without a scheme, and SSH remotes", () => {
    expect(parse("https://github.com/juandc/jeep-route")).toEqual({
      kind: "github",
      link: { kind: "repo", owner: "juandc", repo: "jeep-route" },
    });
    expect(parse("github.com/juandc/jeep-route/tree/main/src")).toEqual({
      kind: "github",
      link: { kind: "repo", owner: "juandc", repo: "jeep-route" },
    });
    expect(parse("https://github.com/sqlc-dev/sqlc/pull/3141")).toEqual({
      kind: "github",
      link: { kind: "pull", owner: "sqlc-dev", repo: "sqlc", number: 3141 },
    });
    expect(parse("git@github.com:juandc/akashic.git")).toEqual({
      kind: "github",
      link: { kind: "repo", owner: "juandc", repo: "akashic" },
    });
    expect(parse("https://github.com/juandc")).toEqual({
      kind: "unknown",
      message: "That GitHub link isn't a repo or a pull request.",
    });
  });

  test("GitLab on gitlab.com and listed hosts, subgroups included", () => {
    expect(parse("https://gitlab.com/inkscape/inkscape")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      path: "inkscape/inkscape",
    });
    expect(parse("gitlab.com/gitlab-org/cli/-/tree/main")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      path: "gitlab-org/cli",
    });
    expect(parse("git@gitlab.com:group/sub/project.git")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      path: "group/sub/project",
    });
    expect(parse("https://git.acme.ph/team/billing", ["git.acme.ph"])).toEqual({
      kind: "gitlab",
      host: "git.acme.ph",
      path: "team/billing",
    });
    expect(parse("https://gitlab.com/inkscape")).toEqual({
      kind: "unknown",
      message: "That GitLab link isn't a project.",
    });
  });

  test("an unlisted host is never called", () => {
    expect(parse("https://gitlab.acme.ph/team/billing")).toEqual({
      kind: "unknown",
      message: "To read gitlab.acme.ph, add it to HB_GITLAB_HOSTS and restart the app.",
    });
    expect(parse("https://git.acme.ph/team/billing")).toEqual({ kind: "unknown", message: SOURCE_HELP });
    expect(parse("https://gitlab.com:8443/a/b")).toEqual({ kind: "unknown", message: SOURCE_HELP });
    expect(parse("ftp://gitlab.com/a/b")).toEqual({ kind: "unknown", message: SOURCE_HELP });
    expect(parse("   ")).toEqual({ kind: "unknown", message: SOURCE_HELP });
  });

  test("folder paths start with / or ~", () => {
    expect(parse(" ~/personal/projects/pi-adw ")).toEqual({ kind: "folder", path: "~/personal/projects/pi-adw" });
    expect(parse("/srv/code/tool")).toEqual({ kind: "folder", path: "/srv/code/tool" });
    expect(parse("~")).toEqual({ kind: "folder", path: "~" });
    expect(parse("projects/tool").kind).toBe("unknown");
  });
});

const about = (over: Partial<GithubAbout> = {}): GithubAbout => ({
  owner: "juandc",
  repo: "jeep-route",
  private: false,
  description: null,
  language: "TypeScript",
  readme: null,
  pull: null,
  ...over,
});

describe("githubPrefill", () => {
  test("a repo: description first, then the README paragraph, then a plain line", () => {
    expect(githubPrefill({ about: about({ description: "Jeepney routes" }), user: "juandc" })).toEqual({
      title: "jeep-route",
      body: "Jeepney routes",
      link: "https://github.com/juandc/jeep-route",
      skills: ["TypeScript"],
      linkPrivate: false,
      note: null,
    });
    expect(githubPrefill({ about: about({ readme: "# x\n\nPlans jeepney rides." }), user: null }).body).toBe(
      "Plans jeepney rides.",
    );
    expect(githubPrefill({ about: about({ language: null }), user: null }).body).toBe(
      "jeep-route, a repository on GitHub.",
    );
  });

  test("a private repo's link is kept out of exports; someone else's repo gets a note", () => {
    expect(githubPrefill({ about: about({ private: true }), user: "juandc" }).linkPrivate).toBe(true);
    expect(githubPrefill({ about: about({ owner: "sqlc-dev", repo: "sqlc" }), user: "juandc" }).note).toBe(
      "sqlc-dev owns this repo, not juandc. Write what you did in it, or link your pull request instead.",
    );
  });

  test("a pull request: its title, and its description's first paragraph", () => {
    const pull = { number: 3141, title: "Add TypeScript codegen for enums", body: "## Why\n\nEnums were **strings**." };
    expect(
      githubPrefill({ about: about({ owner: "sqlc-dev", repo: "sqlc", language: "Go", pull }), user: "juandc" }),
    ).toEqual({
      title: "Add TypeScript codegen for enums",
      body: "Pull request to sqlc-dev/sqlc: Enums were strings.",
      link: "https://github.com/sqlc-dev/sqlc/pull/3141",
      skills: ["Go"],
      linkPrivate: false,
      note: null,
    });
    expect(githubPrefill({ about: about({ pull: { ...pull, body: null } }), user: null }).body).toBe(
      "Pull request to juandc/jeep-route.",
    );
  });
});

describe("gitlabPrefill", () => {
  test("description or README, top three languages", () => {
    expect(
      gitlabPrefill({
        name: "billing",
        webUrl: "https://gitlab.com/team/billing",
        description: "",
        languages: ["Go", "TypeScript", "Shell", "Makefile"],
        readme: "# Billing\n\nInvoices for sari-sari stores.",
      }),
    ).toEqual({
      title: "billing",
      body: "Invoices for sari-sari stores.",
      link: "https://gitlab.com/team/billing",
      skills: ["Go", "TypeScript", "Shell"],
      linkPrivate: false,
      note: null,
    });
  });
});

describe("folderPrefill", () => {
  const ME = "juan@example.ph";
  const folder = (over: Partial<LocalFolder> = {}): LocalFolder => ({
    folder: "kain-tayo",
    git: { authors: { [ME]: 9 }, lastCommitAt: null, remote: null },
    rootFiles: ["go.mod"],
    readme: "# Kain Tayo\n\nRecipe planner.",
    ...over,
  });

  test("your repo: README text, no link, no note", () => {
    expect(folderPrefill({ folder: folder(), emails: [ME], githubUser: null })).toEqual({
      title: "kain-tayo",
      body: "Recipe planner.",
      link: null,
      skills: ["Go"],
      linkPrivate: false,
      note: null,
    });
  });

  test("your GitHub remote is linked and kept out of exports until read", () => {
    const out = folderPrefill({
      folder: folder({ git: { authors: { [ME]: 9 }, lastCommitAt: null, remote: "git@github.com:juandc/kain.git" } }),
      emails: [ME],
      githubUser: "juandc",
    });
    expect([out.link, out.linkPrivate]).toEqual(["https://github.com/juandc/kain", true]);
  });

  test("someone else's repo: linked, with a note", () => {
    const out = folderPrefill({
      folder: folder({
        git: { authors: { "leo@x.dev": 31 }, lastCommitAt: null, remote: "https://gitlab.com/leo/mux.git" },
      }),
      emails: [ME],
      githubUser: "juandc",
    });
    expect([out.link, out.linkPrivate, out.note]).toEqual([
      "https://gitlab.com/leo/mux",
      true,
      "Most of this repo's commits are by someone else. Write what you did in it.",
    ]);
  });

  test("not a git repo: a note", () => {
    expect(folderPrefill({ folder: folder({ git: null }), emails: [ME], githubUser: null }).note).toBe(
      "This folder isn't a git repo, so nothing shows the work is yours.",
    );
  });
});
