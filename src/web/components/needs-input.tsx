import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { GateBlocker, GateResult, OutputId } from "@/shared/api";
import type { MustAnswer } from "@/shared/enums";
import { blockerLabel, mustAnswerLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { useUpdateProfile } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Saves a reusable answer to the profile, which clears this blocker on every job at once. */
function ProfileAnswerForm({ category }: { category: MustAnswer }) {
  const id = useId();
  const [value, setValue] = useState("");
  const update = useUpdateProfile();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    update.mutate(
      { standardAnswers: { [category]: value.trim() } },
      {
        onSuccess: () => toast(`Saved to your profile. ${mustAnswerLabel(category)} now answers on every job.`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }
  return (
    <form onSubmit={submit} className="mt-2 flex gap-2">
      <label htmlFor={id} className="sr-only">
        {mustAnswerLabel(category)} for your profile
      </label>
      <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your answer" />
      <Button type="submit" variant="secondary" size="sm" className="h-9" disabled={update.isPending || !value.trim()}>
        Save to profile
      </Button>
    </form>
  );
}

function BlockerRow({ blocker, onJump }: { blocker: GateBlocker; onJump: (id: OutputId) => void }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <p className="text-sm">{blockerLabel(blocker)}</p>
      {blocker.kind === "must_answer" ? (
        <ProfileAnswerForm category={blocker.category} />
      ) : (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => onJump(blocker.outputId)}>
          Go to it
        </Button>
      )}
    </li>
  );
}

/** The gate's blocker list (section 3.5). Export and Mark ready stay disabled until it is empty. */
export function NeedsInput({ gate, onJump }: { gate: GateResult; onJump: (id: OutputId) => void }) {
  if (gate.ok) {
    return (
      <section aria-labelledby="needs-input" className="rounded-lg border p-4">
        <h2 id="needs-input" className="font-medium text-sm">
          Needs your input
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">Nothing. Every included file and answer is filled in.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="needs-input" className="rounded-lg border border-warning/40 bg-warning-surface p-4">
      <h2 id="needs-input" className="font-medium text-sm text-warning-foreground">
        Needs your input <span className="tabular-nums">({gate.blockers.length})</span>
      </h2>
      <ul className="mt-3 divide-y divide-warning/25">
        {gate.blockers.map((b) => (
          <BlockerRow key={`${b.kind}:${b.outputId}:${"text" in b ? b.text : ""}`} blocker={b} onJump={onJump} />
        ))}
      </ul>
    </section>
  );
}
