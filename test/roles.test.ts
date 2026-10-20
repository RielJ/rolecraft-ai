import { beforeEach, describe, expect, test } from "bun:test";
import type { FakeAi } from "@/server/adapters/ai/fake";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { waitForTask } from "@/server/services/tasks";
import { ApiErrorBody, ProfileDto, type ProfileItemDto, type RoleDto, TaskDto } from "@/shared/api";
import { COMMA_CV, PAREN_CV, PAREN_ROLES } from "./fixtures/roles-cv";
import { resetDb, testDeps, testSql, waitForSplits } from "./setup";

/* Roles (decision 71, docs/plans/roles.md): read in the split, linked by section, read again, saved. */

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

async function settled(res: Response, status = 200): Promise<ProfileDto> {
  const profile = await json(res, ProfileDto, status);
  await waitForSplits(profile);
  for (const item of [profile.cv, ...profile.addons]) {
    if (item?.rolesTask?.status === "running") await waitForTask(item.rolesTask.id);
  }
  return json(await call("GET", "/profile"), ProfileDto);
}

const pasteCv = async (text: string) => settled(await call("PUT", "/profile/cv", { text }));

async function saveKey() {
  const res = await call("PUT", "/settings/ai-key", { provider: "anthropic", key: "sk-ant-good-key-a1B2" });
  expect(res.status).toBe(200);
}

function cvOf(profile: ProfileDto): ProfileItemDto {
  if (!profile.cv) throw new Error("no CV");
  return profile.cv;
}

const fields = (roles: readonly RoleDto[]) =>
  roles.map(({ title, company, location, start, end }) => ({ title, company, location, start, end }));

/** Each fact's text with the company of the role it links to. */
function links(profile: ProfileDto): Record<string, string | null> {
  const byId = new Map(cvOf(profile).roles.map((r) => [r.id, r.company]));
  return Object.fromEntries(profile.facts.map((f) => [f.text, f.roleId ? (byId.get(f.roleId) ?? "?") : null]));
}

async function splitResult(): Promise<unknown> {
  const [row] = await testSql()`SELECT result FROM tasks WHERE kind = 'split' ORDER BY created_at DESC LIMIT 1`;
  return row?.result;
}

const asSaved = (roles: readonly RoleDto[]) =>
  roles.map(({ id, title, company, location, start, end }) => ({ id, title, company, location, start, end }));

describe("roles in the split task", () => {
  test("a CV split reads its roles with every field, and facts link to the role their section names", async () => {
    await saveKey();
    const profile = await pasteCv(PAREN_CV);
    const cv = cvOf(profile);
    expect(fields(cv.roles)).toEqual(PAREN_ROLES);
    expect(links(profile)).toEqual({
      "Built a billing service in TypeScript and Postgres for 40 clinics.": "Lakbay Labs",
      "Cut invoice processing time from 40 minutes to 6 minutes by batching queries.": "Lakbay Labs",
      "Migrated the API from Express to Hono on Cloudflare Workers.": "Tala.video",
      "Mentored 3 junior engineers through code review.": "Sinag Inc.",
      "B.S.": null,
      "Computer Engineering (2022)": null,
    });
    expect(cv.roles.map((r) => r.factCount)).toEqual([2, 1, 1]);
    expect(await splitResult()).toMatchObject({ roles: { kind: "read", count: 3 } });
    const calls = await testSql()`SELECT purpose, tier FROM ai_calls ORDER BY created_at, purpose DESC`;
    expect([...calls]).toEqual([
      { purpose: "split", tier: "light" },
      { purpose: "roles", tier: "light" },
    ]);
  });

  test("checkRoles keeps only fields in the text: an invented role goes, a reworded date is dropped", async () => {
    await saveKey();
    const [first, second] = PAREN_ROLES;
    if (!first || !second) throw new Error("fixture has no roles");
    deps.fake.queue(
      JSON.stringify({ facts: [{ text: "Built a billing service in TypeScript and Postgres for 40 clinics." }] }),
      JSON.stringify({
        roles: [
          { ...first, start: "January 2026" },
          { ...second, location: "Makati" },
          { title: "Staff Engineer", company: "Google", location: null, start: "2019", end: "2021" },
        ],
      }),
    );
    const cv = cvOf(await pasteCv(PAREN_CV));
    expect(fields(cv.roles)).toEqual([
      { ...first, start: null },
      { ...second, location: null },
    ]);
  });

  test("a split fact that is only a role's header is not kept: the role holds it", async () => {
    await saveKey();
    const built = "Built a billing service in TypeScript and Postgres for 40 clinics.";
    // Models do this on real CVs (one per role); the roles reply is the default careful read.
    deps.fake.queue(
      JSON.stringify({
        facts: [
          { text: "Full-stack Software Engineer, Jan, 2026 – Jun, 2026", section: "Lakbay Labs" },
          { text: "Backend Engineer at Tala.video (Remote, Part-time)", section: "Tala.video" },
          { text: built, section: "Lakbay Labs" },
        ],
      }),
    );
    const profile = await pasteCv(PAREN_CV);
    expect(links(profile)).toEqual({ [built]: "Lakbay Labs" });
    // Not a dropped claim either: nothing was wrong with it, it was just a header.
    expect(await splitResult()).toMatchObject({ dropped: [] });
  });

  test("when the roles read fails, the saved roles still keep headers out", async () => {
    await saveKey();
    await pasteCv(PAREN_CV);
    deps.fake.queue(
      JSON.stringify({
        facts: [{ text: "Backend Engineer, Oct, 2025 – Apr, 2026" }, { text: "Led the 2026 rewrite." }],
      }),
      "nope",
      "nope again",
    );
    const profile = await pasteCv(`${PAREN_CV}\nLed the 2026 rewrite.`);
    expect(profile.facts.map((f) => f.text)).toContain("Led the 2026 rewrite.");
    expect(profile.facts.map((f) => f.text)).not.toContain("Backend Engineer, Oct, 2025 – Apr, 2026");
    expect(await splitResult()).toMatchObject({ roles: { kind: "failed" } });
  });

  test("a section matching two roles' company links to neither", async () => {
    await saveKey();
    const profile = await pasteCv(COMMA_CV);
    expect(cvOf(profile).roles.map((r) => r.company)).toEqual(["BANWA", "BANWA", "HALO DIGITAL"]);
    expect(links(profile)).toEqual({
      "Payments and reporting for small shops.": null,
      "Built a payments API in Go serving 2M requests a day.": null,
      "Led a team of 4 engineers.": null,
      "Moved the reporting jobs to Postgres.": null,
      "Rebuilt the storefront in React.": "HALO DIGITAL",
    });
  });

  test("a roles reply unreadable twice keeps the facts and says the roles read failed", async () => {
    await saveKey();
    deps.fake.queue(
      JSON.stringify({ facts: [{ text: "Migrated the API from Express to Hono on Cloudflare Workers." }] }),
      "not json",
      "still not json",
    );
    const profile = await pasteCv(PAREN_CV);
    const cv = cvOf(profile);
    expect(cv.splitTask?.status).toBe("done");
    expect(await splitResult()).toMatchObject({ roles: { kind: "failed", error: expect.stringContaining("twice") } });
    expect(profile.facts.map((f) => f.text)).toEqual(["Migrated the API from Express to Hono on Cloudflare Workers."]);
    expect(cv.roles).toEqual([]);
  });

  test("without AI the split reads no roles, and Read roles asks for an AI key", async () => {
    const profile = await pasteCv(PAREN_CV);
    const cv = cvOf(profile);
    expect(cv.roles).toEqual([]);
    expect(deps.fake.calls).toHaveLength(0);
    const res = await call("POST", `/profile/items/${cv.id}/roles/read`, {});
    expect((await json(res, ApiErrorBody, 409)).error.code).toBe("no_ai_key");
  });

  test("an add-on that is not experience has no roles and cannot read them", async () => {
    await saveKey();
    const profile = await settled(
      await call("POST", "/profile/addons", { kind: "other", title: "Talk", body: PAREN_CV }),
      201,
    );
    const addon = profile.addons[0];
    expect(addon?.roles).toEqual([]);
    expect(deps.fake.calls.map((c) => c.messages[0]?.content.includes('{"roles"'))).toEqual([false]);
    const res = await call("POST", `/profile/items/${addon?.id}/roles/read`, {});
    expect((await json(res, ApiErrorBody, 400)).error.message).toContain("change its kind to Experience");
  });

  test("an experience add-on reads its roles in its split", async () => {
    await saveKey();
    const profile = await settled(
      await call("POST", "/profile/addons", { kind: "experience", title: "Earlier work", body: PAREN_CV }),
      201,
    );
    expect(fields(profile.addons[0]?.roles ?? [])).toEqual(PAREN_ROLES);
  });
});

describe("Read roles from your CV", () => {
  test("an old CV with no roles reads them; facts keep their text and status, and only links change", async () => {
    await saveKey();
    await pasteCv(PAREN_CV);
    await json(await call("POST", "/facts/confirm-all"), ProfileDto);
    // A CV split before roles existed.
    await testSql()`DELETE FROM roles`;
    const before = await json(await call("GET", "/profile"), ProfileDto);
    expect(cvOf(before).roles).toEqual([]);
    expect(before.facts.every((f) => f.roleId === null)).toBe(true);
    const calls = deps.fake.calls.length;

    const after = await settled(await call("POST", `/profile/items/${cvOf(before).id}/roles/read`, {}));
    expect(deps.fake.calls.length).toBe(calls + 1);
    expect(cvOf(after).rolesTask?.status).toBe("done");
    expect(fields(cvOf(after).roles)).toEqual(PAREN_ROLES);
    expect(after.facts.map(({ id, text, status, section }) => ({ id, text, status, section }))).toEqual(
      before.facts.map(({ id, text, status, section }) => ({ id, text, status, section })),
    );
    expect(links(after)["Mentored 3 junior engineers through code review."]).toBe("Sinag Inc.");
  });

  test("reading again replaces the roles and clears the item's links first", async () => {
    await saveKey();
    const profile = await pasteCv(PAREN_CV);
    const cv = cvOf(profile);
    // A link the user's text does not support: the read must not keep it.
    const sinag = cv.roles[2]?.id ?? "";
    await testSql()`UPDATE facts SET role_id = ${sinag} WHERE text LIKE 'B.S.%'`;
    const [first] = PAREN_ROLES;
    if (!first) throw new Error("fixture has no roles");
    deps.fake.queue(JSON.stringify({ roles: [first] }));
    const after = await settled(await call("POST", `/profile/items/${cv.id}/roles/read`, {}));
    expect(fields(cvOf(after).roles)).toEqual([first]);
    expect(cvOf(after).roles[0]?.id).not.toBe(cv.roles[0]?.id);
    expect(Object.values(links(after)).filter((c) => c !== null)).toEqual(["Lakbay Labs", "Lakbay Labs"]);
  });

  test("a failed read is offered again by Retry", async () => {
    await saveKey();
    const cv = cvOf(await pasteCv(PAREN_CV));
    deps.fake.queue("nope", "nope again");
    const failed = cvOf(await settled(await call("POST", `/profile/items/${cv.id}/roles/read`, {})));
    expect(failed.rolesTask?.status).toBe("failed");
    expect(failed.rolesTask?.error).toContain("could not be read twice");
    expect(failed.roles).toHaveLength(3);

    const retry = await json(await call("POST", `/tasks/${failed.rolesTask?.id}/retry`, {}), TaskDto, 202);
    await waitForTask(retry.id);
    const after = cvOf(await json(await call("GET", "/profile"), ProfileDto));
    expect(after.rolesTask?.status).toBe("done");
    expect(fields(after.roles)).toEqual(PAREN_ROLES);
  });
});

describe("Save roles", () => {
  test("edits keep links, a removed role's facts lose theirs, and a new role picks up unlinked facts", async () => {
    await saveKey();
    const profile = await pasteCv(PAREN_CV);
    const [lakbay, tala, sinag] = asSaved(cvOf(profile).roles);
    if (!lakbay || !tala || !sinag) throw new Error("expected three roles");
    const res = await call("PUT", `/profile/items/${cvOf(profile).id}/roles`, {
      roles: [
        { ...lakbay, title: "Senior Full-stack Engineer", location: "  " },
        { ...sinag, id: undefined, company: "Tala.video", title: "Contractor" },
        sinag,
      ],
    });
    const after = await json(res, ProfileDto);
    const roles = cvOf(after).roles;
    const { id: _sinagId, ...sinagFields } = sinag;
    const { id: _lakbayId, ...lakbayFields } = lakbay;
    expect(fields(roles)).toEqual([
      { ...lakbayFields, title: "Senior Full-stack Engineer", location: null },
      { ...sinagFields, company: "Tala.video", title: "Contractor" },
      sinagFields,
    ]);
    expect(roles[0]?.id).toBe(lakbay.id);
    expect(roles[2]?.id).toBe(sinag.id);
    expect(roles.map((r) => r.factCount)).toEqual([2, 1, 1]);
    // The Tala.video fact lost its role with the removed one, then linked to the new role there.
    expect(links(after)["Migrated the API from Express to Hono on Cloudflare Workers."]).toBe("Tala.video");
    expect(after.facts.every((f) => f.status === "pending")).toBe(true);
  });

  test("a blank title or company, or an id from another item, is refused", async () => {
    await saveKey();
    const profile = await pasteCv(PAREN_CV);
    const cv = cvOf(profile);
    const [lakbay] = asSaved(cv.roles);
    const blank = await call("PUT", `/profile/items/${cv.id}/roles`, { roles: [{ ...lakbay, title: " " }] });
    expect((await json(blank, ApiErrorBody, 400)).error.message).toContain("Each role needs a title.");

    const added = await settled(
      await call("POST", "/profile/addons", { kind: "experience", title: "Earlier", body: PAREN_CV }),
      201,
    );
    const foreign = added.addons[0]?.roles[0]?.id;
    const res = await call("PUT", `/profile/items/${cv.id}/roles`, { roles: [{ ...lakbay, id: foreign }] });
    expect((await json(res, ApiErrorBody, 400)).error.message).toContain("changed since the page loaded");
    expect(cvOf(await json(await call("GET", "/profile"), ProfileDto)).roles).toHaveLength(3);
  });
});
