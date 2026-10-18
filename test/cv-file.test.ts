import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { FakeAi } from "@/server/adapters/ai/fake";
import * as schema from "@/server/db/schema";
import { createApp } from "@/server/http/app";
import { inlineDisposition } from "@/server/http/disposition";
import type { Deps } from "@/server/services/context";
import { getProfile } from "@/server/services/profile";
import { MAX_STORED_CV_BYTES, ProfileDto } from "@/shared/api";
import { CV_LINES } from "./fixtures/make-fixtures";
import { resetDb, testDeps, testSql, testUrl, waitForSplits } from "./setup";

/*
 * The stored CV file (decision 69): which saves keep, replace or delete it, the profile's view of
 * it, and the route that serves it.
 */

let deps: Deps & { fake: FakeAi };
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  deps = await testDeps();
  app = createApp(deps);
});

const fixtureBytes = async (name: string) =>
  new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", name)).arrayBuffer());

const PDF_TYPE = "application/pdf";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The fixture PDF with spaces after `%%EOF`, so it reads the same but weighs `size` bytes. */
async function paddedPdf(size: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await fixtureBytes("cv.pdf");
  const out = new Uint8Array(size).fill(0x20);
  out.set(base);
  return out;
}

async function json<T>(res: Response, schema: { parse(v: unknown): T }, status = 200): Promise<T> {
  const body: unknown = await res.json();
  expect({ status: res.status, body }).toMatchObject({ status });
  return schema.parse(body);
}

async function settle(res: Response): Promise<ProfileDto> {
  await waitForSplits(await json(res, ProfileDto));
  return json(await app.request("/api/profile"), ProfileDto);
}

async function upload(name: string, type: string, bytes: Uint8Array<ArrayBuffer>): Promise<ProfileDto> {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return settle(await app.request("/api/profile/cv/file", { method: "POST", body: form }));
}

const uploadFixture = async (name: string, type: string) => upload(name, type, await fixtureBytes(name));

const paste = async (text: string) =>
  settle(
    await app.request("/api/profile/cv", {
      method: "PUT",
      body: JSON.stringify({ text }),
      headers: { "Content-Type": "application/json" },
    }),
  );

async function storedFile(): Promise<{ fileName: string; size: number; data: Uint8Array } | null> {
  const rows = await testSql()<{ fileName: string; size: number; data: Uint8Array }[]>`
    SELECT file_name AS "fileName", size, data FROM cv_files`;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

describe("the file's lifecycle in saveCv", () => {
  test("a PDF upload stores the file as uploaded", async () => {
    const bytes = await fixtureBytes("cv.pdf");
    const profile = await uploadFixture("cv.pdf", PDF_TYPE);
    expect(profile.cv?.body).toBe(CV_LINES.join("\n"));
    const file = await storedFile();
    expect(file).toMatchObject({ fileName: "cv.pdf", size: bytes.length });
    expect(Buffer.from(file?.data ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a second PDF upload replaces the first", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const bigger = await paddedPdf(4096);
    await upload("cv-2026.pdf", PDF_TYPE, bigger);
    expect(await storedFile()).toMatchObject({ fileName: "cv-2026.pdf", size: 4096 });
  });

  test("a PDF of exactly 5 MB is kept", async () => {
    await upload("big.pdf", PDF_TYPE, await paddedPdf(MAX_STORED_CV_BYTES));
    expect(await storedFile()).toMatchObject({ fileName: "big.pdf", size: MAX_STORED_CV_BYTES });
  });

  test("a DOCX upload deletes the stored PDF", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const profile = await uploadFixture("cv.docx", DOCX_TYPE);
    expect(profile.cv?.fileName).toBe("cv.docx");
    expect(await storedFile()).toBeNull();
  });

  test("a PDF over 5 MB is still read, but deletes the stored file and is not kept", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const profile = await upload("huge.pdf", PDF_TYPE, await paddedPdf(MAX_STORED_CV_BYTES + 1));
    expect(profile.cv).toMatchObject({ fileName: "huge.pdf", body: CV_LINES.join("\n") });
    expect(await storedFile()).toBeNull();
  });

  test("pasting text that differs from the stored text deletes the file", async () => {
    const first = await uploadFixture("cv.pdf", PDF_TYPE);
    const edited = await paste(`${first.cv?.body ?? ""}\n- Wrote the on-call runbook`);
    expect(edited.cv?.fileName).toBeNull();
    expect(await storedFile()).toBeNull();
  });

  test("saving the same text again keeps the file", async () => {
    const first = await uploadFixture("cv.pdf", PDF_TYPE);
    const again = await paste(first.cv?.body ?? "");
    expect(again.cv?.fileName).toBe("cv.pdf");
    expect(await storedFile()).toMatchObject({ fileName: "cv.pdf" });
  });

  test("an unreadable upload changes nothing, the stored file included", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const form = new FormData();
    form.append("file", new File([await fixtureBytes("cv-scanned.pdf")], "scan.pdf", { type: PDF_TYPE }));
    const res = await app.request("/api/profile/cv/file", { method: "POST", body: form });
    expect(res.status).toBe(422);
    expect(await storedFile()).toMatchObject({ fileName: "cv.pdf" });
  });
});

describe("ProfileDto.cvFile", () => {
  test("null with no CV, and with a pasted CV", async () => {
    expect((await json(await app.request("/api/profile"), ProfileDto)).cvFile).toBeNull();
    expect((await paste(CV_LINES.join("\n"))).cvFile).toBeNull();
  });

  test("a stored PDF shows its name, size and upload time; a DOCX shows none", async () => {
    const bytes = await fixtureBytes("cv.pdf");
    const profile = await uploadFixture("cv.pdf", PDF_TYPE);
    expect(profile.cvFile).toEqual({
      fileName: "cv.pdf",
      size: bytes.length,
      uploadedAt: deps.clock.now().toISOString(),
    });
    expect((await uploadFixture("cv.docx", DOCX_TYPE)).cvFile).toBeNull();
  });

  test("reading the profile never selects the file's bytes", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const queries: string[] = [];
    const logged = drizzle({
      client: postgres(testUrl, { max: 1, onnotice: () => {} }),
      schema,
      casing: "snake_case",
      logger: { logQuery: (query) => queries.push(query) },
    });
    try {
      const profile = await getProfile({ ...deps, db: logged });
      expect(profile.cvFile?.fileName).toBe("cv.pdf");
      const cvQueries = queries.filter((q) => q.includes('"cv_files"'));
      expect(cvQueries).toHaveLength(1);
      expect(cvQueries[0]).not.toContain('"data"');
    } finally {
      await logged.$client.end({ timeout: 5 });
    }
  });
});

describe("GET /api/profile/cv/file", () => {
  const get = (headers: Record<string, string> = {}) => app.request("/api/profile/cv/file?v=1", { headers });

  test("serves the stored PDF inline, with headers that keep it on this app's own pages", async () => {
    const bytes = await fixtureBytes("cv.pdf");
    await uploadFixture("cv.pdf", PDF_TYPE);
    const res = await get({ "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "iframe" });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="cv.pdf"; filename*=UTF-8''cv.pdf`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
      "x-frame-options": "SAMEORIGIN",
    });
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  test("the type is always application/pdf, whatever the upload said", async () => {
    await uploadFixture("cv.pdf", "text/html");
    const res = await get();
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a cross-site request gets 403, even for a GET", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    const res = await get({ "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden_origin");
    expect((await get({ "Sec-Fetch-Site": "none" })).status).toBe(200);
  });

  test("a foreign Host gets 403 (localGuard)", async () => {
    await uploadFixture("cv.pdf", PDF_TYPE);
    expect((await get({ Host: "evil.example" })).status).toBe(403);
  });

  test("404 with no file: no CV, a pasted CV, or a DOCX", async () => {
    const notFound = async () => {
      const res = await get();
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    };
    await notFound();
    await paste(CV_LINES.join("\n"));
    await notFound();
    await uploadFixture("cv.docx", DOCX_TYPE);
    await notFound();
  });

  test("a name with quotes, a newline and non-ASCII gets an ASCII filename and an exact filename*", async () => {
    const name = 'My "CV"\nfinal – Résumé 履歴書 (v2).pdf';
    await testSql()`
      INSERT INTO cv_files (user_id, file_name, content_type, size, data)
      VALUES (${deps.userId}, ${name}, 'application/pdf', 5, ${Buffer.from("%PDF-")})`;
    const header = (await get()).headers.get("content-disposition") ?? "";
    expect(header).toBe(
      `inline; filename="My _CV__final _ R_sum_ ___ (v2).pdf"; filename*=UTF-8''My%20%22CV%22%0Afinal%20%E2%80%93%20R%C3%A9sum%C3%A9%20%E5%B1%A5%E6%AD%B4%E6%9B%B8%20%28v2%29.pdf`,
    );
    // One header line: no raw newline, quote or byte above 0x7E got through.
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    const star = /filename\*=UTF-8''(\S+)$/.exec(header)?.[1] ?? "";
    expect(decodeURIComponent(star)).toBe(name);
  });
});

describe("inlineDisposition", () => {
  test("an empty or all-unsafe name still gives a usable ASCII name", () => {
    expect(inlineDisposition("")).toBe(`inline; filename="cv.pdf"; filename*=UTF-8''cv.pdf`);
    expect(inlineDisposition("履歴書.pdf")).toBe(
      `inline; filename="___.pdf"; filename*=UTF-8''%E5%B1%A5%E6%AD%B4%E6%9B%B8.pdf`,
    );
    expect(inlineDisposition("a\\b;c'd*%41.pdf")).toBe(
      `inline; filename="a_b;c'd*_41.pdf"; filename*=UTF-8''a%5Cb%3Bc%27d%2A%2541.pdf`,
    );
    // A lone surrogate does not throw.
    expect(inlineDisposition("cv\uD800.pdf")).toBe(`inline; filename="cv_.pdf"; filename*=UTF-8''cv%EF%BF%BD.pdf`);
  });
});

describe("the table's checks", () => {
  const insert = (contentType: string, size: number, data: Uint8Array) => async () => {
    try {
      await testSql()`
        INSERT INTO cv_files (user_id, file_name, content_type, size, data)
        VALUES (${deps.userId}, 'cv.pdf', ${contentType}, ${size}, ${Buffer.from(data)})`;
      return "succeeded";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };

  test("only PDFs from 1 byte to 5 MB, with a size that matches the bytes", async () => {
    expect(await insert("text/html", 3, new Uint8Array(3))()).toBe("23514");
    expect(await insert(PDF_TYPE, 0, new Uint8Array(0))()).toBe("23514");
    expect(await insert(PDF_TYPE, 4, new Uint8Array(3))()).toBe("23514");
    expect(await insert(PDF_TYPE, MAX_STORED_CV_BYTES + 1, new Uint8Array(MAX_STORED_CV_BYTES + 1))()).toBe("23514");
    expect(await insert(PDF_TYPE, 3, new Uint8Array(3))()).toBe("succeeded");
  });
});
