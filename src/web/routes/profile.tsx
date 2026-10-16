import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AddonInput,
  type Contact,
  type FactDto,
  type OverCapDetails,
  type ProfileDto,
  type ProfileItemDto,
  type StandardAnswers,
} from "@/shared/api";
import { ADDON_KINDS, AddonKind, ITEM_USAGES, ItemUsage, MUST_ANSWERS } from "@/shared/enums";
import { itemKindLabel, itemUsageLabel, mustAnswerLabel } from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import {
  useConfirmAllFacts,
  useConfirmFact,
  useCreateAddon,
  useDeleteAddon,
  useDeleteFact,
  useKeepFact,
  usePasteCv,
  useProfile,
  useRetrySplit,
  useUpdateAddon,
  useUpdateFact,
  useUpdateProfile,
  useUploadCv,
} from "../queries";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
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

// ---------- Over-cap confirmation ----------

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Saving a CV or add-on with an AI key can return `402 over_cap`. `onError(again)` opens the
 * confirmation; "Split anyway" calls `again`, which repeats the request with `confirmOverCap`.
 */
function useOverCap(): { onError: (again: () => void) => (error: unknown) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ details: OverCapDetails; again: () => void } | null>(null);
  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Go over your monthly cap?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              <p>Splitting this text into facts with AI would take this month's spend past the cap you set.</p>
              {pending && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-foreground tabular-nums">
                  <dt className="text-muted-foreground">Spent this month</dt>
                  <dd>{usd(pending.details.monthUsd)}</dd>
                  <dt className="text-muted-foreground">This split, at most</dt>
                  <dd>{usd(pending.details.estimateUsd)}</dd>
                  <dt className="text-muted-foreground">Your cap</dt>
                  <dd>{usd(pending.details.capUsd)}</dd>
                </dl>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Link to="/settings">Change the cap</Link>
          </AlertDialogCancel>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              pending?.again();
              setPending(null);
            }}
          >
            Split anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return {
    onError: (again) => (error) => {
      const details = error instanceof ApiError ? error.overCap : null;
      if (details) setPending({ details, again });
      else toast.error(errorMessage(error));
    },
    dialog,
  };
}

// ---------- Split status ----------

/** The split task's state: its step while running, its error with Retry after a failure. */
function SplitStatus({ item, what }: { item: ProfileItemDto; what: string }) {
  const retry = useRetrySplit();
  const overCap = useOverCap();
  const task = item.splitTask;
  if (!task) return null;

  const run = (confirmOverCap: boolean) =>
    retry.mutate(
      { id: task.id, confirmOverCap },
      { onError: overCap.onError(() => run(true)), onSuccess: () => toast(`Splitting ${what} again.`) },
    );

  switch (task.status) {
    case "running":
      return (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {task.step || `Splitting ${what} into facts`}…
        </p>
      );
    case "failed":
    case "interrupted":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-destructive">
            {task.status === "interrupted"
              ? `Splitting ${what} stopped because the app restarted.`
              : (task.error ?? `Splitting ${what} failed.`)}
          </span>
          <Button size="sm" variant="outline" onClick={() => run(false)} disabled={retry.isPending}>
            Retry
          </Button>
          {overCap.dialog}
        </div>
      );
    case "done":
      return null;
    default: {
      const _exhaustive: never = task.status;
      return _exhaustive;
    }
  }
}

// ---------- CV ----------

const CV_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function CvForm({ cv, aiReady }: { cv: ProfileDto["cv"]; aiReady: boolean }) {
  const id = useId();
  const paste = usePasteCv();
  const upload = useUploadCv();
  const overCap = useOverCap();
  const [text, setText] = useState(cv?.body ?? "");
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const splitting = cv?.splitTask?.status === "running";
  const busy = paste.isPending || upload.isPending;

  function savePaste(confirmOverCap: boolean) {
    paste.mutate(
      { text, confirmOverCap },
      { onSuccess: () => toast("CV saved. Its facts appear below."), onError: overCap.onError(() => savePaste(true)) },
    );
  }

  function sendFile(file: File, confirmOverCap: boolean) {
    setUploadProblem(null);
    upload.mutate(
      { file, confirmOverCap },
      {
        onSuccess: () => toast(`Read ${file.name}. Its facts appear below.`),
        onError: (error) => {
          if (error instanceof ApiError && error.overCap) return overCap.onError(() => sendFile(file, true))(error);
          setUploadProblem(errorMessage(error));
          textRef.current?.focus();
        },
        onSettled: () => {
          if (fileRef.current) fileRef.current.value = "";
        },
      },
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim()) savePaste(false);
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          CV
        </h2>
        <p className="text-muted-foreground text-sm">
          Upload your CV or paste it as text. {aiReady ? "AI splits it" : "It is split"} into short facts for you to
          confirm. The file itself is not kept.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-file`}>Upload a PDF or DOCX</Label>
        <Input
          ref={fileRef}
          id={`${id}-file`}
          type="file"
          accept={CV_ACCEPT}
          disabled={busy}
          className="max-w-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) sendFile(file, false);
          }}
        />
        {cv?.fileName && !upload.isPending && (
          <p className="text-muted-foreground text-xs">Last read from {cv.fileName}.</p>
        )}
        {upload.isPending && (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            Reading your CV…
          </p>
        )}
        {uploadProblem && (
          <p role="alert" className="text-destructive text-sm">
            {uploadProblem}
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-cv`}>Or paste it</Label>
        <Textarea
          ref={textRef}
          id={`${id}-cv`}
          aria-label="CV text"
          className="max-h-[60vh] min-h-48 font-serif"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste your CV here"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={busy || splitting || !text.trim()}>
          {paste.isPending ? "Reading your CV…" : cv ? "Save and update facts" : "Save and split into facts"}
        </Button>
        {cv && <SplitStatus item={cv} what="your CV" />}
      </div>
      {overCap.dialog}
    </form>
  );
}

// ---------- Facts ----------

function FactRow({ fact, showSource }: { fact: FactDto; showSource: boolean }) {
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
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-sm">{fact.text}</p>
          {(showSource || fact.usage === "letters_only") && (
            <p className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
              {showSource && <span>From {fact.itemKind === "cv" ? "your CV" : fact.itemTitle}</span>}
              {fact.usage === "letters_only" && <span>Letters and answers only</span>}
            </p>
          )}
        </div>
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

/** A confirmed fact the latest split of its item did not produce. */
function VanishedRow({ fact }: { fact: FactDto }) {
  const keep = useKeepFact();
  const remove = useDeleteFact();
  const busy = keep.isPending || remove.isPending;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <span className="w-16 shrink-0 pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">{fact.key}</span>
      <p className="min-w-0 flex-1 text-sm">{fact.text}</p>
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => keep.mutate(fact.id, { onError })}>
          Keep
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(fact.id, { onError })}>
          Delete
        </Button>
      </div>
    </li>
  );
}

function vanishedHeading(item: ProfileItemDto): string {
  return item.kind === "cv" ? "Not in your latest CV" : `Not in the latest version of ${item.title}`;
}

function Facts({ profile }: { profile: ProfileDto }) {
  const confirmAll = useConfirmAllFacts();
  const { facts, skillsFound } = profile;
  const items = [...(profile.cv ? [profile.cv] : []), ...profile.addons];
  // While an item is being split, its facts' `inLatest` is about to change; wait for the result.
  const settled = new Set(items.filter((i) => i.splitTask?.status !== "running").map((i) => i.id));
  const isVanished = (f: FactDto) => f.status === "confirmed" && !f.inLatest && settled.has(f.itemId);
  const pending = facts.filter((f) => f.status === "pending");
  const confirmed = facts.filter((f) => f.status === "confirmed" && !isVanished(f));
  const vanished = items
    .map((item) => ({ item, facts: facts.filter((f) => f.itemId === item.id && isVanished(f)) }))
    .filter((group) => group.facts.length > 0);
  const showSource = profile.addons.length > 0;

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
      {facts.length === 0 && (
        <p className="text-muted-foreground text-sm">No facts yet. Upload or paste your CV above.</p>
      )}
      {pending.length > 0 && (
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-medium text-sm">
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
              <FactRow key={f.id} fact={f} showSource={showSource} />
            ))}
          </ul>
        </div>
      )}
      {vanished.map(({ item, facts: group }) => (
        <div key={item.id}>
          <h3 className="font-medium text-sm">
            {vanishedHeading(item)} <span className="text-muted-foreground tabular-nums">{group.length}</span>
          </h3>
          <p className="text-muted-foreground text-sm">
            You confirmed these, but the text you saved last no longer has them. Keep them, or delete them.
          </p>
          <ul className="mt-2 divide-y border-y" aria-label={vanishedHeading(item)}>
            {group.map((f) => (
              <VanishedRow key={f.id} fact={f} />
            ))}
          </ul>
        </div>
      ))}
      {confirmed.length > 0 && (
        <div>
          <h3 className="font-medium text-sm">
            Confirmed <span className="text-muted-foreground tabular-nums">{confirmed.length}</span>
          </h3>
          <ul className="mt-2 divide-y border-y" aria-label="Confirmed facts">
            {confirmed.map((f) => (
              <FactRow key={f.id} fact={f} showSource={showSource} />
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 id="skills-h" className="font-medium text-sm">
          Skills found in your confirmed facts
        </h3>
        {skillsFound.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Skills found">
            {skillsFound.map((skill) => (
              <li key={skill}>
                <Badge variant="secondary">{skill}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            None yet. A skill counts for matching once a confirmed fact names it.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------- Add-ons ----------

type AddonForm = {
  kind: AddonKind;
  title: string;
  body: string;
  happenedOn: string;
  link: string;
  skills: string;
  usage: ItemUsage;
};

const EMPTY_ADDON: AddonForm = {
  kind: "experience",
  title: "",
  body: "",
  happenedOn: "",
  link: "",
  skills: "",
  usage: "everywhere",
};

function toForm(item: ProfileItemDto): AddonForm {
  return {
    kind: AddonKind.safeParse(item.kind).data ?? "other",
    title: item.title,
    body: item.body,
    happenedOn: item.happenedOn ?? "",
    link: item.link ?? "",
    skills: item.skills.join(", "),
    usage: item.usage,
  };
}

function problemOf(error: { issues: { path: PropertyKey[] }[] }): string {
  const field = error.issues[0]?.path[0];
  switch (field) {
    case "title":
      return "Give it a title.";
    case "body":
      return "Describe what you did. That text is what gets split into facts.";
    case "link":
      return "The link must start with http:// or https://. Leave it empty if you have none.";
    case "happenedOn":
      return "Pick a date, or leave it empty.";
    case "skills":
      return "List up to 30 skills, separated by commas, each under 60 characters.";
    default:
      return "Check the fields and try again.";
  }
}

function AddonDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to add a new add-on. */
  item: ProfileItemDto | null;
}) {
  const id = useId();
  const create = useCreateAddon();
  const update = useUpdateAddon();
  const overCap = useOverCap();
  const [form, setForm] = useState<AddonForm>(item ? toForm(item) : EMPTY_ADDON);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;
  const set = (field: keyof AddonForm) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  function save(confirmOverCap: boolean) {
    const parsed = AddonInput.safeParse({
      kind: form.kind,
      title: form.title,
      body: form.body,
      happenedOn: form.happenedOn || null,
      link: form.link.trim() || null,
      skills: form.skills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      usage: form.usage,
      confirmOverCap,
    });
    if (!parsed.success) {
      setProblem(problemOf(parsed.error));
      return;
    }
    setProblem(null);
    const done = {
      onSuccess: () => {
        toast(item ? "Add-on saved." : "Add-on saved. Its facts appear under Facts to review.");
        onOpenChange(false);
      },
      onError: overCap.onError(() => save(true)),
    };
    if (item) update.mutate({ id: item.id, ...parsed.data }, done);
    else create.mutate(parsed.data, done);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit add-on" : "Add an add-on"}</DialogTitle>
          <DialogDescription>
            Something that is not on your CV. Saving splits it into facts for you to confirm.
          </DialogDescription>
        </DialogHeader>
        <form
          id={id}
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium text-sm">Kind</legend>
            <RadioGroup
              value={form.kind}
              onValueChange={(value) => {
                const kind = AddonKind.safeParse(value);
                if (kind.success) setForm((f) => ({ ...f, kind: kind.data }));
              }}
              className="flex flex-wrap gap-x-6 gap-y-2"
            >
              {ADDON_KINDS.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <RadioGroupItem value={k} id={`${id}-kind-${k}`} />
                  <Label htmlFor={`${id}-kind-${k}`} className="font-normal">
                    {itemKindLabel(k)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-title`}>Title</Label>
            <Input
              id={`${id}-title`}
              value={form.title}
              onChange={(e) => set("title")(e.target.value)}
              placeholder="Mentoring at a coding bootcamp"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-body`}>What you did</Label>
            <Textarea
              id={`${id}-body`}
              className="min-h-32"
              value={form.body}
              onChange={(e) => set("body")(e.target.value)}
              placeholder="One line per thing you did, with numbers where you have them"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-date`}>Date (optional)</Label>
              <Input
                id={`${id}-date`}
                type="date"
                value={form.happenedOn}
                onChange={(e) => set("happenedOn")(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-link`}>Link (optional)</Label>
              <Input
                id={`${id}-link`}
                type="url"
                inputMode="url"
                value={form.link}
                onChange={(e) => set("link")(e.target.value)}
                placeholder="https://"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-skills`}>Skills, separated by commas (optional)</Label>
            <Input id={`${id}-skills`} value={form.skills} onChange={(e) => set("skills")(e.target.value)} />
            <p className="text-muted-foreground text-xs">
              Context for the split only. A skill counts for matching once a confirmed fact names it.
            </p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium text-sm">Use it in</legend>
            <RadioGroup
              value={form.usage}
              onValueChange={(value) => {
                const usage = ItemUsage.safeParse(value);
                if (usage.success) setForm((f) => ({ ...f, usage: usage.data }));
              }}
              className="grid gap-2"
            >
              {ITEM_USAGES.map((u) => (
                <div key={u} className="flex items-center gap-2">
                  <RadioGroupItem value={u} id={`${id}-usage-${u}`} />
                  <Label htmlFor={`${id}-usage-${u}`} className="font-normal">
                    {itemUsageLabel(u)}
                    {u === "letters_only" && <span className="text-muted-foreground"> (never on your resume)</span>}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          {problem && (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={id} disabled={busy}>
            {busy ? "Saving…" : item ? "Save add-on" : "Save and split into facts"}
          </Button>
        </DialogFooter>
        {overCap.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** The link's host as its visible text, so a screen reader hears where it goes. */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

function AddonRow({ item, factCount, onEdit }: { item: ProfileItemDto; factCount: number; onEdit: () => void }) {
  const remove = useDeleteAddon();
  const [confirming, setConfirming] = useState(false);
  const meta = [itemKindLabel(item.kind), item.happenedOn, item.usage === "letters_only" ? "Letters only" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="grid gap-2 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="font-medium text-sm">{item.title}</p>
          <p className="text-muted-foreground text-xs">
            {meta}
            {item.link && (
              <>
                {" · "}
                <a href={item.link} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {hostOf(item.link)}
                </a>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        </div>
      </div>
      <SplitStatus item={item} what={item.title} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {item.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {factCount === 1 ? "Its fact is" : `Its ${factCount} facts are`} deleted with it. Files that cite them
              will ask you to fix those lines.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate(item.id, { onSuccess: () => toast(`Deleted ${item.title}.`), onError })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function Addons({ addons, facts }: { addons: ProfileItemDto[]; facts: FactDto[] }) {
  // `key` remounts the dialog's form for each open, so it starts from the item being edited.
  const [dialog, setDialog] = useState<{ item: ProfileItemDto | null; key: number } | null>(null);
  const open = (item: ProfileItemDto | null) => setDialog({ item, key: Date.now() });
  return (
    <section aria-labelledby="addons-h" className="grid max-w-3xl gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="addons-h" className="font-semibold text-lg">
            Add-ons
          </h2>
          <p className="text-muted-foreground text-sm">
            Work, open source, challenges and anything else your CV leaves out.
          </p>
        </div>
        <Button variant="outline" onClick={() => open(null)}>
          Add an add-on
        </Button>
      </div>
      {addons.length > 0 && (
        <ul className="divide-y border-y" aria-label="Add-ons">
          {addons.map((item) => (
            <AddonRow
              key={item.id}
              item={item}
              factCount={facts.filter((f) => f.itemId === item.id).length}
              onEdit={() => open(item)}
            />
          ))}
        </ul>
      )}
      {dialog && (
        <AddonDialog
          key={dialog.key}
          open
          item={dialog.item}
          onOpenChange={(isOpen) => {
            if (!isOpen) setDialog(null);
          }}
        />
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
  const { contact, standardAnswers, cv, addons, facts, aiReady } = profile.data;
  return (
    <div className="grid gap-10">
      <h1 className="font-semibold text-2xl tracking-tight">Profile</h1>
      <ContactForm contact={contact} />
      <Separator />
      <CvForm key={cv?.rev ?? 0} cv={cv} aiReady={aiReady} />
      <Facts profile={profile.data} />
      <Separator />
      <Addons addons={addons} facts={facts} />
      <Separator />
      <StandardAnswersForm answers={standardAnswers} />
    </div>
  );
}
