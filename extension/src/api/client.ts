import { ApiErrorBody, ERROR_CODES, type ErrorCode } from "@shared/api";
import {
  ClaimPairingResult,
  type ExtensionAuthRoute,
  type ExtensionEndpoint,
  type PairingCode,
} from "@shared/extension";
import type { z } from "zod";
import type { Store } from "../state/storage";

// The only code that talks to the Hanapbuhay server. It runs in the service worker.
// Fail closed: no token, a 401, a network failure or a body that does not parse never yields data.

/** `fetch` as the client calls it. The worker passes the global; tests pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type ExtensionRoute = Extract<ExtensionAuthRoute, { caller: "extension" }>;
type ClientRoute = Pick<ExtensionRoute, "method" | "path">;

/** Every bearer route in `EXTENSION_AUTH_MATRIX`; test/client.test.ts keeps the two in step. */
export const ROUTES = {
  ping: { method: "GET", path: "/api/extension/ping" },
  activeSession: { method: "GET", path: "/api/extension/sessions/active" },
  claimSession: { method: "POST", path: "/api/extension/sessions/:id/claim" },
  prefill: { method: "POST", path: "/api/extension/sessions/:id/prefill" },
  outputs: { method: "GET", path: "/api/extension/sessions/:id/outputs" },
  editOutput: { method: "PATCH", path: "/api/extension/sessions/:id/outputs/:outputId" },
  reviewOutput: { method: "POST", path: "/api/extension/sessions/:id/outputs/:outputId/reviewed" },
  outputPdf: { method: "GET", path: "/api/extension/sessions/:id/outputs/:outputId/pdf" },
  draft: { method: "POST", path: "/api/extension/sessions/:id/draft" },
  confirmApplied: { method: "POST", path: "/api/extension/sessions/:id/confirm-applied" },
  task: { method: "GET", path: "/api/extension/tasks/:id" },
  lookup: { method: "GET", path: "/api/extension/opportunities/by-url" },
  importJob: { method: "POST", path: "/api/extension/import" },
  preferences: { method: "GET", path: "/api/extension/preferences" },
  savePreference: { method: "PUT", path: "/api/extension/preferences" },
  deletePreference: { method: "DELETE", path: "/api/extension/preferences/:id" },
} as const satisfies Record<string, ClientRoute>;

/** `:name` segments of a route path. */
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
type PathParams<P extends string> = [ParamNames<P>] extends [never]
  ? { params?: never }
  : { params: Record<ParamNames<P>, string> };

export type FailureCode = ErrorCode | "bad_response";

/** A non-2xx answer other than the bearer 401, or a 2xx whose body did not parse. */
export type Failed = { kind: "failed"; status: number; code: FailureCode; message: string; details: unknown };

export type ClientOutcome<T> =
  | { kind: "ok"; data: T }
  /** No usable token, or the server answered 401. The token and session binding are gone. */
  | { kind: "unpaired" }
  /** The server could not be reached (down, redirect, permission revoked). The session binding is gone. */
  | { kind: "unreachable" };

type SendArgs<P extends string> = {
  route: { method: ClientRoute["method"]; path: P };
  query?: Record<string, string>;
  body?: unknown;
} & PathParams<P>;

const BAD_RESPONSE: Failed = {
  kind: "failed",
  status: 0,
  code: "bad_response",
  message: "The server answered with something the extension cannot read. Update Hanapbuhay and the extension.",
  details: undefined,
};

function fillPath(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params?.[name] ?? ""));
}

function toFailureCode(code: string): FailureCode {
  return ERROR_CODES.find((c) => c === code) ?? "internal";
}

async function toFailed(res: Response): Promise<Failed> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ApiErrorBody.safeParse(body);
  if (!parsed.success) {
    return { ...BAD_RESPONSE, status: res.status, code: "internal", message: `The server answered ${res.status}.` };
  }
  const { code, message, details } = parsed.data.error;
  return { kind: "failed", status: res.status, code: toFailureCode(code), message, details };
}

async function parseBody<T>(res: Response, schema: z.ZodType<T>): Promise<{ kind: "ok"; data: T } | Failed> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? { kind: "ok", data: parsed.data } : { ...BAD_RESPONSE, status: res.status };
}

/** Request options every server call shares: no cookies, no cache, no redirects. */
function requestInit({ method, headers, body }: { method: string; headers: Headers; body: unknown }): RequestInit {
  headers.set("Accept", "application/json");
  const init: RequestInit = { method, headers, credentials: "omit", cache: "no-store", redirect: "error" };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  return init;
}

export function createClient({ fetch, store }: { fetch: FetchLike; store: Store }) {
  /**
   * A bearer call. Returns the raw response on 2xx or app error so callers that need bytes (the PDF
   * route) can read it; `call` is the JSON version.
   */
  async function send<P extends string>(args: SendArgs<P>): Promise<ClientOutcome<Response> | Failed> {
    const { endpoint, pairing } = await store.readLocal();
    if (endpoint === null || pairing === null) return { kind: "unpaired" };

    const url = new URL(fillPath(args.route.path, args.params), endpoint);
    for (const [key, value] of Object.entries(args.query ?? {})) url.searchParams.set(key, value);
    const headers = new Headers({ Authorization: `Bearer ${pairing.token}` });

    let res: Response;
    try {
      res = await fetch(url.href, requestInit({ method: args.route.method, headers, body: args.body }));
    } catch {
      await store.clearBinding();
      return { kind: "unreachable" };
    }
    if (res.status === 401) {
      await store.clearPairing();
      return { kind: "unpaired" };
    }
    if (!res.ok) return toFailed(res);
    return { kind: "ok", data: res };
  }

  async function call<P extends string, T>(
    args: SendArgs<P> & { schema: z.ZodType<T> },
  ): Promise<ClientOutcome<T> | Failed> {
    const sent = await send(args);
    if (sent.kind !== "ok") return sent;
    return parseBody(sent.data, args.schema);
  }

  /**
   * `POST /api/extension/pair/claim`: the one call made with a code instead of a token, to an
   * endpoint that is not stored yet. Chrome sets `Origin: chrome-extension://<id>`, which the
   * server binds. Stores nothing; the caller saves the result.
   */
  async function claimPairing({
    endpoint,
    code,
  }: {
    endpoint: ExtensionEndpoint;
    code: PairingCode;
  }): Promise<{ kind: "ok"; data: ClaimPairingResult } | { kind: "unreachable" } | Failed> {
    const url = new URL("/api/extension/pair/claim", endpoint);
    let res: Response;
    try {
      res = await fetch(url.href, requestInit({ method: "POST", headers: new Headers(), body: { code } }));
    } catch {
      return { kind: "unreachable" };
    }
    if (!res.ok) return toFailed(res);
    return parseBody(res, ClaimPairingResult);
  }

  return { send, call, claimPairing };
}

export type Client = ReturnType<typeof createClient>;
