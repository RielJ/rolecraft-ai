import "../zod-setup";
import { routeMessage } from "../messages";
import { createDiagnosticsLog, refusalEntry } from "../state/diagnostics";
import { chromeArea, createStore } from "../state/storage";
import { chromeContentDeps, handleContentMessage } from "./content";
import { chromeSendImport } from "./import";
import type { PairingDeps } from "./pairing";
import { handlePanelRequest, type PanelDeps } from "./panel";

// Service worker: every server call, permission check and session state lives here. The worker
// can be stopped at any time, so nothing is kept in memory between events; state is in storage.
// This file only wires Chrome to the handlers; the logic is in panel.ts, pairing.ts, content.ts,
// files.ts and import.ts.

const pairingDeps: PairingDeps = {
  store: createStore({ local: chromeArea(chrome.storage.local), session: chromeArea(chrome.storage.session) }),
  fetch: (url, init) => fetch(url, init),
  hasHostPermission: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
};

const panelDeps: PanelDeps = {
  pairing: pairingDeps,
  content: chromeContentDeps(pairingDeps.store),
  permissions: chrome.permissions,
  now: () => Date.now(),
  sendImport: chromeSendImport,
  // chrome.storage.session: gone when the browser closes, and not readable from content scripts.
  diagnostics: createDiagnosticsLog({ area: chromeArea(chrome.storage.session) }),
};

function openPanelOnActionClick(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Only fails on a Chrome without the side panel API, which minimum_chrome_version excludes.
  });
}

chrome.runtime.onInstalled.addListener(openPanelOnActionClick);
chrome.runtime.onStartup.addListener(openPanelOnActionClick);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const routed = routeMessage({ message, sender, runtimeId: chrome.runtime.id });
  switch (routed.kind) {
    case "panel":
      handlePanelRequest({ deps: panelDeps, request: routed.request }).then(sendResponse, () =>
        sendResponse(undefined),
      );
      return true;
    case "content":
      handleContentMessage({ deps: pairingDeps, message: routed.message, tabId: routed.tabId, url: routed.url }).then(
        sendResponse,
        () => sendResponse(undefined),
      );
      return true;
    case "rejected":
      panelDeps.diagnostics
        .record(refusalEntry({ message, senderUrl: sender.url, reason: routed.reason, ts: Date.now() }))
        .catch(() => undefined);
      return false;
    default: {
      const exhaustive: never = routed;
      return exhaustive;
    }
  }
});
