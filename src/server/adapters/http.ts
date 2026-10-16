/**
 * The only `fetch` in the server (PLAN.md section 1, "Polite fetching"): user agent
 * `hanapbuhay/0.1 (personal use)`, at most 2 requests at a time per host, 400 to 900 ms between
 * requests to the same host, a 10 s timeout, `Retry-After` honored, at most 3 attempts with
 * exponential backoff, and a 2 MB response cap. Everything that varies (fetch, sleep, the clock,
 * randomness) is injected so tests never touch the network or wait.
 *
 * URLs come from the user (add by link), so every request and every redirect hop must pass
 * `publicUrl`: http or https only, and never a loopback, private or link-local address.
 */

export const USER_AGENT = "hanapbuhay/0.1 (personal use)";
const PER_HOST = 2;
const GAP_MIN_MS = 400;
const GAP_MAX_MS = 900;
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;
export const MAX_BYTES = 2 * 1024 * 1024;

export type HttpErrorKind = "timeout" | "network" | "status" | "too_large" | "invalid_url";

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | null;
  /** From a `Retry-After` header on a retryable status. */
  readonly retryAfterMs: number | null;
  constructor({
    kind,
    message,
    status = null,
    retryAfterMs = null,
  }: { kind: HttpErrorKind; message: string; status?: number | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type HttpText = { url: string; status: number; contentType: string; body: string };

export type HttpClient = {
  /** GET `url` and return the body as text. Throws `HttpError` after the last attempt fails. */
  getText(url: string, options?: { accept?: string }): Promise<HttpText>;
};

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

// ---------- outbound URL guard ----------

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1]) return privateIpv4(mapped[1]);
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
}

/**
 * The URL if it may be fetched: http or https on the default port for its scheme, and a host
 * that is a name or public address. Refuses `localhost`, `*.local`, `*.internal` and loopback,
 * private, link-local, CGNAT or multicast IP literals.
 */
export function publicUrl(raw: string): URL {
  const url = URL.parse(raw);
  const refuse = (message: string) => new HttpError({ kind: "invalid_url", message });
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw refuse("Only http and https links can be read.");
  }
  if (url.username || url.password) throw refuse("Links with a user name or password cannot be read.");
  if (url.port !== "") throw refuse("Links with a port number cannot be read.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const local = host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host) || !host.includes(".");
  if (local || privateIpv4(host) || privateIpv6(host)) {
    throw refuse("Links to this computer or a private network cannot be read.");
  }
  return url;
}

// ---------- reading ----------

/** Seconds or an HTTP date; null when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const tooLarge = () => new HttpError({ kind: "too_large", message: "The page is larger than 2 MB." });

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(error: HttpError): boolean {
  if (error.kind === "timeout" || error.kind === "network") return true;
  return error.kind === "status" && error.status !== null && RETRY_STATUSES.has(error.status);
}

type HostState = { active: number; lastStart: number; waiters: (() => void)[] };

export function createHttpClient({
  fetch: fetchFn = (input, init) => globalThis.fetch(input, init),
  sleep = (ms) => Bun.sleep(ms),
  now = () => Date.now(),
  random = Math.random,
  timeoutMs = TIMEOUT_MS,
}: {
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
} = {}): HttpClient {
  const hosts = new Map<string, HostState>();

  /** Wait for a per-host slot and the jittered gap since the last request to that host. */
  async function acquire(host: string): Promise<() => void> {
    const s = hosts.get(host) ?? { active: 0, lastStart: Number.NEGATIVE_INFINITY, waiters: [] };
    hosts.set(host, s);
    while (s.active >= PER_HOST) await new Promise<void>((resolve) => s.waiters.push(resolve));
    s.active++;
    const gap = GAP_MIN_MS + random() * (GAP_MAX_MS - GAP_MIN_MS);
    const startAt = Math.max(now(), s.lastStart + gap);
    s.lastStart = startAt;
    const wait = startAt - now();
    if (wait > 0) await sleep(wait);
    return () => {
      s.active--;
      s.waiters.shift()?.();
    };
  }

  /** One request, following redirects by hand so every hop passes the URL guard. */
  async function once(start: URL, accept: string, signal: AbortSignal): Promise<HttpText> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // `url` is always the output of `publicUrl`: the first hop in getText, each redirect below.
      const res = await fetchFn(publicUrl(url.href).href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: accept },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.body?.cancel();
        url = publicUrl(new URL(location, url).href);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new HttpError({
          kind: "status",
          status: res.status,
          message: `The site answered ${res.status}.`,
          retryAfterMs: retryAfterMs(res.headers.get("retry-after"), now()),
        });
      }
      const body = await readCapped(res);
      return { url: url.href, status: res.status, contentType: res.headers.get("content-type") ?? "", body };
    }
    throw new HttpError({ kind: "network", message: "The site redirected too many times." });
  }

  async function attempt(url: URL, accept: string): Promise<HttpText> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await once(url, accept, controller.signal);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError({ kind: "timeout", message: "The site did not answer within 10 seconds." });
      }
      throw new HttpError({ kind: "network", message: "The site could not be reached." });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getText(raw, options = {}) {
      const url = publicUrl(raw);
      const accept = options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
      for (let n = 1; ; n++) {
        const release = await acquire(url.host);
        let failure: HttpError;
        try {
          return await attempt(url, accept);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          failure = error;
        } finally {
          release();
        }
        if (!isRetryable(failure) || n >= MAX_ATTEMPTS) throw failure;
        await sleep(Math.min(MAX_RETRY_AFTER_MS, failure.retryAfterMs ?? BACKOFF_MS * 2 ** (n - 1)));
      }
    },
  };
}
