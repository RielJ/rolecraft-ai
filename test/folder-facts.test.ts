import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createGitlabReader } from "@/server/adapters/gitlab";
import { createHttpClient } from "@/server/adapters/http";
import { createFolderReader } from "@/server/adapters/local-projects";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { publicRemote } from "@/server/services/github";
import { waitForTask } from "@/server/services/tasks";
import { AddonPrefillDto, ProfileDto } from "@/shared/api";
import { type FileCommit, makeFileRepo } from "./git-repos";
import { resetDb, testDeps, waitForGithubReads, waitForSplits } from "./setup";

/*
 * "Read for facts" on an add-on added from a folder (decision 81), over HTTP with real git repos
 * and the fake AI.
 */

const ME = "juan@example.ph";
const PAL = "pal@example.ph";
const SECRET = "AKIA-NEVER-READ-THIS";

function history(): FileCommit[] {
  const mine = (subject: string, files: FileCommit["files"]): FileCommit => ({ email: ME, subject, files });
  return [
    mine("feat: routes table", {
      "README.md": "# Jeep Route\n\nPlans jeepney rides across Cebu City.",
      "go.mod": "module jeep",
      "routes/table.go": "package routes\n\nfunc Table() []string { return nil }\n",
    }),
    mine("feat: fare calculator", { "fare/fare.go": "package fare\n\nfunc Fare(km int) int { return 13 + km*2 }\n" }),
    { email: PAL, subject: "docs: typo", files: { "CONTRIBUTING.md": "Be kind." } },
    mine("fix: fare rounding", { "fare/fare.go": "package fare\n\nfunc Fare(km int) int { return 13 + (km+1)*2 }\n" }),
    mine("feat: route search", { "routes/search.go": "package routes\n\nfunc Search(q string) {}\n", ".env": SECRET }),
    mine("fix: search empty query", {
      "routes/search.go": 'package routes\n\nfunc Search(q string) { if q == "" { return } }\n',
    }),
  ];
}

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;
let dir: string;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function settle(res: Response): Promise<ProfileDto> {
  expect(res.status).toBeLessThan(300);
  const profile = ProfileDto.parse(await res.json());
  await waitForSplits(profile);
  await waitForGithubReads(profile);
  return ProfileDto.parse(await (await call("GET", "/profile")).json());
}

beforeEach(async () => {
  await resetDb();
  dir = await realpath(await mkdtemp(join(tmpdir(), "hb-folder-facts-")));
  await makeFileRepo(join(dir, "jeep-route"), { commits: history() });
  deps = await testDeps({ folders: createFolderReader({ extraEmails: [ME], readConfigEmail: false }) });
  app = createApp(deps);
  expect((await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" })).status).toBe(
    200,
  );
});

/** Fill the form from the folder, then save it as the user would. */
async function addFromFolder(path: string) {
  const res = await call("POST", "/profile/addons/prefill", { source: path });
  expect(res.status).toBe(200);
  const prefill = AddonPrefillDto.parse(await res.json());
  const profile = await settle(
    await call("POST", "/profile/addons", {
      kind: "open_source",
      title: prefill.title,
      body: prefill.body,
      link: prefill.link,
      skills: prefill.skills,
      folder: prefill.folder,
    }),
  );
  const item = profile.addons.at(-1);
  if (!item) throw new Error("no add-on");
  return item;
}

describe("Read for facts: a folder", () => {
  test("groups my commits into features, reads their hunks, and keeps private evidence nameless", async () => {
    const item = await addFromFolder(join(dir, "jeep-route"));
    expect(item.folder).toMatchObject({ path: join(dir, "jeep-route"), readTask: null, private: null });
    expect(item.github).toBeNull();

    const profile = await settle(await call("POST", `/profile/addons/${item.id}/github-read`, {}));
    const after = profile.addons.find((a) => a.id === item.id);
    expect(after?.folder?.readTask?.status).toBe("done");
    expect(after?.folder?.private).toBe(true);
    expect(after?.folder?.lastRead).toMatchObject({
      user: ME,
      userFrom: "git emails",
      via: "folder",
      private: true,
      share: { mine: 5, total: 6 },
      features: ["fix", "feat"],
    });

    // The grouping call, then the facts call; the facts prompt has hunks, never the secret.
    const prompts = deps.fake.calls.map((c) => c.messages[0]?.content ?? "");
    const grouping = prompts.find((p) => p.includes('{"features"'));
    expect(grouping).toContain("feat: route search");
    const factsPrompt = prompts.find((p) => p.includes('"evidence"')) ?? "";
    expect(factsPrompt).toContain("PROJECT: jeep-route (private)");
    expect(factsPrompt).toContain("5 of its 6 commits are juan@example.ph's");
    expect(factsPrompt).toMatch(/CHANGE [0-9a-f]{12} fare\/fare\.go/);
    expect(factsPrompt).toContain("+func Fare");
    for (const p of prompts) expect(p).not.toContain(SECRET);

    const facts = profile.facts.filter((f) => f.origin === "github");
    expect(facts.map((f) => f.text)).toContain("feat: fare calculator");
    expect(facts.map((f) => f.text)).not.toContain("docs: typo");
    for (const f of facts) {
      expect(f.evidence).toMatchObject({ repo: "jeep-route", private: true, url: null });
    }
  });

  test("a read sets own or contribution from the commit share; the user's choice wins (decision 82)", async () => {
    const item = await addFromFolder(join(dir, "jeep-route"));
    expect(item.project).toEqual({ role: "own", from: "link", choice: null });

    // Most commits are someone else's: the read says contribution.
    await makeFileRepo(join(dir, "viem"), {
      commits: [
        { email: ME, subject: "feat: deploy value", files: { "deploy.ts": "export const v = 1;\n" } },
        { email: PAL, subject: "feat: core", files: { "core.ts": "export {};\n" } },
        { email: PAL, subject: "feat: more", files: { "more.ts": "export {};\n" } },
      ],
    });
    const viem = await addFromFolder(join(dir, "viem"));
    let profile = await settle(await call("POST", `/profile/addons/${viem.id}/github-read`, {}));
    expect(profile.addons.find((a) => a.id === viem.id)?.project).toEqual({
      role: "contribution",
      from: "read",
      choice: null,
    });

    // The user says it is theirs; a re-read keeps the choice and still records what it found.
    profile = await settle(
      await call("PUT", `/profile/addons/${viem.id}`, {
        kind: "open_source",
        title: "Viem",
        body: "x",
        projectRole: "own",
      }),
    );
    expect(profile.addons.find((a) => a.id === viem.id)?.project).toEqual({ role: "own", from: "you", choice: "own" });
    profile = await settle(await call("POST", `/profile/addons/${viem.id}/github-read`, {}));
    expect(profile.addons.find((a) => a.id === viem.id)?.project).toEqual({ role: "own", from: "you", choice: "own" });

    // Back to "Decide from its commits": the read's answer shows again.
    profile = await settle(
      await call("PUT", `/profile/addons/${viem.id}`, {
        kind: "open_source",
        title: "Viem",
        body: "x",
        projectRole: null,
      }),
    );
    expect(profile.addons.find((a) => a.id === viem.id)?.project?.role).toBe("contribution");
  });

  test("a folder moved after adding fails the read with a clear message", async () => {
    const item = await addFromFolder(join(dir, "jeep-route"));
    await rename(join(dir, "jeep-route"), join(dir, "moved"));
    const res = await call("POST", `/profile/addons/${item.id}/github-read`, {});
    const profile = ProfileDto.parse(await res.json());
    const task = profile.addons.find((a) => a.id === item.id)?.folder?.readTask;
    if (!task) throw new Error("no task");
    await waitForTask(task.id);
    const after = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const done = after.addons.find((a) => a.id === item.id)?.folder?.readTask;
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("is not a folder on this machine. Was it moved?");
  });

  test("without any commit email or GitHub account the read asks for one", async () => {
    deps = await testDeps({ folders: createFolderReader({ readConfigEmail: false }) });
    app = createApp(deps);
    await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
    const item = await addFromFolder(join(dir, "jeep-route"));
    const res = await call("POST", `/profile/addons/${item.id}/github-read`, {});
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("git config --global user.email");
  });

  test("the form's folder is resolved again; a path that isn't a folder is refused", async () => {
    const res = await call("POST", "/profile/addons", {
      kind: "open_source",
      title: "x",
      body: "x",
      folder: join(dir, "nope"),
    });
    expect(res.status).toBe(409);
  });
});

describe("whether a remote is public", () => {
  const http = (answers: Record<string, unknown>) =>
    createHttpClient({
      fetch: async (url) => {
        const body = answers[url];
        return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
      },
      sleep: async () => {},
    });

  test("GitHub answers without login: public, with its name and page", async () => {
    const client = http({
      "https://api.github.com/repos/juandc/jeep-route": {
        private: false,
        full_name: "juandc/jeep-route",
        html_url: "https://github.com/juandc/jeep-route",
      },
    });
    const check = publicRemote({ http: client, gitlab: createGitlabReader({ http: client }) });
    expect(await check("git@github.com:juandc/jeep-route.git")).toEqual({
      host: "github",
      web: "https://github.com/juandc/jeep-route",
      name: "juandc/jeep-route",
    });
    await expect(check("git@github.com:juandc/secret.git")).rejects.toThrow();
    expect(await check("git@example.com:x/y.git")).toBeNull();
  });
});
