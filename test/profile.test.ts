import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkCandidates, splitFacts } from "@/domain/split";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { AiError } from "@/server/adapters/ai/types";
import { EXTRACT_MESSAGES, extractCvText } from "@/server/adapters/extract";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import {
  AddJobResult,
  type AddonInput,
  ApiErrorBody,
  ProfileDto,
  type ProfileItemDto,
  TaskDto,
  WorkspaceDto,
} from "@/shared/api";
import { CV_LINES } from "./fixtures/make-fixtures";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

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

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name));

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fixture(name).arrayBuffer());
}

/** Wait for any running split, then read the profile. */
async function settled(res: Response, status = 200): Promise<ProfileDto> {
  await waitForSplits(await json(res, ProfileDto, status));
  return json(await call("GET", "/profile"), ProfileDto);
}

const pasteCv = async (text: string) => settled(await call("PUT", "/profile/cv", { text }));

async function upload(name: string, type: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([await fixture(name).arrayBuffer()], name, { type }));
  return app.request("/api/profile/cv/file", { method: "POST", body: form });
}

const addAddon = async (input: AddonInput) => settled(await call("POST", "/profile/addons", input), 201);

async function saveKey() {
  const res = await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
  expect(res.status).toBe(200);
}

function fact(profile: ProfileDto, text: string) {
  const found = profile.facts.find((f) => f.text.includes(text));
  if (!found) throw new Error(`no fact like ${text}`);
  return found;
}

const texts = (profile: ProfileDto) => profile.facts.map((f) => f.text);
const splitReply = (...facts: string[]) => JSON.stringify({ facts: facts.map((text) => ({ text })) });

function splitTask(item: ProfileItemDto | null | undefined) {
  if (!item?.splitTask) throw new Error("no split task");
  return item.splitTask;
}

describe("extract: PDF and DOCX", () => {
  test("the PDF fixture extracts to its text", async () => {
    const result = await extractCvText({ bytes: await fixtureBytes("cv.pdf") });
    expect(result).toEqual({ kind: "text", format: "pdf", text: CV_LINES.join("\n") });
  });

  test("the DOCX fixture extracts to its paragraphs", async () => {
    const result = await extractCvText({ bytes: await fixtureBytes("cv.docx") });
    if (result.kind !== "text") throw new Error(result.message);
    expect(result.format).toBe("docx");
    expect(result.text.split("\n").filter(Boolean)).toEqual(CV_LINES);
  });

  test("the scanned PDF returns the no-text-layer message", async () => {
    const result = await extractCvText({ bytes: await fixtureBytes("cv-scanned.pdf") });
    expect(result).toEqual({
      kind: "failed",
      reason: "no_text_layer",
      message: "This PDF has no text layer. Paste the text instead.",
    });
  });

  test("a PDF under 200 characters counts as no text layer; other formats are refused", async () => {
    const short = await extractCvText({ bytes: new TextEncoder().encode("%PDF-1.4 broken") });
    expect(short).toMatchObject({ kind: "failed", reason: "unreadable" });
    const text = await extractCvText({ bytes: new TextEncoder().encode("Just some text") });
    expect(text).toMatchObject({ kind: "failed", reason: "unsupported", message: EXTRACT_MESSAGES.unsupported });
  });

  test("uploading the PDF saves its text into the cv item with the file name, and splits it", async () => {
    const profile = await settled(await upload("cv.pdf", "application/pdf"));
    expect(profile.cv).toMatchObject({ kind: "cv", fileName: "cv.pdf", rev: 1, body: CV_LINES.join("\n") });
    expect(splitTask(profile.cv)).toMatchObject({ kind: "split", status: "done" });
    expect(texts(profile)).toContain("Cut invoice processing time from 40 minutes to 6 minutes");
    expect(profile.facts.every((f) => f.status === "pending")).toBe(true);
  });

  test("uploading the DOCX gives the same facts as the PDF", async () => {
    const fromDocx = texts(await settled(await upload("cv.docx", "application/octet-stream")));
    await resetDb();
    const fromPdf = texts(await settled(await upload("cv.pdf", "application/pdf")));
    expect(fromDocx).toEqual(fromPdf);
  });

  test("uploading the scanned PDF returns 422 with the message, and saves nothing", async () => {
    const res = await upload("cv-scanned.pdf", "application/pdf");
    const body = await json(res, ApiErrorBody, 422);
    expect(body.error).toMatchObject({ code: "unreadable_file" });
    expect(body.error.message).toContain("This PDF has no text layer. Paste the text instead.");
    expect([...(await testSql()`SELECT id FROM profile_items`)]).toEqual([]);
  });

  test("an upload with no file is a 400", async () => {
    const res = await app.request("/api/profile/cv/file", { method: "POST", body: new FormData() });
    expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
  });
});

describe("contact from the CV header (decision 49)", () => {
  const HEADED = [
    "Ana Cruz",
    "+63 917 555 0101 • ana@cruz.dev • Iligan City",
    "https://github.com/anacruz",
    "- Built a billing service in Go",
  ].join("\n");

  test("saving a CV fills the empty contact fields from its header", async () => {
    const profile = await pasteCv(HEADED);
    expect(profile.contact).toEqual({
      fullName: "Ana Cruz",
      email: "ana@cruz.dev",
      phone: "+63 917 555 0101",
      location: "Iligan City, Philippines",
      links: ["https://github.com/anacruz"],
    });
  });

  test("a field the user filled is never overwritten by a CV save", async () => {
    const mine = { fullName: "Ana C.", email: "me@work.ph", phone: "", location: "Cebu City", links: [] };
    expect((await call("PUT", "/profile", { contact: mine })).status).toBe(200);
    const profile = await pasteCv(HEADED);
    expect(profile.contact).toEqual({ ...mine, phone: "+63 917 555 0101", links: ["https://github.com/anacruz"] });
  });
});

describe("split: checked against the item's own text", () => {
  test("a candidate with a number not in the CV text is dropped", () => {
    const evidence = CV_LINES.join("\n");
    const result = checkCandidates({
      evidence,
      candidates: [
        "Cut invoice processing time from 40 minutes to 6 minutes",
        "Cut invoice processing time from 40 minutes to 5 minutes",
        "Mentored 3 junior engineers through code review",
      ],
    });
    expect(result.kept).toEqual([
      "Cut invoice processing time from 40 minutes to 6 minutes",
      "Mentored 3 junior engineers through code review",
    ]);
    expect(result.dropped).toEqual([
      { text: "Cut invoice processing time from 40 minutes to 5 minutes", tokens: ["5"] },
    ]);
  });

  test("a candidate naming a skill, year or proper noun the text lacks is dropped", () => {
    const result = checkCandidates({
      evidence: CV_LINES.join("\n"),
      candidates: [
        "Built a billing service in Kotlin",
        "Graduated in 2019",
        "Worked at Google",
        "Built a billing service in TypeScript and Postgres at Lakbay Labs",
        "built a billing service in typescript and postgres at lakbay labs",
        "Wrote [[something]] here",
      ],
    });
    expect(result.kept).toEqual(["Built a billing service in TypeScript and Postgres at Lakbay Labs"]);
    expect(result.dropped.map((d) => d.text)).toEqual([
      "Built a billing service in Kotlin",
      "Graduated in 2019",
      "Worked at Google",
      "Wrote [[something]] here",
    ]);
  });

  test("with an AI key, the light tier splits the CV and an invented number never becomes a fact", async () => {
    await saveKey();
    deps.fake.queue(
      splitReply(
        "Built a billing service in TypeScript and Postgres at Lakbay Labs",
        "Cut invoice processing time from 40 minutes to 5 minutes",
        "Mentored 3 junior engineers through code review",
      ),
    );
    const profile = await pasteCv(CV_LINES.join("\n"));
    expect(texts(profile)).toEqual([
      "Built a billing service in TypeScript and Postgres at Lakbay Labs",
      "Mentored 3 junior engineers through code review",
    ]);
    // The split, then the roles read in the same task (decision 71).
    expect(deps.fake.calls).toHaveLength(2);
    const prompt = deps.fake.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(`<<<\n${CV_LINES.join("\n")}\n>>>`);
    const calls = await testSql()`SELECT purpose, tier, model FROM ai_calls ORDER BY created_at, purpose DESC`;
    const model = deps.fake.calls[0]?.model ?? "";
    expect([...calls]).toEqual([
      { purpose: "split", tier: "light", model },
      { purpose: "roles", tier: "light", model },
    ]);
  });

  test("without an AI key, split falls back to the rule splitter and makes no AI call", async () => {
    const cv = CV_LINES.join("\n");
    const profile = await pasteCv(cv);
    expect(profile.aiReady).toBe(false);
    expect(texts(profile)).toEqual(splitFacts({ text: cv }));
    expect(texts(profile)).not.toContain("EXPERIENCE");
    expect(deps.fake.calls).toHaveLength(0);
    expect([...(await testSql()`SELECT id FROM ai_calls`)]).toEqual([]);
  });

  test("an unreadable AI reply is asked once more; a second one fails the task and Retry runs it again", async () => {
    await saveKey();
    deps.fake.queue("Sure! Here are the facts:", "still not json");
    const first = await pasteCv("- Mentored 3 junior engineers through code review");
    const failed = splitTask(first.cv);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("could not be read twice");
    expect(deps.fake.calls).toHaveLength(2);
    expect(first.facts).toEqual([]);

    const retried = await json(await call("POST", `/tasks/${failed.id}/retry`, {}), TaskDto, 202);
    await waitForTask(retried.id);
    const after = await json(await call("GET", "/profile"), ProfileDto);
    expect(splitTask(after.cv)).toMatchObject({ id: retried.id, status: "done" });
    expect(texts(after)).toEqual(["Mentored 3 junior engineers through code review"]);
  });

  test("a rejected key fails the split with a message, and nothing is split by rule behind the user's back", async () => {
    await saveKey();
    deps.fake.queue(new AiError({ kind: "rejected_key", message: "Fake: key rejected." }));
    const profile = await pasteCv("- Mentored 3 junior engineers through code review");
    expect(splitTask(profile.cv).status).toBe("failed");
    expect(profile.facts).toEqual([]);
  });

  test("with a cap below the estimate, saving the CV returns 402 over_cap and saves nothing until confirmed", async () => {
    await saveKey();
    // A month already at the cap: any split estimate goes over it.
    await testSql()`INSERT INTO ai_calls (user_id, tier, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (${deps.userId}, 'light', 'split', 'anthropic', 'claude-haiku-5-5', 1, 1, 1.0, '2026-10-16T07:00:00Z')`;
    expect((await call("PATCH", "/settings", { monthlyCapUsd: 1 })).status).toBe(200);
    const refused = await call("PUT", "/profile/cv", { text: "- Mentored 3 junior engineers" });
    expect((await json(refused, ApiErrorBody, 402)).error.code).toBe("over_cap");
    expect([...(await testSql()`SELECT id FROM profile_items`)]).toEqual([]);

    const ok = await settled(
      await call("PUT", "/profile/cv", { text: "- Mentored 3 junior engineers", confirmOverCap: true }),
    );
    expect(texts(ok)).toEqual(["Mentored 3 junior engineers"]);
  });
});

describe("re-import", () => {
  const V1 = [
    "- Built a payments API in Go serving 2M requests a day",
    "- Led a team of 4 engineers at Acme Corp",
    "- Wrote the on-call runbook",
  ].join("\n");

  test("one edited confirmed line: unchanged facts keep id and key, the new line is pending, the old one is not in the latest CV", async () => {
    const first = await pasteCv(V1);
    const confirmed = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(confirmed.facts.every((f) => f.status === "confirmed" && f.inLatest)).toBe(true);
    const payments = fact(first, "payments API");

    const after = await pasteCv(V1.replace("team of 4", "team of 5"));
    expect(after.cv?.rev).toBe(2);
    const again = fact(after, "payments API");
    expect({ id: again.id, key: again.key, status: again.status, inLatest: again.inLatest }).toEqual({
      id: payments.id,
      key: payments.key,
      status: "confirmed",
      inLatest: true,
    });
    expect(fact(after, "team of 5")).toMatchObject({ key: "FACT-4", status: "pending", inLatest: true });
    expect(fact(after, "team of 4")).toMatchObject({ key: "FACT-2", status: "confirmed", inLatest: false });
  });

  test("one edited pending line: the old pending fact is gone and the new line is pending", async () => {
    const first = await pasteCv(V1);
    await call("POST", `/facts/${fact(first, "payments API").id}/confirm`);
    await call("POST", `/facts/${fact(first, "team of 4").id}/confirm`);

    const after = await pasteCv(V1.replace("on-call runbook", "on-call runbook and the incident guide"));
    expect(after.facts.map((f) => [String(f.key), f.status, f.inLatest])).toEqual([
      ["FACT-1", "confirmed", true],
      ["FACT-2", "confirmed", true],
      ["FACT-4", "pending", true],
    ]);
    expect(texts(after)).not.toContain("Wrote the on-call runbook");
  });

  test("Keep brings a vanished fact back into the latest CV; Delete removes it", async () => {
    await pasteCv(V1);
    await call("POST", "/facts/confirm-all");
    const after = await pasteCv("- Built a payments API in Go serving 2M requests a day");
    const vanished = after.facts.filter((f) => !f.inLatest);
    expect(vanished.map((f) => f.text)).toEqual([
      "Led a team of 4 engineers at Acme Corp",
      "Wrote the on-call runbook",
    ]);
    const [keep, drop] = vanished;
    if (!keep || !drop) throw new Error("expected two vanished facts");

    const kept = await json(await call("POST", `/facts/${keep.id}/keep`), ProfileDto);
    expect(fact(kept, "team of 4")).toMatchObject({ status: "confirmed", inLatest: true });
    const deleted = await json(await call("DELETE", `/facts/${drop.id}`), ProfileDto);
    expect(texts(deleted)).toEqual([
      "Built a payments API in Go serving 2M requests a day",
      "Led a team of 4 engineers at Acme Corp",
    ]);

    // A kept fact counts as seen at that rev, so the next identical import leaves it in place.
    const again = await pasteCv("- Built a payments API in Go serving 2M requests a day");
    expect(fact(again, "team of 4").inLatest).toBe(false);
  });

  test("a vanished confirmed fact that is cited keeps its citation; the re-import does not touch it", async () => {
    await pasteCv(V1);
    const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    const team = fact(profile, "team of 4");
    await pasteCv("- Built a payments API in Go serving 2M requests a day");
    const [row] = await testSql()<{ status: string }[]>`SELECT status FROM facts WHERE id = ${team.id}`;
    expect(row?.status).toBe("confirmed");
  });
});

describe("fact sections: grouping by job", () => {
  const CV = [
    "EXPERIENCE",
    "Acme Corp — Senior Engineer, 2019 to 2023",
    "- Built a payments API in Go serving 2M requests a day",
    "- Led a team of 4 engineers",
  ].join("\n");
  const reply = (...facts: { text: string; section: string | null }[]) => JSON.stringify({ facts });

  test("the AI's section is saved when the CV has it; an invented one is dropped and the fact stays", async () => {
    await saveKey();
    deps.fake.queue(
      reply(
        { text: "Built a payments API in Go serving 2M requests a day", section: "Acme Corp" },
        { text: "Led a team of 4 engineers", section: "Globex" },
      ),
    );
    const profile = await pasteCv(CV);
    expect(profile.facts.map((f) => [f.text, f.section])).toEqual([
      ["Built a payments API in Go serving 2M requests a day", "Acme Corp"],
      ["Led a team of 4 engineers", null],
    ]);
  });

  test("splitting again sends the saved facts, keeps their confirmation and fills in their section", async () => {
    await saveKey();
    // Facts split before sections existed: no section.
    deps.fake.queue(splitReply("Built a payments API in Go serving 2M requests a day", "Led a team of 4 engineers"));
    await pasteCv(CV);
    const before = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(before.facts.map((f) => f.section)).toEqual([null, null]);

    deps.fake.queue(
      reply(
        { text: "Built a payments API in Go serving 2M requests a day", section: "Acme Corp" },
        { text: "Led a team of 4 engineers", section: "Acme Corp" },
      ),
    );
    const after = await pasteCv(CV);
    // Calls: split, roles, then the second split.
    const prompt = deps.fake.calls[2]?.messages[0]?.content ?? "";
    expect(prompt).toContain("SAVED FACTS");
    expect(prompt).toContain("- Led a team of 4 engineers");
    expect(after.facts.map((f) => ({ id: f.id, status: f.status, section: f.section }))).toEqual(
      before.facts.map((f) => ({ id: f.id, status: "confirmed", section: "Acme Corp" })),
    );
  });

  test("without AI, the rule splitter groups bullets under the line above them", async () => {
    const profile = await pasteCv(CV);
    expect(fact(profile, "payments API").section).toBe("Acme Corp — Senior Engineer, 2019 to 2023");
  });

  test("re-saving the same CV text keeps the uploaded file's name", async () => {
    await json(
      await upload("cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      ProfileDto,
    );
    const first = await json(await call("GET", "/profile"), ProfileDto);
    expect(first.cv?.fileName).toBe("cv.docx");
    const again = await pasteCv(first.cv?.body ?? "");
    expect(again.cv?.fileName).toBe("cv.docx");
    const edited = await pasteCv(`${first.cv?.body ?? ""}\n- Wrote the on-call runbook`);
    expect(edited.cv?.fileName).toBeNull();
  });
});

describe("add-ons", () => {
  const MENTORING: AddonInput = {
    kind: "other",
    title: "Mentoring at Kodego",
    body: "- Mentored 12 bootcamp students in JavaScript\n- Reviewed their capstone projects",
    happenedOn: "2024-03-01",
    link: "https://kodego.ph",
    skills: ["JavaScript", "Teaching"],
    usage: "letters_only",
  };

  test("saving an add-on stores its fields and splits it into pending facts on its own row", async () => {
    const profile = await addAddon(MENTORING);
    expect(profile.cv).toBeNull();
    expect(profile.addons).toHaveLength(1);
    const [addon] = profile.addons;
    expect(addon).toMatchObject({
      kind: "other",
      title: "Mentoring at Kodego",
      happenedOn: "2024-03-01",
      link: "https://kodego.ph",
      skills: ["JavaScript", "Teaching"],
      usage: "letters_only",
      rev: 1,
      fileName: null,
    });
    expect(splitTask(addon)).toMatchObject({ kind: "split", status: "done" });
    expect(profile.facts.map((f) => [f.text, f.status, f.itemTitle, f.usage])).toEqual([
      ["Mentored 12 bootcamp students in JavaScript", "pending", "Mentoring at Kodego", "letters_only"],
      ["Reviewed their capstone projects", "pending", "Mentoring at Kodego", "letters_only"],
    ]);
  });

  test("the skills field is passed to the AI split as context only; facts still need the text", async () => {
    await saveKey();
    deps.fake.queue(
      splitReply("Mentored 12 bootcamp students in JavaScript", "Taught Teaching to 12 students in React"),
    );
    const profile = await addAddon(MENTORING);
    expect(deps.fake.calls[0]?.messages[0]?.content).toContain(
      "context only; a fact must still come from the text): JavaScript, Teaching",
    );
    expect(texts(profile)).toEqual(["Mentored 12 bootcamp students in JavaScript"]);
  });

  test("a letters_only add-on splits into facts that drafting excludes from resumes and keeps for letters", async () => {
    await call("PUT", "/profile", {
      contact: { fullName: "Juan Dela Cruz", email: "juan@example.ph", phone: "", location: "Manila", links: [] },
    });
    await pasteCv("- Built a payments API in Go serving 2M requests a day");
    await addAddon(MENTORING);
    const profile = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(profile.facts.filter((f) => f.usage === "letters_only").map((f) => f.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);

    await saveKey();
    const added = await json(
      await call("POST", "/jobs/from-paste", { title: "Engineer", company: "Acme", description: "Build APIs." }),
      AddJobResult,
      201,
    );
    const ws = await json(await call("GET", `/opportunities/${added.opportunityId}`), WorkspaceDto);
    const outputId = (kind: string) => ws.files.find((f) => f.kind === kind)?.id;

    for (const kind of ["resume", "letter"] as const) {
      deps.fake.reset();
      const task = await json(
        await call("POST", `/opportunities/${ws.opportunity.id}/draft`, { outputId: outputId(kind) }),
        TaskDto,
        202,
      );
      await waitForTask(task.id);
      const prompt = deps.fake.calls[0]?.messages[0]?.content ?? "";
      if (kind === "resume") expect(prompt).not.toContain("Mentored 12 bootcamp students");
      else expect(prompt).toContain("Mentored 12 bootcamp students");
      expect(prompt).toContain("Built a payments API");
    }
  });

  test("editing an add-on's text re-splits it like a re-import; changing only usage does not", async () => {
    const first = await addAddon(MENTORING);
    const [addon] = first.addons;
    if (!addon) throw new Error("no add-on");
    await call("POST", "/facts/confirm-all");

    const usageOnly = await settled(
      await call("PUT", `/profile/addons/${addon.id}`, { ...MENTORING, usage: "everywhere" }),
    );
    expect(usageOnly.addons[0]).toMatchObject({ rev: 1, usage: "everywhere" });
    expect(usageOnly.facts.every((f) => f.inLatest && f.usage === "everywhere")).toBe(true);

    const edited = await settled(
      await call("PUT", `/profile/addons/${addon.id}`, {
        ...MENTORING,
        body: "- Mentored 12 bootcamp students in JavaScript\n- Ran weekly code reviews",
      }),
    );
    expect(edited.addons[0]?.rev).toBe(2);
    expect(edited.facts.map((f) => [f.text, f.status, f.inLatest])).toEqual([
      ["Mentored 12 bootcamp students in JavaScript", "confirmed", true],
      ["Reviewed their capstone projects", "confirmed", false],
      ["Ran weekly code reviews", "pending", true],
    ]);
  });

  test("deleting an add-on deletes its facts; the CV cannot be deleted through the add-on route", async () => {
    const withCv = await pasteCv("- Built a payments API in Go serving 2M requests a day");
    const profile = await addAddon(MENTORING);
    const [addon] = profile.addons;
    if (!addon || !withCv.cv) throw new Error("missing item");
    const after = await json(await call("DELETE", `/profile/addons/${addon.id}`), ProfileDto);
    expect(after.addons).toEqual([]);
    expect(texts(after)).toEqual(["Built a payments API in Go serving 2M requests a day"]);
    const res = await call("DELETE", `/profile/addons/${withCv.cv.id}`);
    expect((await json(res, ApiErrorBody, 404)).error.code).toBe("not_found");
  });

  test("bad add-on input returns 400: a cv kind, a blank title, a non-http link", async () => {
    for (const bad of [
      { ...MENTORING, kind: "cv" },
      { ...MENTORING, title: "  " },
      { ...MENTORING, link: "javascript:alert(1)" },
      { ...MENTORING, happenedOn: "March 2024" },
    ]) {
      const res = await call("POST", "/profile/addons", bad);
      expect((await json(res, ApiErrorBody, 400)).error.code).toBe("invalid_input");
    }
  });
});

describe("review and skills found", () => {
  test("Confirm, Edit, Discard and Confirm all on pending facts", async () => {
    const profile = await pasteCv("- Built a payments API in Go\n- Led a team of 4\n- Wrote docs\n- Ran demos");
    const [a, b, c] = profile.facts;
    if (!a || !b || !c) throw new Error("expected facts");
    await call("POST", `/facts/${a.id}/confirm`);
    await call("PATCH", `/facts/${b.id}`, { text: "Led a team of 4 engineers" });
    await call("DELETE", `/facts/${c.id}`);
    const before = await json(await call("GET", "/profile"), ProfileDto);
    expect(before.facts.map((f) => [f.text, f.status])).toEqual([
      ["Built a payments API in Go", "confirmed"],
      ["Led a team of 4 engineers", "pending"],
      ["Ran demos", "pending"],
    ]);
    const after = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    expect(after.facts.every((f) => f.status === "confirmed")).toBe(true);
  });

  test("skills found come from confirmed fact text only", async () => {
    const profile = await pasteCv("- Built a payments API in Go and Postgres\n- Wrote React dashboards");
    expect(profile.skillsFound).toEqual([]);
    await call("POST", `/facts/${fact(profile, "payments API").id}/confirm`);
    const after = await json(await call("GET", "/profile"), ProfileDto);
    expect(after.skillsFound).toEqual(["Go", "PostgreSQL"]);
    // An add-on's skills field does not count until a confirmed fact names the skill.
    await addAddon({ kind: "open_source", title: "dotfiles", body: "- Maintain my dotfiles", skills: ["Rust"] });
    const withAddon = await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    // Dictionary order and canonical names: the same list Matches scores against.
    expect(withAddon.skillsFound).toEqual(["Go", "React", "PostgreSQL"]);
  });
});

describe("skills used for matching (decision 66)", () => {
  const setSkill = (name: string, state: "added" | "hidden" | "none") =>
    call("PUT", "/profile/skills", { name, state });

  test("add, hide, restore and remove; chips name where each skill comes from", async () => {
    const profile = await pasteCv("- Built a payments API in Go and Postgres");
    await call("POST", `/facts/${fact(profile, "payments API").id}/confirm`);
    expect((await json(await setSkill("  hasura ", "added"), ProfileDto)).skillChips).toEqual([
      { name: "Go", source: "facts", builtin: true },
      { name: "PostgreSQL", source: "facts", builtin: true },
      { name: "hasura", source: "added", builtin: false },
    ]);
    // A built-in spelling becomes its name; a skill found in facts and added shows as found.
    await json(await setSkill("golang", "added"), ProfileDto);
    const added = await json(await setSkill("python", "added"), ProfileDto);
    expect(added.skillChips.map((c) => [c.name, c.source])).toEqual([
      ["Python", "added"],
      ["Go", "facts"],
      ["PostgreSQL", "facts"],
      ["hasura", "added"],
    ]);
    const hidden = await json(await setSkill("Postgres", "hidden"), ProfileDto);
    expect(hidden.skillChips.map((c) => [c.name, c.source])).toEqual([
      ["Python", "added"],
      ["Go", "facts"],
      ["hasura", "added"],
      ["PostgreSQL", "hidden"],
    ]);
    // skillsFound keeps its meaning: skills named in confirmed facts.
    expect(hidden.skillsFound).toEqual(["Go", "PostgreSQL"]);
    const restored = await json(await setSkill("PostgreSQL", "none"), ProfileDto);
    expect(restored.skillChips.map((c) => c.source)).toEqual(["added", "facts", "facts", "added"]);
    const removed = await json(await setSkill("HASURA", "none"), ProfileDto);
    expect(removed.skillChips.map((c) => c.name)).toEqual(["Python", "Go", "PostgreSQL"]);
    expect(removed.skillCatalog).toContain("TypeScript");
  });

  test("hiding a skill no confirmed fact names is a 409", async () => {
    await pasteCv("- Built a payments API in Go");
    const res = await setSkill("Go", "hidden");
    expect((await json(res, ApiErrorBody, 409)).error.code).toBe("not_in_facts");
  });

  test("a bad name is a 400; the 101st added skill is a 409", async () => {
    for (const name of ["", "--", "x".repeat(61)]) {
      expect((await json(await setSkill(name, "added"), ApiErrorBody, 400)).error.code).toBe("invalid_input");
    }
    await testSql()`
      INSERT INTO user_skills (user_id, key, name, kind, created_at)
      SELECT ${deps.userId}, 'skill ' || n, 'Skill ' || n, 'added', now() + n * interval '1 second'
      FROM generate_series(1, 100) n`;
    expect((await json(await setSkill("Hasura", "added"), ApiErrorBody, 409)).error.code).toBe("too_many_skills");
    // Adding one already added is not a new skill.
    await json(await setSkill("Skill 7", "added"), ProfileDto);
  });
});

describe("seniority, years and minimum pay (section 4, Profile)", () => {
  test("save through targeting, read back, keep when not sent, clear with null", async () => {
    const saved = await json(
      await call("PUT", "/profile", {
        targeting: {
          seniority: "senior",
          yearsExperience: 7,
          minPay: { amount: 150000, currency: "php", period: "month" },
        },
      }),
      ProfileDto,
    );
    expect(saved.targeting).toMatchObject({
      seniority: "senior",
      yearsExperience: 7,
      minPay: { amount: 150000, currency: "PHP", period: "month" },
    });
    const read = await json(await call("GET", "/profile"), ProfileDto);
    expect(read.targeting).toEqual(saved.targeting);

    // Saving other targeting keeps the three fields.
    const kept = await json(await call("PUT", "/profile", { targeting: { targetTitles: ["Backend"] } }), ProfileDto);
    expect(kept.targeting).toMatchObject({ seniority: "senior", yearsExperience: 7 });

    const cleared = await json(
      await call("PUT", "/profile", { targeting: { seniority: null, yearsExperience: null, minPay: null } }),
      ProfileDto,
    );
    expect(cleared.targeting).toMatchObject({ seniority: null, yearsExperience: null, minPay: null });
  });

  test("years over 60, an unknown seniority or a bad pay is a 400 and saves nothing", async () => {
    const tooMany = await json(
      await call("PUT", "/profile", { targeting: { yearsExperience: 61 } }),
      ApiErrorBody,
      400,
    );
    expect(tooMany.error.code).toBe("invalid_input");
    expect(JSON.stringify(tooMany.error.details)).toContain("Years of experience is at most 60.");
    for (const targeting of [
      { yearsExperience: -1 },
      { yearsExperience: 2.5 },
      { seniority: "manager" },
      { minPay: { amount: 0, currency: "PHP", period: "month" } },
      { minPay: { amount: 100, currency: "PESO", period: "month" } },
      { minPay: { amount: 100, currency: "PHP", period: "fortnight" } },
    ]) {
      expect((await call("PUT", "/profile", { targeting })).status).toBe(400);
    }
    const read = await json(await call("GET", "/profile"), ProfileDto);
    expect(read.targeting).toMatchObject({ seniority: null, yearsExperience: null, minPay: null });
  });
});
