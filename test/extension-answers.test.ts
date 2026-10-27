import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  aiCalls,
  answerReferences,
  applicationSessions,
  extensionPairings,
  jobs,
  opportunities,
  outputFacts,
  outputs,
  users,
} from "@/server/db/schema";
import type { Deps } from "@/server/services/context";
import {
  createSessionQuestion,
  saveSessionAnswerReference,
  sessionQuestionAnswers,
} from "@/server/services/extension-answers";
import { FactKey, type OpportunityId } from "@/shared/api";
import { type ApplicationSessionId, FieldDescriptor, type PairingId } from "@/shared/extension";
import { AnswerReferenceDto, QuestionLookupResult } from "@/shared/extension-answers";
import { resetDb, testDeps } from "./setup";

const NOW = new Date("2026-10-16T08:00:00Z");
const QUESTION = "Why do you want to join Acme?";
let deps: Awaited<ReturnType<typeof testDeps>>;
let now: Date;

beforeEach(async () => {
  await resetDb();
  now = NOW;
  deps = await testDeps({ clock: { now: () => now } });
});

function field(label = QUESTION, over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return FieldDescriptor.parse({
    fieldId: "question-1",
    label,
    name: null,
    control: "textarea",
    autocomplete: null,
    required: true,
    options: [],
    adapterCategory: null,
    ...over,
  });
}

async function opportunity({ company = "Acme", owner = deps }: { company?: string; owner?: Deps } = {}) {
  const [job] = await owner.db
    .insert(jobs)
    .values({
      userId: owner.userId,
      origin: "paste",
      title: "Engineer",
      company,
      titleKey: "engineer",
      companyKey: company.toLowerCase(),
      applyUrl: "https://jobs.example/apply",
      description: "Build things.",
      contentHash: crypto.randomUUID(),
      descriptionKey: crypto.randomUUID(),
    })
    .returning();
  if (!job) throw new Error("no job");
  const [opp] = await owner.db
    .insert(opportunities)
    .values({ userId: owner.userId, jobId: job.id, status: "saved", statusChangedAt: NOW })
    .returning();
  if (!opp) throw new Error("no opportunity");
  return opp.id;
}

async function pairing(owner: Deps = deps): Promise<PairingId> {
  const [row] = await owner.db
    .insert(extensionPairings)
    .values({ userId: owner.userId, codeHash: crypto.randomUUID(), codeExpiresAt: new Date(NOW.getTime() + 60_000) })
    .returning();
  if (!row) throw new Error("no pairing");
  return row.id;
}

async function session({
  opportunityId,
  claimed = true,
  owner = deps,
}: {
  opportunityId?: OpportunityId;
  claimed?: boolean;
  owner?: Deps;
} = {}): Promise<{
  sessionId: ApplicationSessionId;
  pairingId: PairingId;
  opportunityId: OpportunityId;
}> {
  const opp = opportunityId ?? (await opportunity({ owner }));
  const pairingId = await pairing(owner);
  await owner.db
    .update(applicationSessions)
    .set({ status: "expired" })
    .where(eq(applicationSessions.userId, owner.userId));
  const [row] = await owner.db
    .insert(applicationSessions)
    .values({
      userId: owner.userId,
      opportunityId: opp,
      applyUrl: "https://jobs.example/apply",
      applyUrlKey: "https://jobs.example/apply",
      status: claimed ? "claimed" : "pending",
      claimedByPairingId: claimed ? pairingId : null,
      claimedAt: claimed ? NOW : null,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    .returning();
  if (!row) throw new Error("no session");
  return { sessionId: row.id, pairingId, opportunityId: opp };
}

async function answerRows(opportunityId: OpportunityId) {
  return deps.db
    .select()
    .from(outputs)
    .where(and(eq(outputs.opportunityId, opportunityId), eq(outputs.kind, "answer")));
}

describe("extension questions", () => {
  test("creates an included draft target, reuses exact normalized questions, and preserves company names", async () => {
    const ref = await session();
    const first = await createSessionQuestion(deps, { ...ref, input: { field: field() } });
    expect(first).toMatchObject({
      kind: "answer",
      included: true,
      question: QUESTION,
      mustAnswer: null,
      outdated: false,
    });
    const repeated = await createSessionQuestion(deps, {
      ...ref,
      input: { field: field("  ＷＨＹ  do you want to JOIN Acme?  ") },
    });
    expect(repeated.id).toBe(first.id);
    const other = await createSessionQuestion(deps, {
      ...ref,
      input: { field: field("Why do you want to join Beta?") },
    });
    expect(other.id).not.toBe(first.id);
    expect(await answerRows(ref.opportunityId)).toHaveLength(2);
    expect(deps.fake.calls).toHaveLength(0);
  });

  test("concurrent equivalent questions insert only once", async () => {
    const ref = await session();
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createSessionQuestion(deps, { ...ref, input: { field: field(index % 2 ? QUESTION.toUpperCase() : QUESTION) } }),
      ),
    );
    expect(new Set(created.map((output) => output.id)).size).toBe(1);
    expect(await answerRows(ref.opportunityId)).toHaveLength(1);
  });

  test("rejects pay, visa, sensitive fields, factual details, and every must-answer classification", async () => {
    const ref = await session();
    for (const label of [
      "What are your salary expectations?",
      "What compensation do you expect?",
      "Do you need visa sponsorship?",
      "What is your medical history?",
      "What is your gender?",
      "What is your notice period?",
      "When can you start?",
      "Who are your references?",
      "What is your current employer?",
      "What is your earliest start?",
    ]) {
      await expect(createSessionQuestion(deps, { ...ref, input: { field: field(label) } })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    for (const over of [{ control: "select" }, { name: "visa sponsorship" }, { adapterCategory: "given_name" }]) {
      await expect(
        createSessionQuestion(deps, {
          ...ref,
          input: { field: field(QUESTION, FieldDescriptor.parse({ ...field(), ...over })) },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await answerRows(ref.opportunityId)).toHaveLength(0);
  });

  test("does not create or reuse questions in a frozen job", async () => {
    const ref = await session();
    await createSessionQuestion(deps, { ...ref, input: { field: field() } });
    await deps.db.update(opportunities).set({ status: "applied" }).where(eq(opportunities.id, ref.opportunityId));
    for (const label of [QUESTION, "Describe your proudest project"])
      await expect(createSessionQuestion(deps, { ...ref, input: { field: field(label) } })).rejects.toMatchObject({
        code: "frozen",
      });
    expect(await answerRows(ref.opportunityId)).toHaveLength(1);
  });
});

describe("extension answer lookup and explicit saves", () => {
  test("returns plain current-job answers, preserving blanks and outdated state without citations or mutation", async () => {
    const ref = await session();
    const output = await createSessionQuestion(deps, { ...ref, input: { field: field() } });
    await deps.db
      .update(outputs)
      .set({ body: "## My answer\nI **built** [[project name]] [FACT-1].", generatedAt: NOW })
      .where(eq(outputs.id, output.id));
    await deps.db.insert(outputFacts).values({
      outputId: output.id,
      userId: deps.userId,
      factKey: FactKey.parse("FACT-1"),
      factId: null,
      factText: "A fact that was removed.",
    });
    const before = await answerRows(ref.opportunityId);
    const input = {
      fields: [
        field("WHY  do you want to join ACME?"),
        field("Why do you want to join Beta?", { fieldId: field().fieldId }),
      ],
    };
    const lookedUp = QuestionLookupResult.parse(await sessionQuestionAnswers(deps, { ...ref, input }));
    expect(lookedUp.questions[0]?.answer).toEqual({
      outputId: output.id,
      body: "My answer\nI built [[project name]].",
      outdated: true,
    });
    expect(lookedUp.questions[1]?.answer).toBeNull();
    expect(JSON.stringify(lookedUp)).not.toContain("FACT-");
    expect(await answerRows(ref.opportunityId)).toEqual(before);
    expect(await deps.db.select().from(answerReferences)).toHaveLength(0);
    expect(await deps.db.select().from(aiCalls)).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(0);
    expect(deps.fake.mapCalls).toHaveLength(0);
    expect(deps.fake.tailorCalls).toHaveLength(0);
  });

  test("explicit saves upsert the source question, sanitize markers, and never populate an output", async () => {
    const ref = await session();
    const draft = await createSessionQuestion(deps, { ...ref, input: { field: field() } });
    await deps.db.update(outputs).set({ body: "Do not copy this draft." }).where(eq(outputs.id, draft.id));
    const saved = AnswerReferenceDto.parse(
      await saveSessionAnswerReference(deps, {
        ...ref,
        input: { field: field(), body: "My explicit [[detail]] [FACT-42]." },
      }),
    );
    expect(saved).toMatchObject({ question: QUESTION, company: "Acme", body: "My explicit [[detail]]." });
    now = new Date(NOW.getTime() + 1000);
    const updated = await saveSessionAnswerReference(deps, {
      ...ref,
      input: { field: field("WHY  do you want to join Acme?"), body: "The edited field text." },
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.body).toBe("The edited field text.");
    expect(updated.updatedAt).toBe(now.toISOString());
    expect(await deps.db.select().from(answerReferences)).toHaveLength(1);
    const after = await answerRows(ref.opportunityId);
    expect(after).toHaveLength(1);
    expect(after[0]?.body).toBe("Do not copy this draft.");
    expect(deps.fake.calls).toHaveLength(0);
    expect(deps.fake.mapCalls).toHaveLength(0);
    expect(deps.fake.tailorCalls).toHaveLength(0);
    expect(await deps.db.select().from(aiCalls)).toHaveLength(0);
  });

  test("concurrent explicit saves upsert without duplicate references", async () => {
    const ref = await session();
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveSessionAnswerReference(deps, { ...ref, input: { field: field(), body: `Explicit answer ${index}` } }),
      ),
    );
    expect(new Set(saved.map((row) => row.id)).size).toBe(1);
    expect(await deps.db.select().from(answerReferences)).toHaveLength(1);
    expect(await answerRows(ref.opportunityId)).toHaveLength(0);
  });

  test("matches references exactly and returns only the three latest with each source company", async () => {
    for (let index = 0; index < 4; index++) {
      const opportunityId = await opportunity({ company: `Source ${index}` });
      const ref = await session({ opportunityId });
      now = new Date(NOW.getTime() + index * 1000);
      await saveSessionAnswerReference(deps, { ...ref, input: { field: field(), body: `Source answer ${index}` } });
    }
    const different = await session();
    await saveSessionAnswerReference(deps, {
      ...different,
      input: { field: field("Why do you want to join Beta?"), body: "Only for Beta." },
    });
    const current = await session();
    const result = await sessionQuestionAnswers(deps, {
      ...current,
      input: {
        fields: [field("  ＷＨＹ do you want to join ACME? "), field("Why do you want to join a company?")],
      },
    });
    expect(result.questions[0]?.answer).toBeNull();
    expect(result.questions[0]?.references.map((row) => [row.company, row.body])).toEqual([
      ["Source 3", "Source answer 3"],
      ["Source 2", "Source answer 2"],
      ["Source 1", "Source answer 1"],
    ]);
    expect(result.questions[1]?.references).toEqual([]);
    expect(await answerRows(current.opportunityId)).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(0);
  });

  test("caps references per question without starving another matching question", async () => {
    const labels = [QUESTION, "Describe a project you are proud of."];
    for (let index = 0; index < 4; index++) {
      const ref = await session({ opportunityId: await opportunity({ company: `Source ${index}` }) });
      now = new Date(NOW.getTime() + index * 1000);
      for (const label of labels) {
        await saveSessionAnswerReference(deps, {
          ...ref,
          input: { field: field(label), body: `${label} Answer ${index}` },
        });
      }
    }
    const ref = await session();
    const result = await sessionQuestionAnswers(deps, {
      ...ref,
      input: { fields: labels.map((label) => field(label)) },
    });
    expect(result.questions).toHaveLength(2);
    for (const [index, question] of result.questions.entries()) {
      expect(question.references.map((row) => row.body)).toEqual(
        [3, 2, 1].map((source) => `${labels[index]} Answer ${source}`),
      );
      expect(question.references.map((row) => row.company)).toEqual(["Source 3", "Source 2", "Source 1"]);
    }
  });

  test("looks up 200 distinct field keys without creating answers", async () => {
    const ref = await session();
    const fields = Array.from({ length: 200 }, (_, index) => field(`Describe project number ${index}.`));
    const result = QuestionLookupResult.parse(await sessionQuestionAnswers(deps, { ...ref, input: { fields } }));
    expect(result.questions).toHaveLength(200);
    expect(result.questions.every((question) => question.answer === null && question.references.length === 0)).toBe(
      true,
    );
    expect(await answerRows(ref.opportunityId)).toHaveLength(0);
  });

  test("isolates users, rejects foreign sessions, and scopes joins and current-job answers", async () => {
    const [user] = await deps.db.insert(users).values({}).returning();
    if (!user) throw new Error("no second user");
    try {
      const other: Deps = { ...deps, userId: user.id };
      const foreign = await session({ owner: other });
      await saveSessionAnswerReference(other, {
        ...foreign,
        input: { field: field(), body: "Other user's private answer." },
      });
      const own = await session();
      // Deliberately inconsistent ownership proves each join is scoped, not just the reference row.
      await deps.db.insert(answerReferences).values({
        userId: deps.userId,
        opportunityId: foreign.opportunityId,
        questionKey: "why do you want to join acme?",
        question: QUESTION,
        body: "Foreign source job.",
      });
      await deps.db.insert(outputs).values({
        userId: user.id,
        opportunityId: own.opportunityId,
        kind: "answer",
        question: QUESTION,
        body: "Foreign answer in our opportunity.",
      });
      const result = await sessionQuestionAnswers(deps, { ...own, input: { fields: [field()] } });
      expect(result.questions[0]?.references).toEqual([]);
      expect(result.questions[0]?.answer).toBeNull();
      const created = await createSessionQuestion(deps, { ...own, input: { field: field() } });
      const [row] = await deps.db.select().from(outputs).where(eq(outputs.id, created.id));
      expect(row?.userId).toBe(deps.userId);
      for (const run of sessionOperations()) await expect(run(foreign)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await deps.db.delete(users).where(eq(users.id, user.id));
    }
  });

  test("validates all inputs at the service boundary", async () => {
    const ref = await session();
    await expect(
      sessionQuestionAnswers(deps, { ...ref, input: { fields: [field("What is your salary expectation?")] } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const body of ["", "   ", "[FACT-1]", "x".repeat(10_001)]) {
      await expect(saveSessionAnswerReference(deps, { ...ref, input: { field: field(), body } })).rejects.toMatchObject(
        {
          code: "invalid_input",
        },
      );
    }
    await expect(
      saveSessionAnswerReference(deps, {
        ...ref,
        input: { field: field("Do you need visa sponsorship?"), body: "yes" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await deps.db.select().from(answerReferences)).toHaveLength(0);
    expect(await answerRows(ref.opportunityId)).toHaveLength(0);
  });

  test("expires at exactly the current clock time for lookup, create, and save", async () => {
    const ref = await session();
    now = new Date(NOW.getTime() + 60_000);
    for (const run of sessionOperations()) await expect(run(ref)).rejects.toMatchObject({ code: "session_expired" });
    expect(await answerRows(ref.opportunityId)).toHaveLength(0);
    expect(await deps.db.select().from(answerReferences)).toHaveLength(0);
  });

  test("unclaimed, wrong-pairing, and expired sessions deny lookup, create, and save", async () => {
    const unclaimed = await session({ claimed: false });
    for (const run of sessionOperations())
      await expect(run(unclaimed)).rejects.toMatchObject({ code: "session_expired" });
    const claimed = await session();
    const wrongPairing = { ...claimed, pairingId: await pairing() };
    for (const run of sessionOperations()) await expect(run(wrongPairing)).rejects.toMatchObject({ code: "not_found" });
    now = new Date(NOW.getTime() + 60_001);
    for (const run of sessionOperations())
      await expect(run(claimed)).rejects.toMatchObject({ code: "session_expired" });
    expect(await answerRows(claimed.opportunityId)).toHaveLength(0);
    expect(await deps.db.select().from(answerReferences)).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(0);
  });
});

type SessionRef = { sessionId: ApplicationSessionId; pairingId: PairingId };
function sessionOperations(): Array<(ref: SessionRef) => Promise<unknown>> {
  return [
    (ref) => sessionQuestionAnswers(deps, { ...ref, input: { fields: [field()] } }),
    (ref) => createSessionQuestion(deps, { ...ref, input: { field: field() } }),
    (ref) => saveSessionAnswerReference(deps, { ...ref, input: { field: field(), body: "An explicit answer." } }),
  ];
}
