import { beforeEach, describe, expect, test } from "bun:test";
import { extractText, getDocumentProxy } from "unpdf";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { AddJobResult, ProfileDto, TaskDto, WorkspaceDto } from "@/shared/api";
import { resetDb, testDeps, waitForSplits } from "./setup";

/* Project heads in a drafted resume (decision 82): the model writes [PROJECT-n], the server the head. */

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps();
  app = createApp(deps);
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

const NYX_HEAD = "#### Nyx | https://github.com/juan/nyx";

/** A key, a CV, two projects (one own, one a contribution) split and confirmed, and one pasted job. */
async function setup(options: { nyxPrivate?: boolean } = {}): Promise<WorkspaceDto> {
  await call("PUT", "/profile", {
    contact: { fullName: "Juan Cruz", email: "juan@example.ph", phone: "", location: "Cebu", links: [] },
  });
  await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
  await waitForSplits(
    await json(
      await call("PUT", "/profile/cv", { text: "EXPERIENCE\nBuilt the billing service at Acme." }),
      ProfileDto,
    ),
  );
  const add = async (input: Record<string, unknown>) =>
    waitForSplits(await json(await call("POST", "/profile/addons", input), ProfileDto, 201));
  await add({
    kind: "open_source",
    title: "Nyx",
    body: "Nyx is a CLI that schedules Go jobs on Kubernetes.",
    link: "https://github.com/juan/nyx",
    skills: ["Go", "Kubernetes"],
    projectRole: "own",
    ...(options.nyxPrivate ? { linkPrivate: true } : {}),
  });
  await add({
    kind: "open_source",
    title: "Viem",
    body: "Added value support to deployContract in Viem.",
    projectRole: "contribution",
  });
  await json(await call("POST", "/facts/confirm-all"), ProfileDto);
  const added = await json(
    await call("POST", "/jobs/from-paste", {
      title: "Platform Engineer",
      company: "Stripe",
      description: "Go and Kubernetes. Remote.",
    }),
    AddJobResult,
    201,
  );
  deps.fake.calls.length = 0;
  return json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
}

async function draftResume(ws: WorkspaceDto) {
  return draft(ws, "resume");
}

async function draft(ws: WorkspaceDto, kind: "resume" | "letter") {
  const task = await json(
    await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { kinds: [kind] }),
    TaskDto,
    202,
  );
  await waitForTask(task.id);
  const done = await json(await call("GET", `/tasks/${task.id}`), TaskDto);
  const after = await json(await call("GET", `/opportunities/${ws.opportunity.id}`), WorkspaceDto);
  const resume = after.files.find((f) => f.kind === kind);
  if (!resume) throw new Error(`no ${kind}`);
  return { task: done, resume, ws: after };
}

const prompt = (i: number) => deps.fake.calls[i]?.messages[0]?.content ?? "";

describe("resume drafting with projects", () => {
  test("the prompt lists projects; each [PROJECT-n] becomes a head with the server's link", async () => {
    const ws = await setup();
    const { task, resume } = await draftResume(ws);
    expect(task).toMatchObject({ status: "done", error: null });

    const text = prompt(0);
    expect(text).toContain("PROJECT-1: Nyx (your own project; stack: Go, Kubernetes)");
    expect(text).toContain("PROJECT-2: Viem (a contribution to someone else's project)");
    expect(text).toMatch(/FACT-\d+: Nyx is a CLI .*\(PROJECT-1\)/);

    expect(deps.fake.calls).toHaveLength(1);
    const lines = (resume.body ?? "").split("\n");
    const projects = lines.indexOf("## Projects");
    const contributions = lines.indexOf("## Open Source Contributions");
    expect(projects).toBeGreaterThan(-1);
    expect(lines[projects + 1]).toBe(NYX_HEAD);
    // Your own project is one paragraph, and its stack may be named (decision 83).
    const nyx = (resume.body ?? "").match(/\[(FACT-\d+)\]/g)?.[1];
    expect(lines[projects + 2]).toBe(
      `Nyx is a CLI that schedules Go jobs on Kubernetes ${nyx}. Built with Go, Kubernetes ${nyx}.`,
    );
    expect(contributions).toBeGreaterThan(projects);
    expect(lines[contributions + 1]).toBe("#### Viem");
    expect(lines[contributions + 2]).toStartWith("- Added value support");
    expect(resume.body).not.toContain("[PROJECT-");
  });

  test("the preview PDF and copy text show the head as name and short link", async () => {
    const { resume } = await draftResume(await setup());
    const plain = resume.plain ?? "";
    expect(plain).toContain("Nyx · github.com/juan/nyx\nNyx is a CLI");
    expect(plain).not.toContain("####");

    const res = await call("GET", `/outputs/${resume.id}/preview.pdf`);
    expect(res.status).toBe(200);
    const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
    const pdf = (await extractText(doc, { mergePages: true })).text;
    expect(pdf).toContain("github.com/juan/nyx");
    expect(pdf).not.toContain("####");
    expect(pdf).not.toContain(" | ");
  }, 30_000);

  test("a project whose link is private gets a head without the link", async () => {
    const { resume } = await draftResume(await setup({ nyxPrivate: true }));
    expect(resume.body).toContain("#### Nyx\nNyx is a CLI");
    expect(resume.body).not.toContain("github.com/juan/nyx");
  });

  test("a contribution written under ## Projects is moved to its own section, without a retry", async () => {
    const ws = await setup();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key;
    deps.fake.queue(
      `## Projects\n[PROJECT-1]\nNyx is a CLI [${key("Nyx")}].\n\n[PROJECT-2]\n- Added value support [${key("Added")}]\n## Skills\n- Go [${key("Nyx")}]`,
    );
    const { resume } = await draftResume(ws);
    expect(deps.fake.calls).toHaveLength(1);
    expect(resume.body).toBe(
      `## Projects\n${NYX_HEAD}\nNyx is a CLI [${key("Nyx")}].\n\n## Open Source Contributions\n\n#### Viem\n- Added value support [${key("Added")}]\n\n## Skills\n- Go [${key("Nyx")}]`,
    );
  });

  test("bullets under your own project become one paragraph; a contribution keeps its bullets", async () => {
    const ws = await setup();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const key = (start: string) => profile.facts.find((f) => f.text.startsWith(start))?.key;
    const nyx = key("Nyx");
    deps.fake.queue(
      `## Projects\n[PROJECT-1]\n- Schedules Go jobs [${nyx}]\n- Runs on Kubernetes [${nyx}]\n\n## Open Source Contributions\n[PROJECT-2]\n- Added value support [${key("Added")}]`,
    );
    const { resume } = await draftResume(ws);
    expect(deps.fake.calls).toHaveLength(1);
    expect(resume.body).toContain(`${NYX_HEAD}\nSchedules Go jobs [${nyx}]. Runs on Kubernetes [${nyx}].\n\n`);
    expect(resume.body).toContain(`#### Viem\n- Added value support [${key("Added")}]`);
  });

  test("another project's fact under a head is retried with the rule", async () => {
    const ws = await setup();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const viem = profile.facts.find((f) => f.text.startsWith("Added value"))?.key;
    const wrong = `## Projects\n[PROJECT-1]\n- Added value support to deployContract [${viem}]`;
    deps.fake.queue(wrong);
    const { task } = await draftResume(ws);
    expect(task.status).toBe("done");
    expect(deps.fake.calls).toHaveLength(2);
    expect(deps.fake.calls[1]?.messages[2]?.content).toContain(`is under [PROJECT-1] but cites ${viem}`);
  });
});

describe("letters with projects", () => {
  test("the prompt lists projects by name with the naming rule; a claimed contribution is retried", async () => {
    const ws = await setup();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const viem = profile.facts.find((f) => f.text.startsWith("Added value"))?.key;
    deps.fake.queue(`Dear Stripe,\n\nI built Viem, adding value support to deployContract [${viem}].`);
    const { task, resume: letter } = await draft(ws, "letter");
    expect(task.status).toBe("done");

    const first = prompt(0);
    expect(first).toContain("PROJECT-2: Viem (a contribution to someone else's project)");
    expect(first).toContain("Call a project only by its name there.");
    expect(first).not.toContain("[PROJECT-n]");

    expect(deps.fake.calls).toHaveLength(2);
    expect(deps.fake.calls[1]?.messages[2]?.content).toContain(
      'says "built Viem", but Viem is someone else\'s project the candidate contributed to.',
    );
    expect(letter.body).not.toContain("built Viem");
  });

  test("a letter's own Projects heading doesn't make it put facts under heads", async () => {
    const ws = await setup();
    const profile = ProfileDto.parse(await (await call("GET", "/profile")).json());
    const viem = profile.facts.find((f) => f.text.startsWith("Added value"))?.key;
    deps.fake.queue(`## Projects\nI contributed value support to deployContract in Viem [${viem}].`);
    const { task } = await draft(ws, "letter");
    expect(task.status).toBe("done");
    expect(deps.fake.calls).toHaveLength(1);
  });

  test("a [PROJECT-n] in a letter is not expanded and is retried", async () => {
    const ws = await setup();
    deps.fake.queue("Dear Stripe,\n\n[PROJECT-1]");
    await draft(ws, "letter");
    expect(deps.fake.calls).toHaveLength(2);
    expect(deps.fake.calls[1]?.messages[2]?.content).toContain("writes [PROJECT-1].");
  });
});
