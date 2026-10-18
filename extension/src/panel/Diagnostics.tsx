import type { DiagnosticEntry } from "@shared/extension";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionStatus, PanelReply, PanelRequest, PanelResult } from "../messages";
import { sendToWorker } from "./bridge";

// The Diagnostics tab: the connection, the metadata-only log the worker keeps in
// chrome.storage.session (state/diagnostics.ts), and the sites the user allowed. Opening the tab
// pings the server, so "Last ping" is always this visit's.

type Send = (request: PanelRequest) => Promise<PanelReply>;

export type Ping = { status: ConnectionStatus; at: number };

const STATUS_LABELS: Record<ConnectionStatus["kind"], string> = {
  paired: "Paired",
  unpaired: "Not paired",
  unreachable: "Server not reachable",
  error: "Server error",
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "12 fields, 8 matched, 6 filled": the non-zero counts, fields always. */
export function countsText(counts: DiagnosticEntry["counts"]): string | null {
  if (counts === null) return null;
  const { fields, ...rest } = counts;
  const parts = [`${fields} ${fields === 1 ? "field" : "fields"}`];
  for (const [name, n] of Object.entries(rest)) if (n > 0) parts.push(`${n} ${name}`);
  return parts.join(", ");
}

/**
 * Newest first, each with a key built from its content. Entries have no id; two with the same time,
 * kind and request get a running number.
 */
function keyedNewestFirst(entries: readonly DiagnosticEntry[]): { key: string; entry: DiagnosticEntry }[] {
  const seen = new Map<string, number>();
  return [...entries].reverse().map((entry) => {
    const base = `${entry.ts}:${entry.kind}:${entry.request}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}:${n}`, entry };
  });
}

/** What Copy puts on the clipboard: the entries as stored, nothing added. */
export function copyText(entries: readonly DiagnosticEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

function EntryRow({ entry }: { entry: DiagnosticEntry }) {
  const counts = countsText(entry.counts);
  const details = [entry.origin ?? "no site", entry.adapter, counts].filter((d) => d !== null);
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-xs">
          {entry.kind === "refusal" ? `refused ${entry.request}` : entry.request}
        </span>
        <span className={`font-mono text-xs ${entry.outcome === "ok" ? "text-muted-foreground" : "text-destructive"}`}>
          {entry.outcome}
        </span>
        <time className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{time(entry.ts)}</time>
      </div>
      <p className="truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
    </li>
  );
}

export type DiagnosticsViewProps = {
  ping: Ping | null;
  entries: readonly DiagnosticEntry[] | null;
  origins: readonly string[] | null;
  copied: "idle" | "copied" | "failed";
  busy: boolean;
  onPing: () => void;
  onCopy: () => void;
  onClear: () => void;
  onRevoke: (origin: string) => void;
};

/** The tab's markup, without the worker calls. Newest entry first. */
export function DiagnosticsView({
  ping,
  entries,
  origins,
  copied,
  busy,
  onPing,
  onCopy,
  onClear,
  onRevoke,
}: DiagnosticsViewProps) {
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="connection-title" className="flex flex-col gap-2">
        <h2 id="connection-title" className="text-sm font-semibold">
          Connection
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Server</dt>
          <dd className="truncate">{ping?.status.endpoint ?? "…"}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{ping === null ? "Checking…" : STATUS_LABELS[ping.status.kind]}</dd>
          <dt className="text-muted-foreground">Last ping</dt>
          <dd className="tabular-nums">{ping === null ? "…" : time(ping.at)}</dd>
        </dl>
        <button type="button" className="btn-secondary self-start" onClick={onPing} disabled={busy}>
          Ping again
        </button>
      </section>

      <section aria-labelledby="log-title" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 id="log-title" className="text-sm font-semibold">
            Recent activity
          </h2>
          <button
            type="button"
            className="btn-secondary ml-auto"
            onClick={onCopy}
            disabled={busy || entries === null || entries.length === 0}
          >
            {copied === "copied" ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClear}
            disabled={busy || entries === null || entries.length === 0}
          >
            Clear
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          The last 50 requests, kept until you close Chrome. Each one is a request name, a result code, counts and the
          site's address without the page path. Nothing you typed or filled is kept.
        </p>
        {copied === "failed" && (
          <p role="alert" className="text-xs text-destructive">
            Chrome didn't allow copying. Click Copy again.
          </p>
        )}
        {entries === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="divide-y divide-border rounded-control border border-border">
            {keyedNewestFirst(entries).map(({ key, entry }) => (
              <EntryRow key={key} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="sites-title" className="flex flex-col gap-2">
        <h2 id="sites-title" className="text-sm font-semibold">
          Allowed sites
        </h2>
        <p className="text-xs text-muted-foreground">
          The extension can scan and fill pages on these sites. Revoke one and it asks again next time.
        </p>
        {origins === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : origins.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven't allowed any sites.</p>
        ) : (
          <ul className="divide-y divide-border rounded-control border border-border">
            {origins.map((origin) => (
              <li key={origin} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm" title={origin}>
                  {origin}
                </span>
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  aria-label={`Revoke ${origin}`}
                  onClick={() => onRevoke(origin)}
                  disabled={busy}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function Diagnostics({
  onReply,
  send = sendToWorker,
}: {
  /** Called with a reply that says the pairing is gone or the server is down. */
  onReply: (reply: PanelReply) => void;
  send?: Send;
}) {
  const [ping, setPing] = useState<Ping | null>(null);
  const [entries, setEntries] = useState<readonly DiagnosticEntry[] | null>(null);
  const [origins, setOrigins] = useState<readonly string[] | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);

  /** The reply's result, or null after handing a lost connection to the parent. */
  const ask = useCallback(
    async (request: PanelRequest): Promise<PanelResult | null> => {
      const reply = await send(request);
      if (reply.status.kind !== "paired") {
        onReply(reply);
        return null;
      }
      return reply.result ?? null;
    },
    [send, onReply],
  );

  const reloadEntries = useCallback(async () => {
    const result = await ask({ kind: "diagnostics_list" });
    if (result?.kind === "diagnostics") setEntries(result.entries);
  }, [ask]);

  const pingNow = useCallback(async () => {
    const reply = await send({ kind: "status" });
    setPing({ status: reply.status, at: Date.now() });
    if (reply.status.kind !== "paired") onReply(reply);
  }, [send, onReply]);

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      await pingNow();
      const synced = await ask({ kind: "sync_origins" });
      if (synced?.kind === "origins") setOrigins(synced.origins);
      await reloadEntries();
    });
  }, [run, pingNow, ask, reloadEntries]);

  async function copy() {
    if (entries === null) return;
    const ok = await navigator.clipboard.writeText(copyText(entries)).then(
      () => true,
      () => false,
    );
    setCopied(ok ? "copied" : "failed");
  }

  return (
    <DiagnosticsView
      ping={ping}
      entries={entries}
      origins={origins}
      copied={copied}
      busy={busy}
      onPing={() =>
        void run(async () => {
          await pingNow();
          await reloadEntries();
        })
      }
      onCopy={() => void copy()}
      onClear={() =>
        void run(async () => {
          const result = await ask({ kind: "diagnostics_clear" });
          if (result?.kind === "diagnostics") setEntries(result.entries);
          setCopied("idle");
        })
      }
      onRevoke={(origin) =>
        void run(async () => {
          const result = await ask({ kind: "revoke_origin", origin });
          if (result?.kind === "origins") setOrigins(result.origins);
          await reloadEntries();
        })
      }
    />
  );
}
