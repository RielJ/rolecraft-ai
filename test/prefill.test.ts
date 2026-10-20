import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureReader, type GithubSnapshotInput } from "@/server/adapters/github-fixture";
import { createGitlabReader } from "@/server/adapters/gitlab";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createFolderReader } from "@/server/adapters/local-projects";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddonPrefillDto, ApiErrorBody, ProfileDto } from "@/shared/api";
import { makeRepo } from "./git-repos";
import { resetDb, testDeps, waitForSplits } from "./setup";

const ME = "juan@example.ph";

let deps: Deps;
let app: ReturnType<typeof createApp>;
let gitlabUrls: string[];

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });

const prefill = async (source: string) => {
  const res = await call("POST", "/profile/addons/prefill", { source });
  const body: unknown = await res.json();
  return res.status === 200
    ? { status: 200, prefill: AddonPrefillDto.parse(body) }
    : { status: res.status, error: ApiErrorBody.parse(body).error.message };
};

const snapshot = (over: Partial<GithubSnapshotInput> & { repo: string }): GithubSnapshotInput => ({
  owner: "juandc",
  private: false,
  description: null,
  files: {},
  ...over,
});

/** GitLab answers for gitlab.com/team/billing, and 404 for anything else. */
const gitlabFetch: FetchFn = async (url) => {
  gitlabUrls.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url === "https://gitlab.com/api/v4/projects/team%2Fbilling") {
    return json({
      id: 42,
      name: "billing",
      web_url: "https://gitlab.com/team/billing",
      description: "",
      default_branch: "main",
      readme_url: "https://gitlab.com/team/billing/-/blob/main/README.md",
    });
  }
  if (url === "https://gitlab.com/api/v4/projects/42/languages") return json({ TypeScript: 20.5, Go: 79.5 });
  if (url === "https://gitlab.com/api/v4/projects/42/repository/files/README.md/raw?ref=main") {
    return new Response("# Billing\n\nInvoices for sari-sari stores.", { status: 200 });
  }
  return new Response('{"message":"404 Project Not Found"}', { status: 404 });
};

beforeEach(async () => {
  await resetDb();
  gitlabUrls = [];
  const github = await mkdtemp(join(tmpdir(), "hb-prefill-gh-"));
  const snapshots = [
    snapshot({
      repo: "jeep-route",
      language: "TypeScript",
      files: { "README.md": "# jeep-route\n\nPlans jeepney rides across Cebu City." },
    }),
    snapshot({ repo: "sari-ledger", private: true, language: "Go", description: "Offline credit ledger" }),
    snapshot({
      owner: "sqlc-dev",
      repo: "sqlc",
      language: "Go",
      pulls: [
        {
          number: 3141,
          title: "Add TypeScript codegen for enums",
          body: "Enums were strings in the generated code.",
          author: "juandc",
          headSha: "abc123",
          files: [],
        },
      ],
    }),
  ];
  for (const s of snapshots) await Bun.write(join(github, `${s.repo}.json`), JSON.stringify(s));
  deps = await testDeps({
    github: createFixtureReader({ dir: github, user: null }),
    gitlab: createGitlabReader({ http: createHttpClient({ fetch: gitlabFetch, sleep: async () => {} }) }),
    folders: createFolderReader({ extraEmails: [ME], readConfigEmail: false }),
  });
  app = createApp(deps);
  const contact = {
    fullName: "Juan Dela Cruz",
    email: ME,
    phone: "",
    location: "Cebu",
    links: ["https://github.com/juandc"],
  };
  expect((await call("PUT", "/profile", { contact })).status).toBe(200);
});

describe("Fill the add-on form from a link or folder", () => {
  test("a GitHub repo: README paragraph, language; a private one is marked private", async () => {
    expect(await prefill("github.com/juandc/jeep-route")).toEqual({
      status: 200,
      prefill: {
        title: "jeep-route",
        body: "Plans jeepney rides across Cebu City.",
        link: "https://github.com/juandc/jeep-route",
        skills: ["TypeScript"],
        linkPrivate: false,
        folder: null,
        note: null,
      },
    });
    const ledger = await prefill("https://github.com/juandc/sari-ledger");
    expect(ledger.prefill).toMatchObject({ body: "Offline credit ledger", linkPrivate: true });
  });

  test("a GitHub pull request to someone else's repo", async () => {
    expect((await prefill("https://github.com/sqlc-dev/sqlc/pull/3141")).prefill).toEqual({
      title: "Add TypeScript codegen for enums",
      body: "Pull request to sqlc-dev/sqlc: Enums were strings in the generated code.",
      link: "https://github.com/sqlc-dev/sqlc/pull/3141",
      skills: ["Go"],
      linkPrivate: false,
      folder: null,
      note: null,
    });
    expect((await prefill("https://github.com/sqlc-dev/sqlc")).prefill?.note).toBe(
      "sqlc-dev owns this repo, not juandc. Write what you did in it, or link your pull request instead.",
    );
  });

  test("a public GitLab project; a missing or private one says so", async () => {
    expect((await prefill("https://gitlab.com/team/billing")).prefill).toEqual({
      title: "billing",
      body: "Invoices for sari-sari stores.",
      link: "https://gitlab.com/team/billing",
      skills: ["Go", "TypeScript"],
      linkPrivate: false,
      folder: null,
      note: null,
    });
    expect(await prefill("https://gitlab.com/team/secret")).toEqual({
      status: 409,
      error: "GitLab has no public project there. Private GitLab projects can't be read yet.",
    });
  });

  test("an unlisted self-hosted host is never called", async () => {
    expect(await prefill("https://gitlab.acme.ph/team/billing")).toEqual({
      status: 409,
      error: "To read gitlab.acme.ph, add it to HB_GITLAB_HOSTS and restart the app.",
    });
    expect(gitlabUrls).toEqual([]);
  });

  test("a folder: README, languages from root files; a missing folder says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-prefill-"));
    await makeRepo(join(dir, "kain-tayo"), { commits: { [ME]: 9 } });
    await writeFile(join(dir, "kain-tayo", "README.md"), "# Kain Tayo\n\nRecipe planner for carinderias.");
    await writeFile(join(dir, "kain-tayo", "go.mod"), "module kain");
    await mkdir(join(dir, "notes"));

    expect((await prefill(join(dir, "kain-tayo"))).prefill).toEqual({
      title: "kain-tayo",
      body: "Recipe planner for carinderias.",
      link: null,
      skills: ["Go"],
      linkPrivate: false,
      folder: await realpath(join(dir, "kain-tayo")),
      note: null,
    });
    expect((await prefill(join(dir, "notes"))).prefill).toMatchObject({
      body: "notes, a personal project.",
      note: "This folder isn't a git repo, so nothing shows the work is yours.",
    });
    expect(await prefill(join(dir, "nope"))).toEqual({
      status: 409,
      error: `${join(dir, "nope")} is not a folder on this machine.`,
    });
  });

  test("anything else is refused with what to paste", async () => {
    expect(await prefill("https://example.com/project")).toEqual({
      status: 409,
      error: "Paste a GitHub or GitLab link, or a folder path starting with / or ~/.",
    });
    expect((await call("POST", "/profile/addons/prefill", { source: "" })).status).toBe(400);
  });

  test("saving a form filled from a private repo keeps its link out of exports from the start", async () => {
    const res = await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "sari-ledger",
      body: "Offline credit ledger",
      link: "https://github.com/juandc/sari-ledger",
      linkPrivate: true,
    });
    expect(res.status).toBe(201);
    const profile = ProfileDto.parse(await res.json());
    await waitForSplits(profile);
    expect(profile.addons[0]?.github?.private).toBe(true);
  });
});
