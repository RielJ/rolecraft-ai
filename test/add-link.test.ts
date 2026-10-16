import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createHttpClient, type FetchFn } from "@/server/adapters/http";
import { createApp } from "@/server/http/app";
import type { Deps } from "@/server/services/context";
import { AddJobResult, AddLinkResult, ApiErrorBody, type OpportunityId, WorkspaceDto } from "@/shared/api";
import { resetDb, testDeps, testSql } from "./setup";

// Section 3.2 and the slice 5 acceptance. No test reaches the network: pages come from
// test/fixtures/pages through an injected fetch, and every call is recorded.

const pages = join(import.meta.dir, "fixtures/pages");
const fixture = (name: string) => Bun.file(join(pages, name)).text();

let deps: Deps;
let app: ReturnType<typeof createApp>;
let requests: string[];
let routes: Map<string, () => Promise<Response>>;

const fakeFetch: FetchFn = async (url) => {
  requests.push(url);
  const route = routes.get(url);
  if (!route) return new Response("not found", { status: 404 });
  return route();
};

function serve(url: string, file: string) {
  routes.set(url, async () => new Response(await fixture(file), { headers: { "content-type": "text/html" } }));
}

let globalFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const offline = Object.assign(
  async (): Promise<Response> => {
    throw new Error("the real network was called");
  },
  { preconnect: () => {} },
);

beforeEach(async () => {
  await resetDb();
  requests = [];
  routes = new Map();
  // Belt and braces: the real fetch must never run in these tests.
  globalFetch = spyOn(globalThis, "fetch").mockImplementation(offline);
  deps = await testDeps({
    http: createHttpClient({ fetch: fakeFetch, sleep: async () => {} }),
    clock: { now: () => new Date("2026-07-10T08:00:00Z") },
  });
  app = createApp(deps);
});

afterEach(() => {
  globalFetch.mockRestore();
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

const workspace = (id: OpportunityId) => call("GET", `/opportunities/${id}`).then((r) => json(r, WorkspaceDto));

const JOB_URL = "https://careers.acme.example/jobs/senior-backend-engineer";

describe("add by link", () => {
  test("a JSON-LD page creates a job with title, company, pay and expiry", async () => {
    serve(JOB_URL, "json-ld.html");
    const added = await json(await call("POST", "/jobs/from-link", { url: JOB_URL }), AddLinkResult, 201);
    if (added.kind !== "created") throw new Error(`expected created, got ${added.kind}`);

    const [row] = await testSql()`
      SELECT origin, title, company, pay_min, pay_max, pay_currency, pay_period, expires_at, posted_at,
        eligibility, eligibility_phrase, skills, seniority, min_years, hours, apply_url
      FROM jobs`;
    expect(row).toMatchObject({
      origin: "link",
      title: "Senior Backend Engineer",
      company: "Acme Inc",
      pay_min: "60000.00",
      pay_max: "80000.00",
      pay_currency: "USD",
      pay_period: "year",
      expires_at: new Date("2026-08-31T23:59:59Z"),
      posted_at: new Date("2026-07-01T00:00:00Z"),
      eligibility: "ph",
      eligibility_phrase: "We hire in the Philippines.",
      seniority: "senior",
      min_years: 5,
      hours: { phrase: "9am to 5pm ET", tz: "America/New_York", start: "09:00", end: "17:00" },
      apply_url: JOB_URL,
    });
    expect(row?.skills).toEqual(expect.arrayContaining(["Go", "PostgreSQL", "Kafka", "Docker", "Kubernetes", "AWS"]));
    expect(requests).toEqual([JOB_URL]);

    // The header: verdict and phrase, hours in PH time on the posting's (July, EDT) date, pay as posted.
    const ws = await workspace(added.opportunityId);
    expect(ws.job).toMatchObject({
      eligibility: { verdict: "ph", label: "Open to the Philippines", phrase: "We hire in the Philippines." },
      hours: { phrase: "9am to 5pm ET", manila: "9:00 PM to 5:00 AM PHT" },
      pay: { posted: "$60,000–$80,000 a year", converted: null, missingRate: "USD" },
      expiresAt: "2026-08-31T23:59:59.000Z",
      possibleDuplicates: [],
    });
    expect(ws.files).toHaveLength(3);
  });

  test("$60k–$80k/yr with USD = 57.80 shows the monthly PHP range; a EUR job with no rate shows as posted", async () => {
    await call("PATCH", "/settings", { fxRates: { USD: 57.8 } });
    const usd = await json(
      await call("POST", "/jobs/from-paste", {
        title: "Backend Engineer",
        company: "Acme",
        description: "Build APIs. Salary: $60k–$80k/yr.",
      }),
      AddJobResult,
      201,
    );
    expect((await workspace(usd.opportunityId)).job.pay).toEqual({
      posted: "$60k–$80k/yr",
      converted: "₱289,000–₱385,333 a month",
      missingRate: null,
    });

    const eur = await json(
      await call("POST", "/jobs/from-paste", {
        title: "Backend Engineer",
        company: "Euro GmbH",
        description: "Build APIs. Salary: €50,000 – €60,000 per year.",
      }),
      AddJobResult,
      201,
    );
    expect((await workspace(eur.opportunityId)).job.pay).toEqual({
      posted: "€50,000 – €60,000 per year",
      converted: null,
      missingRate: "EUR",
    });
  });

  test("a thin page returns needs_paste with what it found as prefill", async () => {
    const url = "https://initech.example/careers/data-analyst";
    serve(url, "thin.html");
    const res = await json(await call("POST", "/jobs/from-link", { url }), AddLinkResult);
    expect(res).toEqual({
      kind: "needs_paste",
      url,
      prefill: { title: "Data Analyst", company: "Initech" },
      reason: "too_little_text",
    });
    const [{ count } = { count: -1 }] = await testSql()<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs`;
    expect(count).toBe(0);
  });

  test("a page without JSON-LD is read with Readability", async () => {
    const url = "https://globex.example/careers/frontend";
    serve(url, "readability.html");
    const added = await json(await call("POST", "/jobs/from-link", { url }), AddLinkResult, 201);
    if (added.kind !== "created") throw new Error(`expected created, got ${added.kind}`);
    const ws = await workspace(added.opportunityId);
    expect(ws.job).toMatchObject({ title: "Frontend Developer", company: "Globex" });
    expect(ws.job.eligibility).toEqual({
      verdict: "worldwide",
      label: "Worldwide",
      phrase: "This is a fully remote role and you can work from anywhere.",
    });
    expect(ws.job.pay).toBeNull();
  });

  test("a LinkedIn URL returns needs_paste with blocked_host and makes no request", async () => {
    const url = "https://www.linkedin.com/jobs/view/4012345678/";
    const res = await json(await call("POST", "/jobs/from-link", { url }), AddLinkResult);
    expect(res).toEqual({ kind: "needs_paste", url, prefill: {}, reason: "blocked_host" });
    expect(requests).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test("every blocked host is refused without a request, subdomains included", async () => {
    for (const url of [
      "https://ph.indeed.com/viewjob?jk=abc",
      "https://www.jobstreet.com.ph/job/123",
      "https://www.kalibrr.com/c/acme/jobs/1",
      "https://www.onlinejobs.ph/jobseekers/job/1",
      "https://www.upwork.com/jobs/~01",
      "https://www.glassdoor.com/job-listing/x",
      "https://wellfound.com/jobs/1",
      "https://www.toptal.com/careers/1",
    ]) {
      const res = await json(await call("POST", "/jobs/from-link", { url }), AddLinkResult);
      expect(res).toMatchObject({ kind: "needs_paste", reason: "blocked_host" });
    }
    expect(requests).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test("a site that fails returns needs_paste with fetch_failed", async () => {
    const url = "https://down.example/jobs/1";
    routes.set(url, async () => new Response("", { status: 500 }));
    const res = await json(await call("POST", "/jobs/from-link", { url }), AddLinkResult);
    expect(res).toEqual({ kind: "needs_paste", url, prefill: {}, reason: "fetch_failed" });
    expect(requests).toEqual([url, url, url]);
  });

  test("a private address is never fetched", async () => {
    const res = await json(await call("POST", "/jobs/from-link", { url: "http://127.0.0.1/admin" }), AddLinkResult);
    expect(res).toMatchObject({ kind: "needs_paste", reason: "fetch_failed" });
    expect(requests).toEqual([]);
  });

  test("a link that is not http(s) is refused as invalid input", async () => {
    const err = await json(await call("POST", "/jobs/from-link", { url: "javascript:alert(1)" }), ApiErrorBody, 400);
    expect(err.error.code).toBe("invalid_input");
  });
});

describe("dedup", () => {
  test("the same URL twice returns existing without reading the page again", async () => {
    serve(JOB_URL, "json-ld.html");
    const first = await json(await call("POST", "/jobs/from-link", { url: JOB_URL }), AddLinkResult, 201);
    if (first.kind !== "created") throw new Error(`expected created, got ${first.kind}`);
    const again = await json(
      await call("POST", "/jobs/from-link", { url: `${JOB_URL}/?utm_source=linkedin` }),
      AddLinkResult,
    );
    expect(again).toEqual({ kind: "existing", opportunityId: first.opportunityId });
    expect(requests).toEqual([JOB_URL]);
  });

  test("a URL shared by several jobs is read, then matched on the title", async () => {
    const careers = "https://acme.example/careers";
    for (const title of ["Designer", "Writer"]) {
      await call("POST", "/jobs/from-paste", {
        url: careers,
        title,
        company: "Acme Inc",
        description: `${title} role.`,
      });
    }
    serve(careers, "json-ld.html");
    const res = await json(await call("POST", "/jobs/from-link", { url: careers }), AddLinkResult, 201);
    expect(res.kind).toBe("created");
    expect(requests).toEqual([careers]);
    const again = await json(await call("POST", "/jobs/from-link", { url: careers }), AddLinkResult);
    expect(again.kind).toBe("existing");
  });

  const paste = { title: "Software Engineer", company: "Acme Inc", description: "Build payment APIs in Go." };

  test("the same company, title and description pasted within 28 days returns existing", async () => {
    const first = await json(await call("POST", "/jobs/from-paste", paste), AddJobResult, 201);
    const again = await json(
      await call("POST", "/jobs/from-paste", {
        ...paste,
        company: "ACME, Inc.",
        description: "  Build PAYMENT\n APIs in Go. ",
      }),
      AddJobResult,
    );
    expect(again).toEqual({ kind: "existing", opportunityId: first.opportunityId });
  });

  test("the same posting pasted after 28 days is a new job", async () => {
    await call("POST", "/jobs/from-paste", paste);
    const later = await testDeps({ clock: { now: () => new Date("2026-08-08T08:00:01Z") } });
    const res = await createApp(later).request("/api/jobs/from-paste", {
      method: "POST",
      body: JSON.stringify(paste),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
  });

  test("two Software Engineer postings at one company with different descriptions create two jobs, shown as possible duplicates with a diff", async () => {
    const a = await json(
      await call("POST", "/jobs/from-paste", {
        title: "Software Engineer",
        company: "Acme Inc",
        description: "Join the payments team. You need 5+ years of experience with Go and Kafka. Remote (US only).",
      }),
      AddJobResult,
      201,
    );
    const b = await json(
      await call("POST", "/jobs/from-paste", {
        title: "Software Engineer",
        company: "Acme",
        description:
          "Join the web team. You need 2+ years of experience with React. We hire in the Philippines. $40/hr.",
      }),
      AddJobResult,
      201,
    );
    expect(b.kind).toBe("created");
    expect(b.opportunityId).not.toBe(a.opportunityId);

    const wsA = await workspace(a.opportunityId);
    const wsB = await workspace(b.opportunityId);
    expect(wsA.job.possibleDuplicates).toEqual([
      {
        jobId: wsB.job.id,
        title: "Software Engineer",
        company: "Acme",
        opportunityId: b.opportunityId,
        diff: { job: "Asks for 5+ years, Go, Kafka · Pay not stated", other: "Asks for 2+ years, React · $40/hr" },
      },
    ]);
    expect(wsB.job.possibleDuplicates.map((d) => d.jobId)).toEqual([wsA.job.id]);
  });
});
