import { CopyIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type { CreatePairingResult, PairingDto } from "@/shared/extension";
import { errorMessage } from "../api";
import { useCreatePairing, usePairings, useRevokePairing } from "../queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const onError = (error: unknown) => toast.error(errorMessage(error));

const AT = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
const at = (iso: string) => AT.format(new Date(iso));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "5 minutes ago". The page clock only ticks while a code waits, so a stale clock reads "just now". */
function ago({ iso, now }: { iso: string; now: number }): string {
  const ms = now - new Date(iso).getTime();
  if (ms < MINUTE_MS) return "just now";
  if (ms < HOUR_MS) return `${count(Math.floor(ms / MINUTE_MS), "minute")} ago`;
  if (ms < DAY_MS) return `${count(Math.floor(ms / HOUR_MS), "hour")} ago`;
  return `${count(Math.floor(ms / DAY_MS), "day")} ago`;
}

/** Milliseconds left on a waiting code; zero or less once it has expired. */
const msLeft = ({ codeExpiresAt, now }: { codeExpiresAt: string; now: number }) =>
  new Date(codeExpiresAt).getTime() - now;

/** "9:05" */
function minutesSeconds(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Epoch milliseconds, moved on every second while `ticking`, so a countdown runs without a reload. */
function useSecondClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The server's state, with a waiting code past its expiry shown as expired before the next refetch. */
type ShownState = PairingDto["status"];
function shownState({ pairing, now }: { pairing: PairingDto; now: number }): ShownState {
  if (pairing.status === "waiting" && msLeft({ codeExpiresAt: pairing.codeExpiresAt, now }) <= 0) return "expired";
  return pairing.status;
}

const extensionId = (origin: string) => origin.replace("chrome-extension://", "");

/** The code just made: large, in two groups of four, with its countdown and a copy button. */
function NewCode({
  created,
  pairing,
  now,
  onDone,
}: {
  created: CreatePairingResult;
  pairing: PairingDto;
  now: number;
  onDone: () => void;
}) {
  const state = shownState({ pairing, now });
  switch (state) {
    case "waiting": {
      if (pairing.status !== "waiting") return null;
      const [first, second] = created.code.split("-");
      return (
        <div className="grid max-w-md gap-3 rounded-lg border p-4">
          <p className="text-sm">In the extension&apos;s side panel, enter this code:</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <p
              className="flex gap-3 font-mono font-semibold text-3xl tabular-nums tracking-[0.2em]"
              data-testid="pairing-code"
            >
              <span>{first}</span>
              <span className="sr-only">-</span>
              <span>{second}</span>
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(created.code).then(
                  () => toast("Code copied."),
                  () => toast.error("Could not copy. Select the code and copy it by hand."),
                )
              }
            >
              <CopyIcon aria-hidden />
              Copy code
            </Button>
          </div>
          <p className="text-muted-foreground text-sm tabular-nums">
            Expires in {minutesSeconds(msLeft({ codeExpiresAt: pairing.codeExpiresAt, now }))}. It works once.
          </p>
        </div>
      );
    }
    case "active":
      return (
        <div role="status" className="flex max-w-md flex-wrap items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">Paired. The extension can prefill application forms now.</span>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      );
    case "expired":
      return (
        <p role="status" className="max-w-md rounded-lg border p-4 text-muted-foreground text-sm">
          This code expired before the extension used it. Create a new one.
        </p>
      );
    case "revoked":
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

const STATE_BADGE: Record<ShownState, { label: string; variant: "default" | "secondary" | "outline" }> = {
  waiting: { label: "Waiting", variant: "secondary" },
  active: { label: "Active", variant: "default" },
  expired: { label: "Expired", variant: "outline" },
  revoked: { label: "Revoked", variant: "outline" },
};

/** One line of detail under a pairing's state. */
function PairingDetail({ pairing, now }: { pairing: PairingDto; now: number }) {
  switch (pairing.status) {
    case "waiting": {
      const left = msLeft({ codeExpiresAt: pairing.codeExpiresAt, now });
      return (
        <span className="tabular-nums">
          Code made {at(pairing.createdAt)}. {left > 0 ? `Expires in ${minutesSeconds(left)}.` : "Expired, never used."}
        </span>
      );
    }
    case "active":
      return (
        <>
          <span className="break-all font-mono text-xs">{extensionId(pairing.extensionOrigin)}</span>
          <span>
            Paired {at(pairing.claimedAt)}.{" "}
            {pairing.lastUsedAt ? `Last used ${ago({ iso: pairing.lastUsedAt, now })}.` : "Not used yet."}
          </span>
        </>
      );
    case "expired":
      return <span>Code made {at(pairing.createdAt)}, never used.</span>;
    case "revoked":
      return (
        <>
          {pairing.extensionOrigin && (
            <span className="break-all font-mono text-xs">{extensionId(pairing.extensionOrigin)}</span>
          )}
          <span>Revoked {at(pairing.revokedAt)}.</span>
        </>
      );
    default: {
      const _exhaustive: never = pairing;
      return _exhaustive;
    }
  }
}

function PairingRow({
  pairing,
  now,
  onRevoke,
}: {
  pairing: PairingDto;
  now: number;
  onRevoke: (pairing: PairingDto) => void;
}) {
  const state = shownState({ pairing, now });
  const badge = STATE_BADGE[state];
  const ended = state === "expired" || state === "revoked";
  return (
    <li className="flex items-start gap-3 py-3" data-pairing-id={pairing.id}>
      <Badge variant={badge.variant} className={ended ? "text-muted-foreground" : undefined}>
        {badge.label}
      </Badge>
      <div className="grid flex-1 gap-0.5 text-muted-foreground text-sm">
        <PairingDetail pairing={pairing} now={now} />
      </div>
      {!ended && (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onRevoke(pairing)}>
          Revoke
        </Button>
      )}
    </li>
  );
}

/**
 * Settings, Chrome extension: make a one-time pairing code, list pairings with their state, revoke
 * one. The code is in the create answer only, so it shows until the page is left or it is used.
 */
export function ExtensionPairing() {
  const id = useId();
  const pairings = usePairings();
  const create = useCreatePairing();
  const [created, setCreated] = useState<CreatePairingResult | null>(null);
  const [confirming, setConfirming] = useState<PairingDto | null>(null);

  const list = pairings.data?.pairings ?? [];
  const createdNow = created && (list.find((p) => p.id === created.pairing.id) ?? created.pairing);
  const now = useSecondClock(list.some((p) => p.status === "waiting") || createdNow?.status === "waiting");

  return (
    <section id="extension" aria-labelledby={`${id}-h`} className="grid max-w-2xl scroll-mt-20 gap-4">
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Chrome extension
        </h2>
        <p className="text-muted-foreground text-sm">
          The extension fills job application forms from your profile and the answers you mark reviewed. It never
          submits a form. Pair it once with a code from here.
        </p>
      </div>
      <Button
        className="justify-self-start"
        disabled={create.isPending}
        onClick={() => create.mutate(undefined, { onSuccess: setCreated, onError })}
      >
        {create.isPending ? "Creating code…" : createdNow ? "Create a new code" : "Create pairing code"}
      </Button>
      {created && createdNow && (
        <NewCode created={created} pairing={createdNow} now={now} onDone={() => setCreated(null)} />
      )}
      <div className="grid gap-2">
        <h3 className="font-medium text-sm">Pairings</h3>
        <Pairings pairings={pairings} now={now} onRevoke={setConfirming} />
      </div>
      <RevokeDialog pairing={confirming} onClose={() => setConfirming(null)} />
    </section>
  );
}

function Pairings({
  pairings,
  now,
  onRevoke,
}: {
  pairings: ReturnType<typeof usePairings>;
  now: number;
  onRevoke: (pairing: PairingDto) => void;
}) {
  if (pairings.isPending) return <p className="text-muted-foreground text-sm">Loading pairings…</p>;
  if (pairings.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm">
        <span>Could not load pairings. {errorMessage(pairings.error)}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => pairings.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const list = pairings.data.pairings;
  if (list.length === 0) return <p className="text-muted-foreground text-sm">No extension paired yet.</p>;
  return (
    <ul aria-label="Extension pairings" className="divide-y border-y">
      {list.map((p) => (
        <PairingRow key={p.id} pairing={p} now={now} onRevoke={onRevoke} />
      ))}
    </ul>
  );
}

/** Confirm before a revoke: it cannot be undone, only replaced by pairing again. */
function RevokeDialog({ pairing, onClose }: { pairing: PairingDto | null; onClose: () => void }) {
  const revoke = useRevokePairing();
  return (
    <AlertDialog open={pairing !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this pairing?</AlertDialogTitle>
          <AlertDialogDescription>
            {pairing?.status === "active"
              ? "The extension stops working with Hanapbuhay right away. To use it again, pair it with a new code."
              : "The code stops working right away."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (pairing) revoke.mutate(pairing.id, { onSuccess: () => toast("Pairing revoked."), onError });
              onClose();
            }}
          >
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
