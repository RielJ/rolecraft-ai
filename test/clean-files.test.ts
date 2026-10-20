import { beforeEach, describe, expect, test } from "bun:test";
import { extractText, getDocumentProxy } from "unpdf";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddJobResult, ApiErrorBody, ProfileDto, TextExport, WorkspaceDto } from "@/shared/api";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/*
 * Clean files (decision 70) on the server: the preview PDF, clean copy text, the page
 * count, the clean edit that keeps markers, and the "Needs your input" fill.
 */

let deps: Deps;
let app: ReturnType<typeof createApp>;

async function start(over: Partial<Deps> = {}) {
  deps = await testDeps(over);
  app = createApp(deps);
}

beforeEach(async () => {
  await resetDb();
  await start();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

const CV = [
  "- Built a payments API in Go serving 2M requests a day",
  "- Led a team of 4 engineers at Acme Corp",
  "I moved our job queue to Postgres in 2022.",
].join("\n");

/** A confirmed profile (FACT-1 to FACT-3) and a pasted job; returns its workspace. */
async function setup(): Promise<WorkspaceDto> {
  await call("PUT", "/profile", {
    contact: { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Manila", links: [] },
  });
  await waitForSplits(await json(await call("PUT", "/profile/cv", { text: CV }), ProfileDto));
  await call("POST", "/facts/confirm-all");
  const added = await json(
    await call("POST", "/jobs/from-paste", {
      title: "Backend Engineer",
      company: "Acme Inc",
      description: "Payments. Remote, worldwide.",
    }),
    AddJobResult,
    201,
  );
  return json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
}

function file(ws: WorkspaceDto, kind: "resume" | "letter" | "message") {
  const found = ws.files.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
}

const patch = async (id: string, body: unknown, status = 200) =>
  json(await call("PATCH", `/outputs/${id}`, body), WorkspaceDto, status);

async function pdfText(res: Response): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  return (await extractText(doc, { mergePages: true })).text;
}

describe("preview.pdf", () => {
  test("serves inline with the CV file's headers, even while blanks remain, and shows each blank's text", async () => {
    const ws = await setup();
    const resume = file(ws, "resume");
    await patch(resume.id, {
      body: "# Juan Dela Cruz\n## Experience\n- Built a payments API [FACT-1]\n- Worked at [[Employer for the 2019 role]]",
    });
    // The gate still refuses the export.
    expect((await call("GET", `/outputs/${resume.id}/export.pdf`)).status).toBe(409);

    const res = await call("GET", `/outputs/${resume.id}/preview.pdf`);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
      "x-frame-options": "SAMEORIGIN",
    });
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    const text = await pdfText(res);
    expect(text).toContain("Employer for the 2019 role");
    expect(text).not.toContain("[[");
    expect(text).not.toContain("FACT");
    // The name heading is dropped: the header already prints the name, once.
    expect(text.match(/Juan Dela Cruz/g)?.length).toBe(1);
  }, 30_000);

  test("refuses a cross-site read, an unticked file, an empty file and the message", async () => {
    const ws = await setup();
    const resume = file(ws, "resume");
    const cross = await call("GET", `/outputs/${resume.id}/preview.pdf`, undefined, { "sec-fetch-site": "cross-site" });
    expect((await json(cross, ApiErrorBody, 403)).error.code).toBe("forbidden_origin");
    const empty = await call("GET", `/outputs/${resume.id}/preview.pdf`);
    expect((await json(empty, ApiErrorBody, 400)).error.code).toBe("not_exportable");
    await patch(file(ws, "message").id, { body: "Hi [FACT-1]." });
    const msg = await call("GET", `/outputs/${file(ws, "message").id}/preview.pdf`);
    expect((await json(msg, ApiErrorBody, 400)).error.code).toBe("not_exportable");
    await patch(file(ws, "letter").id, { body: "Dear Acme [FACT-1].", included: false });
    const off = await call("GET", `/outputs/${file(ws, "letter").id}/preview.pdf`);
    expect((await json(off, ApiErrorBody, 400)).error.code).toBe("not_exportable");
  });
});

describe("clean text", () => {
  test("Copy text is content only: no name line, no #, no **, no markers; bullets are dots", async () => {
    const ws = await setup();
    await patch(file(ws, "letter").id, { body: "Dear Acme, I build payment APIs [FACT-1]." });
    await patch(file(ws, "message").id, { body: "Hi [FACT-2]." });
    await patch(file(ws, "resume").id, {
      body: "# juan dela cruz\n## Experience\n- **Built** a payments API [FACT-1]\n- Led a team of 4 [FACT-2]",
    });
    const { text } = await json(await call("GET", `/outputs/${file(ws, "resume").id}/text`), TextExport);
    expect(text).toBe("Experience\n• Built a payments API\n• Led a team of 4");
  });

  test("the DTO carries the edit text, the plain text and its word count", async () => {
    const ws = await setup();
    const after = await patch(file(ws, "resume").id, {
      body: "# Juan Dela Cruz\n## Experience\n- **Built** a payments API [FACT-1]\n- Worked at [[Employer]]",
    });
    const resume = file(after, "resume");
    expect(resume.text).toBe("# Juan Dela Cruz\n## Experience\n- **Built** a payments API\n- Worked at [[Employer]]");
    expect(resume.plain).toBe("Experience\n• Built a payments API\n• Worked at [[Employer]]");
    expect(resume.words).toBe(8);
    expect(file(after, "letter")).toMatchObject({ text: null, plain: null, words: 0 });
  });

  test("the facts rail's CV facts with no section have no group", async () => {
    const ws = await setup();
    expect(ws.facts.map((f) => [String(f.key), f.group])).toEqual([
      ["FACT-1", null],
      ["FACT-2", null],
      ["FACT-3", null],
    ]);
  });
});

describe("PATCH { text }", () => {
  test("unchanged sentences keep their markers and citations; changed ones lose them; review clears", async () => {
    const ws = await setup();
    const id = file(ws, "resume").id;
    await patch(id, {
      body: "- Built a payments API [FACT-1]\n- Led a team of 4 [FACT-2]\n- Moved to Postgres [FACT-3]",
    });
    const marked = await json(
      await call("POST", `/outputs/${id}/reviewed`, {
        body: "- Built a payments API [FACT-1]\n- Led a team of 4 [FACT-2]\n- Moved to Postgres [FACT-3]",
      }),
      WorkspaceDto,
    );
    expect(file(marked, "resume").reviewedAt).not.toBeNull();

    const after = await patch(id, { text: "- Moved to Postgres\n- Built a payments API\n- Led a team of 5" });
    const resume = file(after, "resume");
    expect(resume.body).toBe("- Moved to Postgres [FACT-3]\n- Built a payments API [FACT-1]\n- Led a team of 5");
    expect(resume.citations.map((c) => String(c.key))).toEqual(["FACT-1", "FACT-3"]);
    expect(resume.reviewedAt).toBeNull();
    expect(resume.editedAt).not.toBeNull();
    expect(resume.text).toBe("- Moved to Postgres\n- Built a payments API\n- Led a team of 5");
  });

  test("empty text clears the body; body and text together are refused", async () => {
    const ws = await setup();
    const id = file(ws, "resume").id;
    await patch(id, { body: "- Built a payments API [FACT-1]" });
    expect(file(await patch(id, { text: "  " }), "resume").body).toBeNull();
    const both = await call("PATCH", `/outputs/${id}`, { body: "a", text: "b" });
    expect((await json(both, ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });
});

describe("POST fill", () => {
  const check = 'Check this: "Led 40 engineers" is not backed by your facts';

  test("answers fill blanks, Remove drops a Check this sentence, and the save counts as an edit", async () => {
    const ws = await setup();
    const id = file(ws, "resume").id;
    await patch(id, {
      body: `- Built a payments API [FACT-1]. [[${check}]] Shipped it.\n- Worked at [[Employer for the 2019 role]] [FACT-2]`,
    });
    const after = await json(
      await call("POST", `/outputs/${id}/fill`, {
        answers: [{ blank: "Employer for the 2019 role", value: "Globex", saveAsFact: false }],
        remove: [check],
      }),
      WorkspaceDto,
    );
    const resume = file(after, "resume");
    expect(resume.body).toBe("- Built a payments API [FACT-1]. Shipped it.\n- Worked at Globex [FACT-2]");
    expect(resume.editedAt).not.toBeNull();
    expect(after.gate.ok || after.gate.blockers.every((b) => b.kind !== "placeholder")).toBe(true);
    const [row] = await testSql()`SELECT count(*)::int AS n FROM profile_items WHERE kind = 'other'`;
    expect(row?.n).toBe(0);
  });

  test("a Check this answer replaces the whole placeholder", async () => {
    const ws = await setup();
    const id = file(ws, "letter").id;
    await patch(id, { body: `I build APIs [FACT-1]. [[${check}]]` });
    const after = await json(
      await call("POST", `/outputs/${id}/fill`, {
        answers: [{ blank: check, value: "Led 4 engineers.", saveAsFact: true }],
        remove: [],
      }),
      WorkspaceDto,
    );
    expect(file(after, "letter").body).toBe("I build APIs [FACT-1]. Led 4 engineers.");
    // Save as fact is for missing information only.
    const [row] = await testSql()`SELECT count(*)::int AS n FROM profile_items WHERE kind = 'other'`;
    expect(row?.n).toBe(0);
  });

  test("Also save to my facts keeps the answer as a confirmed fact in one add-on", async () => {
    const ws = await setup();
    const id = file(ws, "resume").id;
    await patch(id, { body: "- Worked at [[Employer for the 2019 role]] in [[City]]" });
    await json(
      await call("POST", `/outputs/${id}/fill`, {
        answers: [{ blank: "Employer for the 2019 role", value: "Globex", saveAsFact: true }],
        remove: [],
      }),
      WorkspaceDto,
    );
    const after = await json(
      await call("POST", `/outputs/${id}/fill`, {
        answers: [{ blank: "City", value: "Makati", saveAsFact: true }],
        remove: [],
      }),
      WorkspaceDto,
    );
    expect(file(after, "resume").body).toBe("- Worked at Globex in Makati");

    const items = await testSql()`SELECT title, body, rev FROM profile_items WHERE kind = 'other'`;
    expect([...items]).toEqual([
      { title: "Filled in while drafting", body: "Employer for the 2019 role: Globex\nCity: Makati", rev: 1 },
    ]);
    const profile = await json(await call("GET", "/profile"), ProfileDto);
    const saved = profile.facts.filter((f) => f.itemTitle === "Filled in while drafting");
    expect(saved.map((f) => [f.text, f.status, f.inLatest])).toEqual([
      ["Employer for the 2019 role: Globex", "confirmed", true],
      ["City: Makati", "confirmed", true],
    ]);
    // The rail groups them under the add-on.
    expect(after.facts.filter((f) => f.group === "Filled in while drafting").map((f) => f.text)).toEqual([
      "Employer for the 2019 role: Globex",
      "City: Makati",
    ]);
  });

  test("a fill with nothing to do is refused", async () => {
    const ws = await setup();
    const res = await call("POST", `/outputs/${file(ws, "resume").id}/fill`, { answers: [], remove: [] });
    expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });

  test("a blank that is no longer in the body is refused and nothing changes", async () => {
    const ws = await setup();
    const id = file(ws, "resume").id;
    await patch(id, { body: "- Worked at [[Employer]]" });
    const res = await call("POST", `/outputs/${id}/fill`, {
      answers: [
        { blank: "Employer", value: "Globex", saveAsFact: true },
        { blank: "Gone", value: "x", saveAsFact: true },
      ],
      remove: [],
    });
    expect((await json(res, ApiErrorBody, 409)).error.code).toBe("output_changed");
    const [row] = await testSql()`SELECT body FROM outputs WHERE id = ${id}`;
    expect(row?.body).toBe("- Worked at [[Employer]]");
    const [items] = await testSql()`SELECT count(*)::int AS n FROM profile_items WHERE kind = 'other'`;
    expect(items?.n).toBe(0);
  });
});
