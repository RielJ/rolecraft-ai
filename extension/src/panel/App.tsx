import { type ReactNode, useCallback, useEffect, useState } from "react";
import { requestOriginAccess } from "../background/permissions";
import type { ConnectionStatus, PanelReply } from "../messages";
import { asImportReply, type ImportPanelRequest, type ImportReply } from "../messages-import";
import { Application, activeTab } from "./Application";
import { AppliedPromptPanel, type AppliedWatch } from "./AppliedPrompt";
import { sendToWorker } from "./bridge";
import { Diagnostics } from "./Diagnostics";
import { ImportJobPanel } from "./ImportJob";
import { Pairing } from "./Pairing";
import type { TabInfo } from "./state";

// Attaching files needs the current scan, so it lives in the Application review (FileAttachments),
// not on a tab of its own.
export const SCREENS = [
  { id: "application", label: "Application" },
  { id: "import", label: "Import" },
  { id: "diagnostics", label: "Diagnostics" },
] as const;
type Screen = (typeof SCREENS)[number]["id"];

/** The active tab in this window, kept current as the user switches tabs or a page loads. */
function useActiveTab(): TabInfo | null {
  const [tab, setTab] = useState<TabInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const retab = () => {
      void activeTab().then((next) => {
        if (!cancelled) setTab(next);
      });
    };
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url !== undefined || change.status === "complete") retab();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retab();
    };
    retab();
    chrome.tabs.onActivated.addListener(retab);
    chrome.tabs.onUpdated.addListener(onUpdated);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(retab);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return tab;
}

/** Import and applied requests are not Application machine events; their panels parse the reply. */
async function askImport(request: ImportPanelRequest): Promise<ImportReply> {
  return asImportReply(await sendToWorker(request));
}

const requestAccess = (url: string) => requestOriginAccess({ url });

function ImportScreen({ endpoint, onReply }: { endpoint: string; onReply: (reply: PanelReply) => void }) {
  const tab = useActiveTab();
  return (
    <ImportJobPanel endpoint={endpoint} tab={tab} requestAccess={requestAccess} send={askImport} onReply={onReply} />
  );
}

/**
 * The paired panel's body. The applied question sits above every screen, so it shows whichever tab
 * is open. Application and Import stay mounted while hidden, so a review or an edited import
 * survives switching tabs.
 */
export function PanelScreens({
  screen,
  prompt,
  application,
  importScreen,
  diagnostics,
}: {
  screen: Screen;
  prompt: ReactNode;
  application: ReactNode;
  importScreen: ReactNode;
  diagnostics: ReactNode;
}) {
  return (
    <main className="flex flex-col gap-4 p-4">
      {prompt}
      <div hidden={screen !== "application"} className="flex flex-col gap-4">
        {application}
      </div>
      <div hidden={screen !== "import"} className="flex flex-col gap-4">
        {importScreen}
      </div>
      {screen === "diagnostics" && diagnostics}
    </main>
  );
}

function Paired({
  status,
  onReply,
}: {
  status: Extract<ConnectionStatus, { kind: "paired" }>;
  onReply: (reply: PanelReply) => void;
}) {
  const [screen, setScreen] = useState<Screen>("application");
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState<AppliedWatch | null>(null);

  // A worker reply that says the pairing is gone or the server is down puts the pairing screen back.
  const onWorkerReply = useCallback(
    (reply: PanelReply) => {
      if (reply.status.kind !== "paired") onReply(reply);
    },
    [onReply],
  );

  async function disconnect() {
    setBusy(true);
    onReply(await sendToWorker({ kind: "disconnect" }));
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Hanapbuhay</p>
          <p className="truncate text-xs text-muted-foreground" title={status.endpoint}>
            Paired with {status.endpoint}
          </p>
        </div>
        <button type="button" className="btn-secondary shrink-0" onClick={disconnect} disabled={busy}>
          Disconnect
        </button>
      </header>
      <nav aria-label="Panel sections" className="flex gap-1 border-b border-border px-2 py-1.5">
        {SCREENS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={screen === id ? "page" : undefined}
            className="tab"
            onClick={() => setScreen(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <PanelScreens
        screen={screen}
        prompt={<AppliedPromptPanel watch={watch} send={askImport} onReply={onWorkerReply} />}
        application={<Application onReply={onWorkerReply} onWatch={setWatch} />}
        importScreen={<ImportScreen endpoint={status.endpoint} onReply={onWorkerReply} />}
        diagnostics={<Diagnostics onReply={onWorkerReply} />}
      />
    </div>
  );
}

export function App() {
  const [reply, setReply] = useState<PanelReply | null>(null);

  const refresh = useCallback(async () => setReply(await sendToWorker({ kind: "status" })), []);

  // Check the pairing whenever the panel is shown: a revoked token or a stopped server must put the
  // pairing screen back before anything else can run.
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  if (reply === null) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Checking the connection…
      </p>
    );
  }
  const { status } = reply;
  return status.kind === "paired" ? (
    <Paired status={status} onReply={setReply} />
  ) : (
    <Pairing status={status} onReply={setReply} />
  );
}
