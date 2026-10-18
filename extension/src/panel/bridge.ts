import { DEFAULT_EXTENSION_ENDPOINT, type ExtensionEndpoint } from "@shared/extension";
import { PanelReply, type PanelRequest } from "../messages";
import { hostPermissionPattern } from "../state/endpoint";

// The panel never calls the server or reads the token: it asks the worker over chrome.runtime.

const NO_WORKER: PanelReply = {
  status: {
    kind: "error",
    endpoint: DEFAULT_EXTENSION_ENDPOINT,
    message: "The extension's background worker did not answer. Reload the extension.",
  },
  error: null,
};

export async function sendToWorker(request: PanelRequest): Promise<PanelReply> {
  const raw: unknown = await chrome.runtime.sendMessage(request).catch(() => undefined);
  const parsed = PanelReply.safeParse(raw);
  return parsed.success ? parsed.data : NO_WORKER;
}

/**
 * Ask Chrome for host access to the endpoint. `chrome.permissions.request` needs a user gesture,
 * which the worker never has, so the panel calls it from the click handler, before any other await.
 * The worker checks the grant again before it sends anything.
 */
export async function requestHostPermission(endpoint: ExtensionEndpoint): Promise<boolean> {
  return chrome.permissions.request({ origins: [hostPermissionPattern(endpoint)] }).catch(() => false);
}
