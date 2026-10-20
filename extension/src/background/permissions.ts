import { blockedSite } from "@shared/hosts";
import type { GrantedOrigins, Store } from "../state/storage";

// Per-origin approval for prefill (docs/EXTENSION.md). The manifest
// lists `https://*/*` as an optional host permission; the user grants one origin at a time.
// `chrome.permissions.request` needs a user gesture, which the worker never has, so the panel
// calls `requestOriginAccess` from the click handler before any other await (as Pairing.tsx does
// for the endpoint). The worker only checks, revokes and mirrors the grants into storage.

/** The part of `chrome.permissions` used here. Tests pass an in-memory one. */
export type PermissionsApi = {
  request(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
  contains(permissions: { origins: string[] }): Promise<boolean>;
  getAll(): Promise<{ origins?: string[] | undefined }>;
};

export type OriginApproval =
  | { kind: "approvable"; origin: string; pattern: string }
  | { kind: "refused"; reason: "blocked_host" | "unsupported_url" };

export type OriginAccess =
  | { kind: "granted"; origin: string }
  | { kind: "denied"; origin: string }
  | { kind: "refused"; reason: "blocked_host" | "unsupported_url" };

/** HTTPS pages only, and never a site whose terms forbid automation (src/shared/hosts.ts). */
export function approvalFor(url: string): OriginApproval {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname === "") {
    return { kind: "refused", reason: "unsupported_url" };
  }
  if (blockedSite(url) !== null) return { kind: "refused", reason: "blocked_host" };
  // Chrome match patterns ignore the port, so the pattern is scheme and host.
  const origin = `https://${parsed.hostname}`;
  return { kind: "approvable", origin, pattern: `${origin}/*` };
}

/** Panel click handler: ask Chrome for the tab's origin. Must be the handler's first await. */
export async function requestOriginAccess({
  url,
  permissions = chrome.permissions,
}: {
  url: string;
  permissions?: PermissionsApi;
}): Promise<OriginAccess> {
  const approval = approvalFor(url);
  if (approval.kind === "refused") return approval;
  const granted = await permissions.request({ origins: [approval.pattern] }).catch(() => false);
  return { kind: granted ? "granted" : "denied", origin: approval.origin };
}

/** Worker: whether the user granted this page's origin. activeTab grants are not visible here. */
export async function hasOriginAccess({
  url,
  permissions = chrome.permissions,
}: {
  url: string;
  permissions?: PermissionsApi;
}): Promise<boolean> {
  const approval = approvalFor(url);
  if (approval.kind === "refused") return false;
  return permissions.contains({ origins: [approval.pattern] }).catch(() => false);
}

const SINGLE_ORIGIN_PATTERN = /^(https:\/\/[^/*?#\s]+)\/\*$/;

/**
 * Mirror Chrome's per-origin grants into `grantedOrigins`. Chrome is the source of truth: the user
 * can revoke from chrome://extensions at any time. Loopback (the endpoint), wildcards and blocked
 * hosts are left out.
 */
export async function syncGrantedOrigins({
  store,
  permissions = chrome.permissions,
}: {
  store: Pick<Store, "saveGrantedOrigins">;
  permissions?: PermissionsApi;
}): Promise<GrantedOrigins> {
  const { origins = [] } = await permissions.getAll();
  const granted = [
    ...new Set(
      origins
        .map((pattern) => SINGLE_ORIGIN_PATTERN.exec(pattern)?.[1])
        .filter((origin): origin is string => origin !== undefined && blockedSite(origin) === null),
    ),
  ].sort();
  await store.saveGrantedOrigins(granted);
  return granted;
}

/** Revoke one approved origin (no gesture needed), then re-sync storage. */
export async function revokeOriginAccess({
  origin,
  store,
  permissions = chrome.permissions,
}: {
  origin: string;
  store: Pick<Store, "saveGrantedOrigins">;
  permissions?: PermissionsApi;
}): Promise<GrantedOrigins> {
  const approval = approvalFor(origin);
  if (approval.kind === "approvable") {
    await permissions.remove({ origins: [approval.pattern] }).catch(() => false);
  }
  return syncGrantedOrigins({ store, permissions });
}
