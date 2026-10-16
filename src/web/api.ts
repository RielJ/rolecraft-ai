import { hc } from "hono/client";
import type { AppType } from "@/server/http/app";
import { ApiErrorBody, ERROR_CODES, type ErrorCode, GateBlocker } from "@/shared/api";

export const client = hc<AppType>(globalThis.location?.origin ?? "http://localhost");

/** A non-2xx API answer, in the app's error shape. */
export class ApiError extends Error {
  readonly code: ErrorCode | "network";
  readonly status: number;
  readonly details: unknown;
  constructor({
    code,
    status,
    message,
    details,
  }: {
    code: ErrorCode | "network";
    status: number;
    message: string;
    details?: unknown;
  }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** The gate's blocker list when the server answered `409 needs_input`. */
  get blockers(): GateBlocker[] {
    if (this.code !== "needs_input") return [];
    const parsed = GateBlocker.array().safeParse(this.details);
    return parsed.success ? parsed.data : [];
  }
}

/** The part of a fetch Response the helpers read; Hono's ClientResponse satisfies it. */
type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

function toCode(code: string): ErrorCode {
  return ERROR_CODES.find((c) => c === code) ?? "internal";
}

export async function toApiError(res: JsonResponse): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ApiErrorBody.safeParse(body);
  if (!parsed.success) {
    return new ApiError({
      code: "internal",
      status: res.status,
      message: `The server answered ${res.status} without an error message. Check the server log.`,
    });
  }
  const { code, message, details } = parsed.data.error;
  return new ApiError({ code: toCode(code), status: res.status, message, details });
}

/**
 * Await a Hono client call. hc types the request; the shared Zod schema checks the response.
 * Non-2xx answers become an `ApiError` in the app's error shape.
 */
export async function unwrap<T>(call: Promise<JsonResponse>, schema: { parse(value: unknown): T }): Promise<T> {
  let res: JsonResponse;
  try {
    res = await call;
  } catch {
    throw new ApiError({
      code: "network",
      status: 0,
      message: "Could not reach the app server. Check that it is running, then try again.",
    });
  }
  if (!res.ok) throw await toApiError(res);
  return schema.parse(await res.json());
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
