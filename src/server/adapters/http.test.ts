import { describe, expect, test } from "bun:test";
import { createHttpClient, type FetchFn, HttpError, MAX_BYTES, publicUrl, USER_AGENT } from "./http";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a queue and records calls; a fake clock that sleeping advances. */
function harness(replies: (Response | Error | ((call: Call) => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (next === undefined) throw new Error("no reply queued");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next({ url, init }) : next;
  };
  const client = createHttpClient({
    fetch,
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected an HttpError");
}

describe("createHttpClient", () => {
  test("sends the user agent and returns the body", async () => {
    const { client, calls } = harness([new Response("<p>hi</p>", { headers: { "content-type": "text/html" } })]);
    const page = await client.getText("https://jobs.example.com/1");
    expect(page).toEqual({
      url: "https://jobs.example.com/1",
      status: 200,
      contentType: "text/html",
      body: "<p>hi</p>",
    });
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe(USER_AGENT);
  });

  test("waits 400 to 900 ms between requests to the same host", async () => {
    const { client, sleeps } = harness([new Response("a"), new Response("b")]);
    await client.getText("https://jobs.example.com/1");
    await client.getText("https://jobs.example.com/2");
    expect(sleeps).toEqual([650]); // random() = 0.5 -> halfway between 400 and 900
  });

  test("retries a 503 with backoff, honoring Retry-After, at most 3 attempts", async () => {
    const busy = () => new Response("", { status: 503, headers: { "retry-after": "2" } });
    const { client, calls, sleeps } = harness([busy(), new Response("", { status: 502 }), busy()]);
    const error = await failure(client.getText("https://jobs.example.com/1"));
    expect(error).toMatchObject({ kind: "status", status: 503 });
    expect(calls).toHaveLength(3);
    expect(sleeps.filter((ms) => ms >= 1000)).toEqual([2000, 2000]);
  });

  test("does not retry a 404", async () => {
    const { client, calls } = harness([new Response("", { status: 404 })]);
    expect(await failure(client.getText("https://jobs.example.com/1"))).toMatchObject({ kind: "status", status: 404 });
    expect(calls).toHaveLength(1);
  });

  test("refuses a body over 2 MB", async () => {
    const big = new Response("x".repeat(MAX_BYTES + 1));
    const { client } = harness([big]);
    expect(await failure(client.getText("https://jobs.example.com/1"))).toMatchObject({ kind: "too_large" });
  });

  test("follows redirects, but never to a private address", async () => {
    const hop = (to: string) => new Response("", { status: 302, headers: { location: to } });
    const ok = harness([hop("/final"), new Response("done")]);
    expect((await ok.client.getText("https://jobs.example.com/1")).url).toBe("https://jobs.example.com/final");
    const bad = harness([hop("http://169.254.169.254/latest")]);
    expect(await failure(bad.client.getText("https://jobs.example.com/1"))).toMatchObject({ kind: "invalid_url" });
    expect(bad.calls).toHaveLength(1);
  });

  test("a network error becomes a retryable network failure", async () => {
    const { client, calls } = harness([new TypeError("x"), new TypeError("x"), new Response("ok")]);
    expect((await client.getText("https://jobs.example.com/1")).body).toBe("ok");
    expect(calls).toHaveLength(3);
  });
});

describe("publicUrl", () => {
  test.each([
    "ftp://example.com/x",
    "http://localhost/x",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://printer.local/",
    "http://example.com:8080/",
    "http://intranet/",
  ])("refuses %s", (url) => {
    expect(() => publicUrl(url)).toThrow(HttpError);
  });
  test("accepts a public https URL", () => {
    expect(publicUrl("https://boards.greenhouse.io/acme/jobs/1").hostname).toBe("boards.greenhouse.io");
  });
});
