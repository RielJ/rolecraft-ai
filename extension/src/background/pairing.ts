import { DEFAULT_EXTENSION_ENDPOINT, ExtensionEndpoint, PairingCode, PingResult } from "@shared/extension";
import { createClient, type FetchLike, ROUTES } from "../api/client";
import type { ConnectionStatus, PanelReply } from "../messages";
import { hostPermissionPattern } from "../state/endpoint";
import type { Store } from "../state/storage";

export type PairingDeps = {
  store: Store;
  fetch: FetchLike;
  /** `chrome.permissions.contains` for one origin pattern. The panel requests it; the worker only checks. */
  hasHostPermission: (pattern: string) => Promise<boolean>;
};

const UNREACHABLE = "Could not reach Hanapbuhay. Check that the server is running and the address is right.";

function reply(status: ConnectionStatus, error: string | null = null): PanelReply {
  return { status, error };
}

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "That value is not valid.";
}

/** Asks the server whether the stored token still works. Fails closed on every other answer. */
export async function getStatus({ deps }: { deps: PairingDeps }): Promise<PanelReply> {
  const { endpoint, pairing } = await deps.store.readLocal();
  const shown = endpoint ?? DEFAULT_EXTENSION_ENDPOINT;
  if (endpoint === null || pairing === null) return reply({ kind: "unpaired", endpoint: shown, notice: null });

  const out = await createClient(deps).call({ route: ROUTES.ping, schema: PingResult });
  switch (out.kind) {
    case "ok":
      return reply({ kind: "paired", endpoint, pairingId: out.data.pairingId });
    case "unpaired":
      return reply({ kind: "unpaired", endpoint, notice: "revoked" });
    case "unreachable":
      return reply({ kind: "unreachable", endpoint });
    case "failed":
      await deps.store.clearBinding();
      return reply({ kind: "error", endpoint, message: out.message });
    default: {
      const exhaustive: never = out;
      return exhaustive;
    }
  }
}

/**
 * Pair with a one-time code: validate the endpoint (loopback HTTP or HTTPS), require host
 * permission for it, claim, store endpoint and token together, then confirm with a ping.
 */
export async function pair({
  deps,
  endpoint: rawEndpoint,
  code: rawCode,
}: {
  deps: PairingDeps;
  endpoint: string;
  code: string;
}): Promise<PanelReply> {
  const current = await deps.store.readLocal();
  const unpaired = (endpoint: string, error: string) => reply({ kind: "unpaired", endpoint, notice: null }, error);
  const shown = current.endpoint ?? DEFAULT_EXTENSION_ENDPOINT;

  const endpoint = ExtensionEndpoint.safeParse(rawEndpoint);
  if (!endpoint.success) return unpaired(shown, firstIssue(endpoint.error));
  const code = PairingCode.safeParse(rawCode);
  if (!code.success) return unpaired(endpoint.data, firstIssue(code.error));

  const pattern = hostPermissionPattern(endpoint.data);
  if (!(await deps.hasHostPermission(pattern))) {
    return unpaired(endpoint.data, `Allow the extension to reach ${endpoint.data} first.`);
  }

  const claimed = await createClient(deps).claimPairing({ endpoint: endpoint.data, code: code.data });
  switch (claimed.kind) {
    case "unreachable":
      return unpaired(endpoint.data, UNREACHABLE);
    case "failed":
      return unpaired(endpoint.data, claimed.message);
    case "ok":
      await deps.store.savePairing({ endpoint: endpoint.data, pairing: claimed.data });
      return getStatus({ deps });
    default: {
      const exhaustive: never = claimed;
      return exhaustive;
    }
  }
}

/** Forget the token and the session binding. The endpoint stays for the next pairing. */
export async function disconnect({ deps }: { deps: PairingDeps }): Promise<PanelReply> {
  await deps.store.clearPairing();
  const { endpoint } = await deps.store.readLocal();
  return reply({ kind: "unpaired", endpoint: endpoint ?? DEFAULT_EXTENSION_ENDPOINT, notice: null });
}
