import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { Contact, FactDto, ProfileDto, StandardAnswers } from "@/shared/api";
import { MUST_ANSWERS } from "@/shared/enums";
import { mustAnswerLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import {
  useConfirmAllFacts,
  useConfirmFact,
  useDeleteFact,
  usePasteCv,
  useProfile,
  useUpdateFact,
  useUpdateProfile,
} from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";

const onError = (error: unknown) => toast.error(errorMessage(error));

function ContactForm({ contact }: { contact: Contact }) {
  const id = useId();
  const update = useUpdateProfile();
  const [form, setForm] = useState({ ...contact, links: contact.links.join("\n") });
  const fields = [
    { key: "fullName", label: "Full name", type: "text", autoComplete: "name" },
    { key: "email", label: "Email", type: "email", autoComplete: "email" },
    { key: "phone", label: "Phone", type: "tel", autoComplete: "tel" },
    { key: "location", label: "Location", type: "text", autoComplete: "address-level2" },
  ] as const;

  function submit(event: FormEvent) {
    event.preventDefault();
    const links = form.links
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    update.mutate({ contact: { ...form, links } }, { onSuccess: () => toast("Contact details saved."), onError });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Contact
        </h2>
        <p className="text-muted-foreground text-sm">The header of every PDF you export.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="grid gap-2">
            <Label htmlFor={`${id}-${f.key}`}>{f.label}</Label>
            <Input
              id={`${id}-${f.key}`}
              type={f.type}
              autoComplete={f.autoComplete}
              value={form[f.key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-links`}>Links, one per line</Label>
        <Textarea
          id={`${id}-links`}
          className="min-h-20"
          value={form.links}
          onChange={(e) => setForm((prev) => ({ ...prev, links: e.target.value }))}
        />
      </div>
      <Button type="submit" className="justify-self-start" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save contact"}
      </Button>
    </form>
  );
}

function StandardAnswersForm({ answers }: { answers: StandardAnswers }) {
  const id = useId();
  const update = useUpdateProfile();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(MUST_ANSWERS.map((k) => [k, answers[k] ?? ""])),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { standardAnswers: Object.fromEntries(MUST_ANSWERS.map((k) => [k, form[k] ?? ""])) },
      { onSuccess: () => toast("Standard answers saved. Every job uses them."), onError },
    );
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Standard answers
        </h2>
        <p className="text-muted-foreground text-sm">
          Questions about salary, work authorization, notice, start date and references are never drafted for you.
          Answer them once here.
        </p>
      </div>
      {MUST_ANSWERS.map((k) => (
        <div key={k} className="grid gap-2">
          <Label htmlFor={`${id}-${k}`}>{mustAnswerLabel(k)}</Label>
          <Input
            id={`${id}-${k}`}
            value={form[k] ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, [k]: e.target.value }))}
          />
        </div>
      ))}
      <Button type="submit" className="justify-self-start" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save answers"}
      </Button>
    </form>
  );
}

function CvForm({ cv }: { cv: ProfileDto["cv"] }) {
  const id = useId();
  const paste = usePasteCv();
  const [text, setText] = useState(cv?.text ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    paste.mutate(text, { onSuccess: () => toast("CV saved. Review the new facts below."), onError });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          CV
        </h2>
        <p className="text-muted-foreground text-sm">
          Paste your CV as text. Each bullet and sentence becomes a fact for you to confirm.
        </p>
      </div>
      <Label htmlFor={`${id}-cv`} className="sr-only">
        CV text
      </Label>
      <Textarea
        id={`${id}-cv`}
        className="max-h-[60vh] min-h-48 font-serif"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste your CV here"
      />
      <Button type="submit" className="justify-self-start" disabled={paste.isPending || !text.trim()}>
        {paste.isPending ? "Reading your CV…" : cv ? "Save and update facts" : "Save and split into facts"}
      </Button>
    </form>
  );
}

function FactRow({ fact }: { fact: FactDto }) {
  const confirm = useConfirmFact();
  const remove = useDeleteFact();
  const update = useUpdateFact();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);
  const busy = confirm.isPending || remove.isPending || update.isPending;

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <span className="w-16 shrink-0 pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">{fact.key}</span>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ id: fact.id, text }, { onSuccess: () => setEditing(false), onError });
          }}
        >
          <Input aria-label={`Edit ${fact.key}`} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <Button type="submit" size="sm" className="h-9" disabled={busy || !text.trim()}>
            Save
          </Button>
        </form>
      ) : (
        <p className="min-w-0 flex-1 text-sm">{fact.text}</p>
      )}
      <div className="flex gap-1">
        {fact.status === "pending" && !editing && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirm.mutate(fact.id, { onError })}>
            Confirm
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing((e) => !e)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(fact.id, { onError })}>
          {fact.status === "pending" ? "Discard" : "Delete"}
        </Button>
      </div>
    </li>
  );
}

function Facts({ facts }: { facts: FactDto[] }) {
  const confirmAll = useConfirmAllFacts();
  const pending = facts.filter((f) => f.status === "pending");
  const confirmed = facts.filter((f) => f.status === "confirmed");
  return (
    <section aria-labelledby="facts-h" className="grid max-w-3xl gap-6">
      <div>
        <h2 id="facts-h" className="font-semibold text-lg">
          Facts
        </h2>
        <p className="text-muted-foreground text-sm">
          Only confirmed facts can be cited. Cite one in a file by writing its key, like [FACT-1].
        </p>
      </div>
      {facts.length === 0 && <p className="text-muted-foreground text-sm">No facts yet. Paste your CV above.</p>}
      {pending.length > 0 && (
        <div>
          <div className="flex items-center gap-3">
            <h3 id="pending-h" className="font-medium text-sm">
              To review <span className="text-muted-foreground tabular-nums">{pending.length}</span>
            </h3>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={confirmAll.isPending}
              onClick={() => confirmAll.mutate(undefined, { onError })}
            >
              Confirm all
            </Button>
          </div>
          <ul className="mt-2 divide-y border-y" aria-label="Facts to review">
            {pending.map((f) => (
              <FactRow key={f.id} fact={f} />
            ))}
          </ul>
        </div>
      )}
      {confirmed.length > 0 && (
        <div>
          <h3 className="font-medium text-sm">
            Confirmed <span className="text-muted-foreground tabular-nums">{confirmed.length}</span>
          </h3>
          <ul className="mt-2 divide-y border-y" aria-label="Confirmed facts">
            {confirmed.map((f) => (
              <FactRow key={f.id} fact={f} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ProfilePage() {
  const profile = useProfile();
  if (profile.isPending) return <p className="text-muted-foreground">Loading your profile…</p>;
  if (profile.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
        <span>Could not load your profile. {errorMessage(profile.error)}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => profile.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const { contact, standardAnswers, cv, facts } = profile.data;
  return (
    <div className="grid gap-10">
      <h1 className="font-semibold text-2xl tracking-tight">Profile</h1>
      <ContactForm contact={contact} />
      <Separator />
      <CvForm key={cv?.rev ?? 0} cv={cv} />
      <Facts facts={facts} />
      <Separator />
      <StandardAnswersForm answers={standardAnswers} />
    </div>
  );
}
