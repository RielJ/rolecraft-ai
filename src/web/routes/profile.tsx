import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, FolderGit2Icon, LockIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AddonInput,
  type AddonPrefillDto,
  type Contact,
  type FactDto,
  type GithubReadSummary,
  type LocalHideReason,
  MAX_PROJECTS_PER_ADD,
  MAX_STORED_CV_BYTES,
  type OverCapDetails,
  type ProfileDto,
  type ProfileItemDto,
  type ProjectScanDto,
  type RepoHideReason,
  type ScannedFolderDto,
  type ScannedRepoDto,
  type StandardAnswers,
  type Targeting,
  Targeting as TargetingSchema,
} from "@/shared/api";
import {
  ADDON_KINDS,
  AddonKind,
  hasRoles,
  ITEM_USAGES,
  ItemUsage,
  MUST_ANSWERS,
  PAY_PERIODS,
  PayPeriod,
  ROLE_FAMILIES,
  type RoleFamily,
  USER_SENIORITIES,
  UserSeniority,
} from "@/shared/enums";
import {
  itemKindLabel,
  itemUsageLabel,
  mustAnswerLabel,
  payPeriodLabel,
  roleFamilyLabel,
  userSeniorityLabel,
} from "@/shared/labels";
import { ApiError, errorMessage } from "../api";
import { CvPreviewDialog } from "../components/cv-preview-dialog";
import { FileDropZone } from "../components/file-drop-zone";
import { RolesEditor, rolesKey } from "../components/roles-editor";
import { type PageSection, SaveRow, SectionHeading, SectionPage } from "../components/section-page";
import { SetupChecklist } from "../components/setup-checklist";
import { SkillsForMatching } from "../components/skills-for-matching";
import { cn } from "../lib/utils";
import {
  useAddProjects,
  useConfirmAllFacts,
  useConfirmFact,
  useCreateAddon,
  useDeleteAddon,
  useDeleteFact,
  useKeepFact,
  usePasteCv,
  usePrefillAddon,
  useProfile,
  useProjectScan,
  useReadGithub,
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
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const onError = (error: unknown) => toast.error(errorMessage(error));

function ContactForm({ contact }: { contact: Contact }) {
  const id = useId();
  const update = useUpdateProfile();
  const [saved] = useState(() => ({ ...contact, links: contact.links.join(", ") }));
  const [form, setForm] = useState(saved);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const fields = [
    { key: "fullName", label: "Full name", type: "text", autoComplete: "name" },
    { key: "email", label: "Email", type: "email", autoComplete: "email" },
    { key: "phone", label: "Phone", type: "tel", autoComplete: "tel" },
    { key: "location", label: "Location", type: "text", autoComplete: "address-level2" },
  ] as const;

  function submit(event: FormEvent) {
    event.preventDefault();
    const links = form.links.split(/[\s,]+/).filter(Boolean);
    update.mutate({ contact: { ...form, links } }, { onSuccess: () => toast("Contact details saved."), onError });
  }

  return (
    <form onSubmit={submit} className="grid gap-5" aria-labelledby={`${id}-h`}>
      <SectionHeading
        id={`${id}-h`}
        title="Contact"
        description="The header of every PDF you export. Empty fields fill in from your CV when you save it."
      />
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
        <Label htmlFor={`${id}-links`}>Links</Label>
        <Input
          id={`${id}-links`}
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://github.com/you, https://you.dev"
          aria-describedby={`${id}-links-hint`}
          value={form.links}
          onChange={(e) => setForm((prev) => ({ ...prev, links: e.target.value }))}
        />
        <p id={`${id}-links-hint`} className="text-muted-foreground text-xs">
          Separate links with commas.
        </p>
      </div>
      <SaveRow dirty={dirty} pending={update.isPending} label="Save contact" />
    </form>
  );
}

function StandardAnswersForm({ answers }: { answers: StandardAnswers }) {
  const id = useId();
  const update = useUpdateProfile();
  const [saved] = useState<Record<string, string>>(() =>
    Object.fromEntries(MUST_ANSWERS.map((k) => [k, answers[k] ?? ""])),
  );
  const [form, setForm] = useState(saved);
  const dirty = MUST_ANSWERS.some((k) => form[k] !== saved[k]);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { standardAnswers: Object.fromEntries(MUST_ANSWERS.map((k) => [k, form[k] ?? ""])) },
      { onSuccess: () => toast("Standard answers saved. Every job uses them."), onError },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-5" aria-labelledby={`${id}-h`}>
      <SectionHeading
        id={`${id}-h`}
        title="Standard answers"
        description="Questions about salary, work authorization, notice, start date and references are never drafted for you. Answer them once here."
      />
      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>
      <SaveRow dirty={dirty} pending={update.isPending} label="Save answers" />
    </form>
  );
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The Select's value for "not set": Radix Select cannot hold an empty value. */
const NOT_SET = "none";

/** Profile's targeting fields as the form holds them: text until saved. */
type TargetingDraft = {
  titles: string;
  families: ReadonlySet<RoleFamily>;
  exclude: string;
  seniority: UserSeniority | null;
  years: string;
  payAmount: string;
  payCurrency: string;
  payPeriod: PayPeriod;
};

function draftOf(t: Targeting): TargetingDraft {
  return {
    titles: t.targetTitles.join("\n"),
    families: new Set(t.roleFamilies),
    exclude: t.excludeTitleWords.join("\n"),
    seniority: t.seniority,
    years: t.yearsExperience === null ? "" : String(t.yearsExperience),
    payAmount: t.minPay === null ? "" : String(t.minPay.amount),
    payCurrency: t.minPay?.currency ?? "PHP",
    payPeriod: t.minPay?.period ?? "month",
  };
}

/** The draft as the API takes it, checked with the API's own schema. Blank years or pay is "not set". */
function parseDraft(d: TargetingDraft) {
  return TargetingSchema.safeParse({
    targetTitles: lines(d.titles),
    roleFamilies: ROLE_FAMILIES.filter((f) => d.families.has(f)),
    excludeTitleWords: lines(d.exclude),
    seniority: d.seniority,
    yearsExperience: d.years.trim() === "" ? null : Number(d.years),
    minPay:
      d.payAmount.trim() === ""
        ? null
        : { amount: Number(d.payAmount.replace(/,/g, "")), currency: d.payCurrency, period: d.payPeriod },
  });
}

/**
 * What Refresh keeps (section 3.7a) and what matching reads about you (section 3.7). Target
 * titles are the keywords for built-in boards; role families and exclude words drop postings
 * that are surely not your role. Seniority and years mark roles above or below you; minimum pay
 * is where the Matches pay filter starts. Pasted and linked jobs skip the filter.
 */
function TargetingForm({ targeting }: { targeting: Targeting }) {
  const id = useId();
  const update = useUpdateProfile();
  const [saved] = useState(() => draftOf(targeting));
  const [draft, setDraft] = useState(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof TargetingDraft>(key: K, value: TargetingDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function toggle(family: RoleFamily, on: boolean) {
    const next = new Set(draft.families);
    if (on) next.add(family);
    else next.delete(family);
    set("families", next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseDraft(draft);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the fields above.");
      return;
    }
    setProblem(null);
    update.mutate(
      { targeting: parsed.data },
      { onSuccess: () => toast("Job targeting saved. The next Refresh uses it."), onError },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-6" aria-labelledby={`${id}-h`}>
      <SectionHeading
        id={`${id}-h`}
        title="Job targeting"
        description="Refresh keeps postings that fit. A posting is dropped only when it is surely another kind of role; anything unclear is kept."
      />
      <div className="grid items-start gap-x-4 gap-y-6 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-titles`}>Target titles, one per line</Label>
          <Textarea
            id={`${id}-titles`}
            className="max-h-64 min-h-32"
            value={draft.titles}
            onChange={(e) => set("titles", e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            For example "Frontend engineer". Built-in boards keep postings whose title or tags have one of these words.
            Blank keeps every posting.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-exclude`}>Exclude title words, one per line</Label>
          <Textarea
            id={`${id}-exclude`}
            className="max-h-64 min-h-32"
            value={draft.exclude}
            onChange={(e) => set("exclude", e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            For example "Intern". A title with one of these is always dropped.
          </p>
        </div>
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-3 font-medium text-sm">Role families</legend>
        <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 md:grid-cols-3">
          {ROLE_FAMILIES.map((family) => (
            <div key={family} className="flex items-center gap-2">
              <Checkbox
                id={`${id}-fam-${family}`}
                checked={draft.families.has(family)}
                onCheckedChange={(checked) => toggle(family, checked === true)}
              />
              <Label htmlFor={`${id}-fam-${family}`} className="font-normal">
                {roleFamilyLabel(family)}
              </Label>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">None picked means only the exclude words drop postings.</p>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-seniority`}>Seniority</Label>
          <Select
            value={draft.seniority ?? NOT_SET}
            onValueChange={(v) => {
              const parsed = UserSeniority.safeParse(v);
              set("seniority", parsed.success ? parsed.data : null);
            }}
          >
            <SelectTrigger id={`${id}-seniority`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NOT_SET}>Not set</SelectItem>
              {USER_SENIORITIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {userSeniorityLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-years`}>Years of experience</Label>
          <Input
            id={`${id}-years`}
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            step={1}
            className="tabular-nums"
            value={draft.years}
            onChange={(e) => set("years", e.target.value)}
          />
        </div>
        <p className="text-muted-foreground text-xs sm:col-span-2">
          Roles two or more levels from yours, or asking for more than a year beyond your experience, are not marked
          Strong. Leave blank to skip the check.
        </p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-medium text-sm">Minimum pay</legend>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-pay`} className="sr-only">
            Minimum pay amount
          </Label>
          <Input
            id={`${id}-pay`}
            inputMode="decimal"
            placeholder="Not set"
            className="w-36 tabular-nums"
            value={draft.payAmount}
            onChange={(e) => set("payAmount", e.target.value)}
          />
          <Label htmlFor={`${id}-pay-currency`} className="sr-only">
            Minimum pay currency
          </Label>
          <Input
            id={`${id}-pay-currency`}
            maxLength={3}
            autoCapitalize="characters"
            className="w-20 uppercase"
            value={draft.payCurrency}
            onChange={(e) => set("payCurrency", e.target.value)}
          />
          <Select
            value={draft.payPeriod}
            onValueChange={(v) => {
              const parsed = PayPeriod.safeParse(v);
              if (parsed.success) set("payPeriod", parsed.data);
            }}
          >
            <SelectTrigger aria-label="Minimum pay period" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAY_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {payPeriodLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">
          Matches starts its pay filter here. Jobs with no pay, or in a currency with no rate in Settings, are never
          hidden. Leave blank for no minimum.
        </p>
      </fieldset>
      <SaveRow dirty={dirty} pending={update.isPending} label="Save targeting">
        {problem && (
          <p role="alert" className="text-destructive text-sm">
            {problem}
          </p>
        )}
      </SaveRow>
    </form>
  );
}

// ---------- Over-cap confirmation ----------

const usd = (n: number) => `$${n.toFixed(2)}`;

type OverCapWords = { doing: string; noun: string; action: string };
const SPLIT_WORDS: OverCapWords = {
  doing: "Splitting this text into facts with AI",
  noun: "This split",
  action: "Split anyway",
};
const ROLES_WORDS: OverCapWords = {
  doing: "Reading the roles in this text with AI",
  noun: "This read",
  action: "Read anyway",
};
const ADD_PROJECTS_WORDS: OverCapWords = {
  doing: "Splitting these projects into facts with AI",
  noun: "These splits",
  action: "Add anyway",
};
const READ_WORDS: OverCapWords = {
  doing: "Reading this link from GitHub with AI",
  noun: "This read",
  action: "Read anyway",
};

/**
 * Saving a CV or add-on with an AI key can return `402 over_cap`. `onError(again)` opens the
 * confirmation; "Split anyway" calls `again`, which repeats the request with `confirmOverCap`.
 */
function useOverCap(words: OverCapWords = SPLIT_WORDS): {
  onError: (again: () => void) => (error: unknown) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{ details: OverCapDetails; again: () => void } | null>(null);
  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Go over your monthly cap?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              <p>{words.doing} would take this month's spend past the cap you set.</p>
              {pending && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-foreground tabular-nums">
                  <dt className="text-muted-foreground">Spent this month</dt>
                  <dd>{usd(pending.details.monthUsd)}</dd>
                  <dt className="text-muted-foreground">{words.noun}, at most</dt>
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
            {words.action}
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

// ---------- Roles (decision 71) ----------

/** The Roles list of the CV or an experience add-on, with its over-cap confirmation. */
function ItemRoles({ item, what, aiReady }: { item: ProfileItemDto; what: string; aiReady: boolean }) {
  const overCap = useOverCap(ROLES_WORDS);
  if (!hasRoles(item.kind)) return null;
  return (
    <>
      <RolesEditor key={rolesKey(item)} item={item} what={what} aiReady={aiReady} onOverCap={overCap.onError} />
      {overCap.dialog}
    </>
  );
}

// ---------- GitHub reads ----------

/** "1 file", "3 files"; `many` for words that don't just take an "s". */
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** What the last read did, in one line: what it read, as whom, and what changed. */
function readSummary(read: GithubReadSummary): string {
  const as = `as ${read.user} (from ${read.userFrom})`;
  const share = read.share ? ` (${read.share.mine} of ${read.share.total} are yours)` : "";
  const features = read.features.length ? `, grouped into ${plural(read.features.length, "feature")},` : "";
  const what = `Read ${plural(read.filesRead.length, "file")} and ${plural(read.commitsRead, "commit")}${share}${features} ${as}`;
  const changes = [
    read.added ? `${read.added} new` : null,
    read.unchanged ? `${read.unchanged} unchanged` : null,
    read.removed ? `${read.removed} removed` : null,
    read.vanished ? `${read.vanished} to keep or delete` : null,
  ].filter(Boolean);
  const dropped = read.dropped.length
    ? ` ${plural(read.dropped.length, "claim")} dropped: not backed by a file or commit it read.`
    : "";
  return `${what}: ${changes.length ? changes.join(", ") : "no facts"}.${dropped}`;
}

/**
 * Read from GitHub / Read for facts / Re-read, the read task's progress, and what the last read
 * did. A folder add-on is read with git on this machine (decision 81).
 */
function GithubRead({ item, aiReady }: { item: ProfileItemDto; aiReady: boolean }) {
  const read = useReadGithub();
  const retry = useRetrySplit();
  const overCap = useOverCap(READ_WORDS);
  const source = item.folder
    ? { ...item.folder, label: item.title, first: "Read for facts", lock: "Private project" }
    : item.github
      ? { ...item.github, first: "Read from GitHub", lock: "Private repo" }
      : null;
  if (!source) return null;
  const github = source;
  const task = github.readTask;
  const running = task?.status === "running" || read.isPending;
  const start = (confirmOverCap: boolean) =>
    read.mutate({ id: item.id, confirmOverCap }, { onError: overCap.onError(() => start(true)) });
  const again = (confirmOverCap: boolean) => {
    if (!task) return;
    retry.mutate(
      { id: task.id, confirmOverCap },
      { onError: overCap.onError(() => again(true)), onSuccess: () => toast(`Reading ${github.label} again.`) },
    );
  };
  const failed = task?.status === "failed" || task?.status === "interrupted";

  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!aiReady || running || retry.isPending}
          onClick={() => (failed ? again(false) : start(false))}
        >
          {failed ? "Retry the read" : github.lastRead ? "Re-read" : github.first}
        </Button>
        {github.private && (
          <Badge variant="outline" className="gap-1">
            <LockIcon aria-hidden className="size-3" />
            {github.lock}
          </Badge>
        )}
        {item.folder && (
          <span className="min-w-0 truncate font-mono text-muted-foreground text-xs" title={item.folder.path}>
            {item.folder.path}
          </span>
        )}
        {!aiReady && (
          <span className="text-muted-foreground">
            Reading a project needs AI.{" "}
            <Link to="/settings" className="underline underline-offset-4">
              Set it up in Settings
            </Link>
            .
          </span>
        )}
      </div>
      {task?.status === "running" && (
        <p className="text-muted-foreground" aria-live="polite">
          {task.step || `Reading ${github.label}`}…
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive">
          {task?.status === "interrupted"
            ? `Reading ${github.label} stopped because the app restarted.`
            : (task?.error ?? `Reading ${github.label} failed.`)}
        </p>
      )}
      {task?.status === "done" && github.lastRead && (
        <p className="text-muted-foreground">{readSummary(github.lastRead)}</p>
      )}
      {overCap.dialog}
    </div>
  );
}

// ---------- CV ----------

const CV_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CV_EXTENSIONS = [".pdf", ".docx"] as const;

const CONTACT_FIELD_NAMES: Record<keyof Contact, string> = {
  fullName: "name",
  email: "email",
  phone: "phone",
  location: "location",
  links: "links",
};

/** The contact fields a CV save filled: empty before, set after. */
function filledFields(before: Contact, after: Contact): string[] {
  return Object.entries(CONTACT_FIELD_NAMES).flatMap(([key, name]) =>
    String(before[key as keyof Contact]) === String(after[key as keyof Contact]) ? [] : [name],
  );
}

function readMessage(what: string, before: Contact, after: ProfileDto): string {
  const filled = filledFields(before, after.contact);
  const contactNote = filled.length > 0 ? ` Filled your ${filled.join(", ")} under Contact.` : "";
  return `${what} Its facts appear below.${contactNote}`;
}

function CvForm({
  cv,
  cvFile,
  facts,
  contact,
  aiReady,
}: {
  cv: ProfileDto["cv"];
  cvFile: ProfileDto["cvFile"];
  facts: FactDto[];
  contact: Contact;
  aiReady: boolean;
}) {
  const id = useId();
  const [viewing, setViewing] = useState(false);
  const viewRef = useRef<HTMLButtonElement>(null);
  const paste = usePasteCv();
  const upload = useUploadCv();
  const overCap = useOverCap();
  const [text, setText] = useState(cv?.body ?? "");
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A CV read from a file hides the paste box; it opens on request or when a file fails.
  const [pasting, setPasting] = useState(!cv?.fileName);
  const splitting = cv?.splitTask?.status === "running";
  const busy = paste.isPending || upload.isPending;

  function savePaste(confirmOverCap: boolean) {
    paste.mutate(
      { text, confirmOverCap },
      {
        onSuccess: (profile) => toast(readMessage("CV saved.", contact, profile)),
        onError: overCap.onError(() => savePaste(true)),
      },
    );
  }

  function sendFile(file: File, confirmOverCap: boolean) {
    setUploadProblem(null);
    upload.mutate(
      { file, confirmOverCap },
      {
        onSuccess: (profile) => {
          // A PDF over 5 MB is read, but its file is not kept (decision 69).
          const notKept = profile.cvFile === null && file.size > MAX_STORED_CV_BYTES;
          const what = notKept ? `Read ${file.name}. It is over 5 MB, so only its text is kept.` : `Read ${file.name}.`;
          toast(readMessage(what, contact, profile));
        },
        onError: (error) => {
          if (error instanceof ApiError && error.overCap) return overCap.onError(() => sendFile(file, true))(error);
          setUploadProblem(errorMessage(error));
          setPasting(true);
          requestAnimationFrame(() => textRef.current?.focus());
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
    <form onSubmit={submit} className="grid gap-5" aria-labelledby={`${id}-h`}>
      <SectionHeading
        id={`${id}-h`}
        title="CV"
        description={`Upload your CV or paste it as text. ${aiReady ? "AI splits it" : "It is split"} into short facts for you to confirm. A PDF up to 5 MB is kept so you can view it.`}
      />
      <div className="grid gap-2">
        <FileDropZone
          id={`${id}-file`}
          inputRef={fileRef}
          accept={CV_ACCEPT}
          extensions={CV_EXTENSIONS}
          kinds="PDF or DOCX"
          title={cv ? "Upload a new version of your CV" : "Upload your CV here"}
          busy={upload.isPending}
          busyLabel="Reading your CV…"
          disabled={busy || splitting}
          footer={
            cv?.fileName ? (
              <>
                Last read from {cv.fileName} ·{" "}
                <button
                  ref={viewRef}
                  type="button"
                  className="rounded-xs text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-label={`View ${cv.fileName}`}
                  onClick={() => setViewing(true)}
                >
                  View
                </button>
              </>
            ) : undefined
          }
          onFile={(file) => sendFile(file, false)}
          onReject={setUploadProblem}
        />
        {uploadProblem && (
          <p role="alert" className="text-destructive text-sm">
            {uploadProblem}
          </p>
        )}
      </div>
      {pasting ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-cv`}>Or paste it</Label>
            <Textarea
              ref={textRef}
              id={`${id}-cv`}
              aria-label="CV text"
              className="max-h-[60vh] min-h-48"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your CV here"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="submit" disabled={busy || splitting || !text.trim()}>
              {paste.isPending ? "Reading your CV…" : cv ? "Save and update facts" : "Save and split into facts"}
            </Button>
            {cv?.fileName && (
              <Button type="button" variant="ghost" onClick={() => setPasting(false)}>
                Cancel
              </Button>
            )}
            {cv && <SplitStatus item={cv} what="your CV" />}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="button" variant="link" className="h-auto px-0" onClick={() => setPasting(true)}>
            Paste the text instead
          </Button>
          {cv && <SplitStatus item={cv} what="your CV" />}
        </div>
      )}
      {overCap.dialog}
      {cv && (
        <CvPreviewDialog
          cv={cv}
          cvFile={cvFile}
          facts={facts}
          open={viewing}
          onOpenChange={setViewing}
          returnFocus={viewRef}
        />
      )}
    </form>
  );
}

// ---------- Facts ----------

function FactRow({
  fact,
  showSource,
  showSection = false,
}: {
  fact: FactDto;
  showSource: boolean;
  /** Outside a group, name the job or project the fact sits under. */
  showSection?: boolean;
}) {
  const confirm = useConfirmFact();
  const remove = useDeleteFact();
  const update = useUpdateFact();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);
  const busy = confirm.isPending || remove.isPending || update.isPending;

  function save() {
    if (!text.trim() || busy) return;
    update.mutate({ id: fact.id, text }, { onSuccess: () => setEditing(false), onError });
  }

  function cancel() {
    setText(fact.text);
    setEditing(false);
  }

  return (
    <li className="group flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
      <span className="w-16 shrink-0 pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">{fact.key}</span>
      {editing ? (
        <form
          className="grid min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Textarea
            aria-label={`Edit ${fact.key}`}
            className="min-h-0 resize-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !text.trim()}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <span className="text-muted-foreground text-xs max-sm:hidden">⌘ Enter saves · Esc cancels</span>
          </div>
        </form>
      ) : (
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-pretty text-sm leading-relaxed">{fact.text}</p>
          {(showSource || (showSection && fact.section) || fact.usage === "letters_only" || fact.evidence) && (
            <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
              {showSection && fact.section && <span className="font-medium">{fact.section}</span>}
              {showSource && <span>From {fact.itemKind === "cv" ? "your CV" : fact.itemTitle}</span>}
              {fact.evidence && <Evidence evidence={fact.evidence} />}
              {fact.usage === "letters_only" && <span>Letters and answers only</span>}
            </p>
          )}
        </div>
      )}
      {!editing && (
        <div
          className={cn(
            "-my-1 flex gap-1",
            // A confirmed fact rarely needs its actions: they wait for hover or focus, where there is a pointer.
            fact.status === "confirmed" &&
              "transition-opacity pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100",
          )}
        >
          {fact.status === "pending" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirm.mutate(fact.id, { onError })}>
              Confirm
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(fact.id, { onError })}>
            {fact.status === "pending" ? "Discard" : "Delete"}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Where a project fact came from (decisions 55, 81): the file or commit it cites, linked when the
 * project is public. A private project's fact shows only the project's name.
 */
function Evidence({ evidence }: { evidence: NonNullable<FactDto["evidence"]> }) {
  if (evidence.private) {
    return (
      <>
        <span className="font-mono">{evidence.repo}</span>
        <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[11px]">
          <LockIcon aria-hidden className="size-3" />
          Private
        </Badge>
      </>
    );
  }
  const label = evidence.kind === "file" ? evidence.path : `commit ${evidence.sha.slice(0, 7)}`;
  if (!evidence.url) {
    return (
      <span className="font-mono" title={`Not on ${evidence.repo}'s remote`}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={evidence.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono underline underline-offset-4"
      aria-label={`Evidence: ${label} in ${evidence.repo}`}
    >
      {label}
    </a>
  );
}

/** A confirmed fact the latest split of its item did not produce. */
function VanishedRow({ fact }: { fact: FactDto }) {
  const keep = useKeepFact();
  const remove = useDeleteFact();
  const busy = keep.isPending || remove.isPending;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
      <span className="w-16 shrink-0 pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">{fact.key}</span>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-pretty text-sm leading-relaxed">{fact.text}</p>
        {fact.evidence && (
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
            <Evidence evidence={fact.evidence} />
          </p>
        )}
      </div>
      <div className="-my-1 flex gap-1">
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

function vanishedHeading(item: ProfileItemDto, origin: FactDto["origin"]): string {
  if (origin === "github") return `Not in the latest GitHub read of ${item.title}`;
  return item.kind === "cv" ? "Not in your latest CV" : `Not in the latest version of ${item.title}`;
}

const VANISHED_HINT: Record<FactDto["origin"], string> = {
  text: "You confirmed these, but the text you saved last no longer has them. Keep them, or delete them.",
  github: "You confirmed these, but the latest read of the repo did not find them again. Keep them, or delete them.",
};

/** Facts whose key or text has every word of the query, in any order. */
function matching(facts: FactDto[], query: string): FactDto[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return facts;
  return facts.filter((f) => {
    const hay = `${f.key} ${f.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Past this many confirmed facts, a search box helps find one. */
const SEARCH_FROM = 8;

type FactGroup = { key: string; label: string; facts: FactDto[] };

/** The name facts are grouped under: their section, else the add-on they came from. CV facts with neither are "Other". */
function groupLabel(fact: FactDto): string | null {
  if (fact.section) return fact.section;
  return fact.itemKind === "cv" ? null : fact.itemTitle;
}

/**
 * Confirmed facts grouped by job, project or add-on, in the order each group first appears,
 * so a CV's groups keep the CV's order. Facts with no group come last, under "Other".
 */
function groupFacts(facts: FactDto[]): FactGroup[] {
  const groups = new Map<string, FactGroup>();
  const other: FactDto[] = [];
  for (const fact of facts) {
    const label = groupLabel(fact);
    if (label === null) {
      other.push(fact);
      continue;
    }
    const key = label
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const group = groups.get(key) ?? { key, label, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  if (other.length) list.push({ key: "", label: list.length ? "Other" : "All facts", facts: other });
  return list;
}

/** One collapsible group of confirmed facts. Closed by default; a search opens it. */
function FactGroupRow({ group, open, showSource }: { group: FactGroup; open: boolean; showSource: boolean }) {
  return (
    <details open={open} className="group/fg">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2.5 text-sm hover:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-open/fg:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 truncate font-medium">{group.label}</span>
        <span className="ml-auto pl-3 text-muted-foreground tabular-nums">{group.facts.length}</span>
      </summary>
      <ul className="mb-2 ml-6 divide-y border-t" aria-label={`Confirmed facts: ${group.label}`}>
        {group.facts.map((f) => (
          <FactRow key={f.id} fact={f} showSource={showSource} />
        ))}
      </ul>
    </details>
  );
}

/** Offers to split the CV again when its confirmed facts predate grouping and so have no section. */
function RegroupNote({ cv, ungrouped }: { cv: ProfileItemDto; ungrouped: number }) {
  const paste = usePasteCv();
  const overCap = useOverCap();
  const running = cv.splitTask?.status === "running";

  function regroup(confirmOverCap = false) {
    paste.mutate(
      { text: cv.body, confirmOverCap },
      {
        onSuccess: () => toast("Splitting your CV again. Facts that still match keep their confirmation."),
        onError: overCap.onError(() => regroup(true)),
      },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <p className="min-w-0 flex-1 text-muted-foreground">
        {ungrouped} fact{ungrouped === 1 ? "" : "s"} from your CV {ungrouped === 1 ? "has" : "have"} no job yet. Split
        your CV again to group them; facts that still match stay confirmed.
      </p>
      <Button size="sm" variant="outline" disabled={paste.isPending || running} onClick={() => regroup()}>
        {paste.isPending || running ? "Splitting…" : "Group by job"}
      </Button>
      {overCap.dialog}
    </div>
  );
}

function Facts({ profile }: { profile: ProfileDto }) {
  const id = useId();
  const confirmAll = useConfirmAllFacts();
  const [query, setQuery] = useState("");
  const { facts } = profile;
  const items = [...(profile.cv ? [profile.cv] : []), ...profile.addons];
  // While an item is being split or read, its facts' `inLatest` is about to change; wait for the result.
  const settled = new Set(
    items.filter((i) => i.splitTask?.status !== "running" && i.github?.readTask?.status !== "running").map((i) => i.id),
  );
  const isVanished = (f: FactDto) => f.status === "confirmed" && !f.inLatest && settled.has(f.itemId);
  const pending = facts.filter((f) => f.status === "pending");
  const confirmed = facts.filter((f) => f.status === "confirmed" && !isVanished(f));
  const vanished = items
    .flatMap((item) =>
      (["text", "github"] as const).map((origin) => ({
        item,
        origin,
        facts: facts.filter((f) => f.itemId === item.id && f.origin === origin && isVanished(f)),
      })),
    )
    .filter((group) => group.facts.length > 0);
  const showSource = profile.addons.length > 0;
  const shown = useMemo(() => matching(confirmed, query), [confirmed, query]);
  const groups = useMemo(() => groupFacts(shown), [shown]);
  const searching = query.trim() !== "";
  // Grouping only helps once the CV's facts carry a section; until then, offer to split the CV again.
  const ungroupedCv = confirmed.filter((f) => f.itemKind === "cv" && !f.section).length;
  const offerRegroup =
    profile.cv && ungroupedCv > SEARCH_FROM && !confirmed.some((f) => f.itemKind === "cv" && f.section);

  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-8">
      <SectionHeading
        id={`${id}-h`}
        title="Facts"
        description="Only confirmed facts can be cited. Cite one in a file by writing its key, like [FACT-1]."
      />
      {facts.length === 0 && (
        <p className="text-muted-foreground text-sm">No facts yet. Upload or paste your CV above.</p>
      )}
      {(facts.length > 0 || profile.skillChips.length > 0) && <SkillsForMatching profile={profile} />}
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
              <FactRow key={f.id} fact={f} showSource={showSource} showSection />
            ))}
          </ul>
        </div>
      )}
      {vanished.map(({ item, origin, facts: group }) => (
        <div key={`${item.id}-${origin}`}>
          <h3 className="font-medium text-sm">
            {vanishedHeading(item, origin)} <span className="text-muted-foreground tabular-nums">{group.length}</span>
          </h3>
          <p className="text-muted-foreground text-sm">{VANISHED_HINT[origin]}</p>
          <ul className="mt-2 divide-y border-y" aria-label={vanishedHeading(item, origin)}>
            {group.map((f) => (
              <VanishedRow key={f.id} fact={f} />
            ))}
          </ul>
        </div>
      ))}
      {confirmed.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-medium text-sm">
              Confirmed <span className="text-muted-foreground tabular-nums">{confirmed.length}</span>
            </h3>
            {confirmed.length > SEARCH_FROM && (
              <div className="relative ml-auto w-full sm:w-64">
                <SearchIcon
                  aria-hidden
                  className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
                />
                <Input
                  type="search"
                  aria-label="Search confirmed facts"
                  placeholder="Search facts"
                  className="h-8 pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
          </div>
          {offerRegroup && profile.cv && (
            <div className="mt-3">
              <RegroupNote cv={profile.cv} ungrouped={ungroupedCv} />
            </div>
          )}
          {shown.length > 0 ? (
            <section aria-label="Confirmed facts" className="mt-2 divide-y border-y">
              {groups.map((g) => (
                // Groups start closed once there are enough facts to need it. A search opens every
                // group with a match; clearing it closes them again.
                <FactGroupRow
                  key={`${g.key}-${searching}`}
                  group={g}
                  open={searching || groups.length === 1 || confirmed.length <= SEARCH_FROM}
                  showSource={showSource}
                />
              ))}
            </section>
          ) : (
            <p className="mt-2 border-y py-6 text-center text-muted-foreground text-sm" aria-live="polite">
              No confirmed fact has “{query.trim()}”.
            </p>
          )}
        </div>
      )}
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
  /** The link a fill marked private or unknown; kept private only while the link field still holds it. */
  const [privateLink, setPrivateLink] = useState<string | null>(null);
  /** The folder the last fill read; saved with the add-on so it can be read for facts (decision 81). */
  const [folder, setFolder] = useState<string | null>(null);
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
      ...(!item && privateLink !== null && form.link.trim() === privateLink ? { linkPrivate: true } : {}),
      ...(!item && folder ? { folder } : {}),
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto overscroll-contain sm:max-w-xl">
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
          {!item && (
            <FillFromSource
              onFill={(p) => {
                setForm((f) => ({
                  ...f,
                  kind: "open_source",
                  title: p.title,
                  body: p.body,
                  link: p.link ?? "",
                  skills: p.skills.join(", "),
                }));
                setPrivateLink(p.linkPrivate && p.link ? p.link : null);
                setFolder(p.folder);
                setProblem(null);
              }}
            />
          )}
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

/**
 * One GitHub or GitLab link or folder path to fill the add-on form from (decision 80). Its own
 * small form inside the add-on form would nest forms, so Enter is handled here.
 */
function FillFromSource({ onFill }: { onFill: (prefill: AddonPrefillDto) => void }) {
  const id = useId();
  const prefill = usePrefillAddon();
  const [source, setSource] = useState("");
  const [note, setNote] = useState<string | null>(null);

  function fill() {
    if (!source.trim() || prefill.isPending) return;
    setNote(null);
    prefill.mutate(source, {
      onSuccess: (p) => {
        onFill(p);
        setNote(p.note);
      },
    });
  }

  const error = prefill.error ? errorMessage(prefill.error) : null;
  return (
    <div className="grid gap-2 rounded-lg border border-dashed p-3">
      <Label htmlFor={`${id}-source`}>Fill from a project (optional)</Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-source`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              fill();
            }
          }}
          placeholder="github.com/you/repo or ~/projects/app"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-source-help`}
        />
        <Button type="button" variant="outline" onClick={fill} disabled={!source.trim() || prefill.isPending}>
          {prefill.isPending ? "Reading…" : "Fill"}
        </Button>
      </div>
      <p id={`${id}-source-help`} className="text-muted-foreground text-xs">
        A GitHub repo or pull request, a public GitLab project, or a folder on this machine. It fills the fields below
        for you to edit; nothing is saved yet.
      </p>
      <div aria-live="polite">
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!error && note && <p className="text-sm text-warning-foreground">{note}</p>}
      </div>
    </div>
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

function AddonRow({
  item,
  factCount,
  aiReady,
  onEdit,
}: {
  item: ProfileItemDto;
  factCount: number;
  aiReady: boolean;
  onEdit: () => void;
}) {
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
      <GithubRead item={item} aiReady={aiReady} />
      <ItemRoles item={item} what={`"${item.title}"`} aiReady={aiReady} />
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

// ---------- Find my projects (decision 78) ----------

type HideWords = { label: string; count: (n: number) => string };

const REPO_HIDE: Record<RepoHideReason, HideWords> = {
  fork: { label: "Fork", count: (n) => `${n} ${n === 1 ? "fork" : "forks"}` },
  profile: { label: "Profile README", count: () => "your profile README" },
  small: { label: "Nearly empty", count: (n) => `${n} nearly empty` },
};

const FOLDER_HIDE: Record<LocalHideReason, HideWords> = {
  not_git: { label: "Not a git repo", count: (n) => `${n} not git` },
  few_commits: { label: "Few of your commits", count: (n) => `${n} with few of your commits` },
  others: { label: "Mostly others' commits", count: (n) => `${n} mostly by others` },
  same_remote: { label: "Same repo as another folder", count: (n) => `${n} ${n === 1 ? "copy" : "copies"}` },
};

/** "25 forks, 7 nearly empty, your profile README", in the order the items are listed. */
function hiddenSummary<R extends string>(reasons: readonly (R | null)[], words: Record<R, HideWords>): string {
  const counts = new Map<R, number>();
  for (const r of reasons) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([reason, n]) => words[reason].count(n)).join(", ");
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

/** One pickable project: a checkbox, its name and badges, a meta line and its text. */
function ProjectOption({
  name,
  badges,
  meta,
  text,
  added,
  checked,
  onCheckedChange,
}: {
  name: string;
  badges: ReactNode;
  meta: string;
  text: string | null;
  added: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={added || checked}
        disabled={added}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-describedby={`${id}-meta`}
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={id} className="min-w-0 break-all font-medium">
            {name}
          </Label>
          {badges}
          {added && <Badge variant="secondary">Added</Badge>}
        </div>
        <p id={`${id}-meta`} className="text-muted-foreground text-xs tabular-nums">
          {meta}
        </p>
        {text && <p className="line-clamp-2 whitespace-pre-line text-pretty text-muted-foreground text-sm">{text}</p>}
      </div>
    </li>
  );
}

function repoMeta(repo: ScannedRepoDto): string {
  return [
    repo.language,
    repo.stars > 0 ? plural(repo.stars, "star") : null,
    repo.pushedAt ? `Pushed ${monthFormat.format(new Date(repo.pushedAt))}` : "Never pushed",
    repo.localCommits ? `${plural(repo.localCommits, "commit")} by you locally` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function folderMeta(folder: ScannedFolderDto): string {
  const commits =
    folder.totalCommits === 0
      ? null
      : folder.ownCommits === folder.totalCommits
        ? `${plural(folder.ownCommits, "commit")} by you`
        : `${folder.ownCommits} of ${plural(folder.totalCommits, "commit")} by you`;
  return [
    folder.languages.join(", ") || null,
    commits,
    folder.lastCommitAt ? `Last commit ${monthFormat.format(new Date(folder.lastCommitAt))}` : null,
    folder.url?.replace(/^https:\/\//, ""),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A source's shown items, then its hidden ones in a collapsed group. */
function ScanGroup({
  heading,
  shownCount,
  hiddenCount,
  hiddenLabel,
  emptyText,
  shown,
  hidden,
}: {
  heading: ReactNode;
  shownCount: number;
  hiddenCount: number;
  hiddenLabel: string;
  emptyText: string;
  shown: ReactNode;
  hidden: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="py-3">
      <h3 id={headingId} className="min-w-0 break-all pb-1 font-medium text-sm">
        {heading}
      </h3>
      {shownCount === 0 ? (
        <p className="py-3 text-muted-foreground text-sm">{emptyText}</p>
      ) : (
        <ul className="divide-y" aria-label="Shown">
          {shown}
        </ul>
      )}
      {hiddenCount > 0 && (
        <details className="group border-t pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-muted-foreground text-sm hover:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden
              className="size-4 shrink-0 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
            />
            Hidden by rules: {hiddenLabel}
          </summary>
          <ul className="divide-y" aria-label="Hidden by rules">
            {hidden}
          </ul>
        </details>
      )}
    </section>
  );
}

function ScanFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="grid justify-items-start gap-2 py-3 text-sm">
      <p>{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Picks are keyed by source, so a repo and a folder with the same name stay apart. */
type PickKey = `repo:${string}` | `folder:${string}`;

function ProjectsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const scan = useProjectScan({ enabled: open });
  const add = useAddProjects();
  const overCap = useOverCap(ADD_PROJECTS_WORDS);
  const [picked, setPicked] = useState<ReadonlySet<PickKey>>(new Set());
  const toggle = (key: PickKey) => (checked: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  const tooMany = picked.size > MAX_PROJECTS_PER_ADD;
  const count = plural(picked.size, "project");

  function submit(confirmOverCap: boolean) {
    const repos: string[] = [];
    const folders: string[] = [];
    for (const key of picked) {
      if (key.startsWith("repo:")) repos.push(key.slice(5));
      else folders.push(key.slice(7));
    }
    add.mutate(
      { repos, folders, confirmOverCap },
      {
        onSuccess: () => {
          toast(`Added ${count}. Their facts appear under Facts to review.`);
          onOpenChange(false);
        },
        onError: overCap.onError(() => submit(true)),
      },
    );
  }

  const repoOption = (repo: ScannedRepoDto) => (
    <ProjectOption
      key={repo.name}
      name={repo.name}
      badges={
        <>
          {repo.private && (
            <Badge variant="outline">
              <LockIcon aria-hidden />
              Private
            </Badge>
          )}
          {repo.archived && <Badge variant="outline">Archived</Badge>}
          {repo.hiddenBy && <Badge variant="secondary">{REPO_HIDE[repo.hiddenBy].label}</Badge>}
        </>
      }
      meta={repoMeta(repo)}
      text={repo.description}
      added={repo.added}
      checked={picked.has(`repo:${repo.name}`)}
      onCheckedChange={toggle(`repo:${repo.name}`)}
    />
  );
  const folderOption = (folder: ScannedFolderDto) => (
    <ProjectOption
      key={folder.folder}
      name={folder.folder}
      badges={folder.hiddenBy && <Badge variant="secondary">{FOLDER_HIDE[folder.hiddenBy].label}</Badge>}
      meta={folderMeta(folder)}
      text={folder.summary}
      added={folder.added}
      checked={picked.has(`folder:${folder.folder}`)}
      onCheckedChange={toggle(`folder:${folder.folder}`)}
    />
  );

  const github: ProjectScanDto["github"] = scan.data?.github ?? null;
  const local: ProjectScanDto["local"] = scan.data?.local ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Find my projects</DialogTitle>
          <DialogDescription>
            Each project you add becomes an add-on, split into facts for you to confirm. A repo on GitHub can also be
            read for facts from its code.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain border-y px-6">
          {scan.isPending && <p className="py-6 text-muted-foreground text-sm">Looking for your projects…</p>}
          {scan.isError && <ScanFailed message={errorMessage(scan.error)} onRetry={() => scan.refetch()} />}
          {local?.status === "error" && <ScanFailed message={local.message} onRetry={() => scan.refetch()} />}
          {local?.status === "ok" && (
            <ScanGroup
              heading={`In ${local.dir}`}
              shownCount={local.shown.length}
              hiddenCount={local.hidden.length}
              hiddenLabel={hiddenSummary(
                local.hidden.map((f) => f.hiddenBy),
                FOLDER_HIDE,
              )}
              emptyText={
                local.onGithub > 0
                  ? `No other folders left after the rules. ${plural(local.onGithub, "folder is a clone", "folders are clones")} of a repo below.`
                  : "No folders left after the rules. Check the hidden ones below."
              }
              shown={
                <>
                  {local.shown.map(folderOption)}
                  {local.onGithub > 0 && local.shown.length > 0 && (
                    <li className="py-2.5 text-muted-foreground text-xs">
                      {plural(local.onGithub, "folder is a clone", "folders are clones")} of a repo below, so{" "}
                      {local.onGithub === 1 ? "it shows" : "they show"} there.
                    </li>
                  )}
                </>
              }
              hidden={local.hidden.map(folderOption)}
            />
          )}
          {github?.status === "error" && <ScanFailed message={github.message} onRetry={() => scan.refetch()} />}
          {github?.status === "ok" && (
            <ScanGroup
              heading={`On GitHub · ${github.user}`}
              shownCount={github.shown.length}
              hiddenCount={github.hidden.length}
              hiddenLabel={hiddenSummary(
                github.hidden.map((r) => r.hiddenBy),
                REPO_HIDE,
              )}
              emptyText="No repos left after the rules. Check the hidden ones below."
              shown={github.shown.map(repoOption)}
              hidden={github.hidden.map(repoOption)}
            />
          )}
        </div>
        <DialogFooter className="items-center">
          <p
            className={cn("mr-auto text-sm tabular-nums", tooMany ? "text-destructive" : "text-muted-foreground")}
            aria-live="polite"
          >
            {tooMany ? `Pick at most ${MAX_PROJECTS_PER_ADD} at a time.` : `${picked.size} picked`}
          </p>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={picked.size === 0 || tooMany || add.isPending} onClick={() => submit(false)}>
            {add.isPending ? "Adding…" : picked.size === 0 ? "Add projects" : `Add ${count}`}
          </Button>
        </DialogFooter>
        {overCap.dialog}
      </DialogContent>
    </Dialog>
  );
}

function Addons({
  addons,
  facts,
  aiReady,
  projectScan,
}: {
  addons: ProfileItemDto[];
  facts: FactDto[];
  aiReady: boolean;
  projectScan: ProfileDto["projectScan"];
}) {
  // `key` remounts the dialog's form for each open, so it starts from the item being edited.
  const [dialog, setDialog] = useState<{ item: ProfileItemDto | null; key: number } | null>(null);
  const [finding, setFinding] = useState(0);
  const open = (item: ProfileItemDto | null) => setDialog({ item, key: Date.now() });
  return (
    <section aria-labelledby="addons-h" className="grid gap-5">
      <SectionHeading
        id="addons-h"
        title="Add-ons"
        description="Work, open source, challenges and anything else your CV leaves out."
        action={
          <div className="flex flex-wrap gap-2">
            {(projectScan.github || projectScan.local) && (
              <Button variant="outline" onClick={() => setFinding(Date.now())}>
                <FolderGit2Icon aria-hidden />
                Find my projects
              </Button>
            )}
            <Button variant="outline" onClick={() => open(null)}>
              <PlusIcon aria-hidden />
              Add an add-on
            </Button>
          </div>
        }
      />
      {addons.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing yet. A side project, a talk or a GitHub repo gives drafts more to cite.
        </p>
      )}
      {addons.length > 0 && (
        <ul className="divide-y border-y" aria-label="Add-ons">
          {addons.map((item) => (
            <AddonRow
              key={item.id}
              item={item}
              factCount={facts.filter((f) => f.itemId === item.id).length}
              aiReady={aiReady}
              onEdit={() => open(item)}
            />
          ))}
        </ul>
      )}
      {finding > 0 && (
        <ProjectsDialog
          key={finding}
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setFinding(0);
          }}
        />
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
  const { contact, standardAnswers, targeting, cv, cvFile, addons, facts, aiReady } = profile.data;
  const toReview = facts.filter((f) => f.status === "pending").length;
  const confirmed = facts.length - toReview;
  const answered = MUST_ANSWERS.filter((k) => standardAnswers[k]?.trim()).length;
  // The anchors (`/profile#cv`, `#facts`, `#targeting`) are what the setup checklist links to.
  const sections: PageSection[] = [
    {
      id: "contact",
      label: "Contact",
      hint: contact.fullName && contact.email ? undefined : "Incomplete",
      attention: true,
      // A CV save can fill empty fields on the server; the form picks them up.
      content: <ContactForm key={JSON.stringify(contact)} contact={contact} />,
    },
    {
      id: "cv",
      label: "CV",
      hint: cv ? undefined : "Missing",
      attention: true,
      content: (
        <div className="grid gap-8">
          <CvForm key={cv?.rev ?? 0} cv={cv} cvFile={cvFile} facts={facts} contact={contact} aiReady={aiReady} />
          {cv && <ItemRoles item={cv} what="your CV" aiReady={aiReady} />}
        </div>
      ),
    },
    {
      id: "facts",
      label: "Facts",
      hint: toReview > 0 ? `${toReview} to review` : confirmed > 0 ? String(confirmed) : undefined,
      attention: toReview > 0,
      content: <Facts profile={profile.data} />,
    },
    {
      id: "addons",
      label: "Add-ons",
      hint: addons.length > 0 ? String(addons.length) : undefined,
      content: <Addons addons={addons} facts={facts} aiReady={aiReady} projectScan={profile.data.projectScan} />,
    },
    {
      id: "answers",
      label: "Standard answers",
      hint: `${answered}/${MUST_ANSWERS.length}`,
      attention: answered < MUST_ANSWERS.length,
      content: <StandardAnswersForm answers={standardAnswers} />,
    },
    {
      id: "targeting",
      label: "Job targeting",
      content: <TargetingForm targeting={targeting} />,
    },
  ];
  return <SectionPage title="Profile" intro={<SetupChecklist />} sections={sections} />;
}
