import { ExtensionEndpoint } from "@shared/extension";
import { type FormEvent, useId, useState } from "react";
import type { ConnectionStatus, PanelReply } from "../messages";
import { requestHostPermission, sendToWorker } from "./bridge";

type NotPaired = Exclude<ConnectionStatus, { kind: "paired" }>;

function notice(status: NotPaired): string | null {
  switch (status.kind) {
    case "unpaired":
      return status.notice === "revoked" ? "This browser was disconnected from Rolecraft. Pair it again." : null;
    case "unreachable":
      return `Can't reach Rolecraft at ${status.endpoint}. Start the server, then retry.`;
    case "error":
      return status.message;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function Pairing({ status, onReply }: { status: NotPaired; onReply: (reply: PanelReply) => void }) {
  const [endpoint, setEndpoint] = useState<string>(status.endpoint);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpointId = useId();
  const codeId = useId();
  const banner = notice(status);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ExtensionEndpoint.safeParse(endpoint);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter the Rolecraft address.");
      return;
    }
    // First await in the handler: Chrome only shows the permission prompt during the user gesture.
    const granted = await requestHostPermission(parsed.data);
    if (!granted) {
      setError(`The extension needs access to ${parsed.data} to pair. Try again and choose Allow.`);
      return;
    }
    setBusy(true);
    setError(null);
    const reply = await sendToWorker({ kind: "pair", endpoint: parsed.data, code });
    setBusy(false);
    setError(reply.error);
    if (reply.status.kind === "paired") setCode("");
    onReply(reply);
  }

  async function retry() {
    setBusy(true);
    onReply(await sendToWorker({ kind: "status" }));
    setBusy(false);
  }

  return (
    <main className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">Pair with Rolecraft</h1>
        <p className="text-sm text-muted-foreground">
          In Rolecraft, open Settings and create a pairing code. Codes work once and expire after 10 minutes.
        </p>
      </header>

      {banner !== null && (
        <div role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">
          <p>{banner}</p>
          {status.kind === "unreachable" && (
            <button type="button" className="btn-secondary mt-2" onClick={retry} disabled={busy}>
              Retry
            </button>
          )}
        </div>
      )}

      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={endpointId} className="text-sm font-medium">
            Rolecraft address
          </label>
          <input
            id={endpointId}
            className="field"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">http://localhost or http://127.0.0.1 with a port, or https.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={codeId} className="text-sm font-medium">
            Pairing code
          </label>
          <input
            id={codeId}
            className="field font-mono uppercase tracking-widest"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            maxLength={20}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy || code.trim() === ""}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  );
}
