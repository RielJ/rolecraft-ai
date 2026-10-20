import { PlusIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_ROLES, type ProfileItemDto, type RoleDto, type RoleInput } from "@/shared/api";
import { errorMessage } from "@/web/api";
import { SaveRow } from "@/web/components/section-page";
import { useReadRoles, useRetrySplit, useSaveRoles } from "@/web/queries";
import { Button } from "@/web/ui/button";
import { Input } from "@/web/ui/input";
import { Label } from "@/web/ui/label";

/*
 * The Roles list of the CV or an experience add-on (decision 71): read from its text, editable,
 * and used as the job headers of a drafted resume.
 */

type Row = {
  /** Local key for React and labels; an existing role keeps its id. */
  key: string;
  id: RoleDto["id"] | undefined;
  title: string;
  company: string;
  location: string;
  start: string;
  end: string;
  factCount: number;
};

type Field = "title" | "company" | "location" | "start" | "end";
const FIELDS: { field: Field; label: string; required: boolean; placeholder?: string }[] = [
  { field: "title", label: "Title", required: true },
  { field: "company", label: "Company", required: true },
  { field: "location", label: "Location", required: false, placeholder: "Remote" },
  { field: "start", label: "Start", required: false, placeholder: "Jan, 2026" },
  { field: "end", label: "End", required: false, placeholder: "Present" },
];
const MAX_FIELD = 200;

const toRow = (r: RoleDto): Row => ({
  key: r.id,
  id: r.id,
  title: r.title,
  company: r.company,
  location: r.location ?? "",
  start: r.start ?? "",
  end: r.end ?? "",
  factCount: r.factCount,
});

const toInput = (r: Row): RoleInput => ({
  ...(r.id ? { id: r.id } : {}),
  title: r.title.trim(),
  company: r.company.trim(),
  location: r.location.trim() || null,
  start: r.start.trim() || null,
  end: r.end.trim() || null,
});

/** A problem with one field, or null. The server checks the same rules. */
function problemOf(row: Row, field: Field): string | null {
  const value = row[field].trim();
  if (field === "title" && !value) return "Each role needs a title.";
  if (field === "company" && !value) return "Each role needs a company.";
  if (value.length > MAX_FIELD) return `Keep each role field under ${MAX_FIELD} characters.`;
  return null;
}

/** A key that changes whenever the saved roles do, so the editor starts again from them. */
export const rolesKey = (item: ProfileItemDto): string =>
  JSON.stringify(item.roles.map((r) => [r.id, r.title, r.company, r.location, r.start, r.end]));

export function RolesEditor({
  item,
  what,
  aiReady,
  onOverCap,
}: {
  item: ProfileItemDto;
  /** "your CV", or the add-on's title. */
  what: string;
  aiReady: boolean;
  /** Opens the over-cap confirmation; `again` repeats the read with `confirmOverCap`. */
  onOverCap: (again: () => void) => (error: unknown) => void;
}) {
  const id = useId();
  const save = useSaveRoles();
  const read = useReadRoles();
  const retry = useRetrySplit();
  const [rows, setRows] = useState<Row[]>(() => item.roles.map(toRow));
  const [showProblems, setShowProblems] = useState(false);
  const added = useRef(0);

  const task = item.rolesTask;
  const reading = task?.status === "running" || read.isPending || retry.isPending;
  const splitting = item.splitTask?.status === "running";
  const failed = task?.status === "failed" || task?.status === "interrupted";
  const dirty = JSON.stringify(rows.map(toInput)) !== JSON.stringify(item.roles.map(toRow).map(toInput));
  const fromWhat = item.kind === "cv" ? "your CV" : "this add-on";

  const startRead = (confirmOverCap: boolean) =>
    read.mutate(
      { id: item.id, confirmOverCap },
      { onError: onOverCap(() => startRead(true)), onSuccess: () => toast(`Reading the roles in ${what}.`) },
    );
  const retryRead = (confirmOverCap: boolean) => {
    if (!task) return;
    retry.mutate(
      { id: task.id, confirmOverCap },
      { onError: onOverCap(() => retryRead(true)), onSuccess: () => toast(`Reading the roles in ${what} again.`) },
    );
  };

  const change = (key: string, field: Field, value: string) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  function addRole() {
    added.current += 1;
    const key = `new-${added.current}`;
    setRows((all) => [
      ...all,
      { key, id: undefined, title: "", company: "", location: "", start: "", end: "", factCount: 0 },
    ]);
    requestAnimationFrame(() => document.getElementById(`${id}-${key}-title`)?.focus());
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = rows.flatMap((r) =>
      FIELDS.flatMap(({ field }) => (problemOf(r, field) ? [`${id}-${r.key}-${field}`] : [])),
    );
    if (invalid.length > 0) {
      setShowProblems(true);
      const first = invalid[0];
      if (first) document.getElementById(first)?.focus();
      return;
    }
    save.mutate(
      { id: item.id, roles: rows.map(toInput) },
      {
        onSuccess: () => toast(rows.length === 0 ? "Roles cleared." : "Roles saved."),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  const roleName = (r: Row, i: number) =>
    r.title.trim() && r.company.trim() ? `${r.title.trim()} at ${r.company.trim()}` : `Role ${i + 1}`;

  return (
    <form onSubmit={submit} noValidate className="grid gap-3" aria-labelledby={`${id}-h`}>
      <div className="grid max-w-prose gap-1">
        <h3 id={`${id}-h`} className="font-semibold text-base">
          Roles
        </h3>
        <p className="text-pretty text-muted-foreground text-sm">
          The jobs in {what}, most recent first. A drafted resume uses them as its job headers, word for word, with each
          role's facts under it.
        </p>
      </div>

      {rows.length === 0 && (
        <div className="grid gap-2 text-sm">
          <p className="text-muted-foreground">No roles yet.</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!aiReady || reading || splitting}
              onClick={() => (failed ? retryRead(false) : startRead(false))}
            >
              {failed ? "Retry reading roles" : `Read roles from ${fromWhat}`}
            </Button>
            {!aiReady && (
              <span className="text-muted-foreground">Reading roles needs AI. You can add them yourself.</span>
            )}
          </div>
        </div>
      )}
      {task?.status === "running" && (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {task.step || `Reading the roles in ${what}`}…
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          {task?.status === "interrupted"
            ? `Reading the roles in ${what} stopped because the app restarted.`
            : (task?.error ?? `Reading the roles in ${what} failed.`)}
        </p>
      )}

      {rows.length > 0 && (
        <ol className="divide-y border-y" aria-label={`Roles in ${what}`}>
          {rows.map((r, i) => (
            <li key={r.key} className="py-3">
              <fieldset className="grid gap-3">
                <legend className="sr-only">{roleName(r, i)}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.slice(0, 2).map((f) => (
                    <RoleField key={f.field} id={id} row={r} spec={f} showProblems={showProblems} onChange={change} />
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {FIELDS.slice(2).map((f) => (
                    <RoleField key={f.field} id={id} row={r} spec={f} showProblems={showProblems} onChange={change} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {r.id === undefined
                      ? "New: facts whose section names this company join it when you save."
                      : r.factCount === 1
                        ? "1 fact"
                        : `${r.factCount} facts`}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${roleName(r, i)}`}
                    onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                  >
                    Remove
                  </Button>
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="outline" size="sm" onClick={addRole} disabled={rows.length >= MAX_ROLES}>
          <PlusIcon aria-hidden />
          Add a role
        </Button>
      </div>
      {(rows.length > 0 || item.roles.length > 0) && (
        <SaveRow dirty={dirty} pending={save.isPending} label="Save roles" disabled={reading} />
      )}
    </form>
  );
}

function RoleField({
  id,
  row,
  spec,
  showProblems,
  onChange,
}: {
  id: string;
  row: Row;
  spec: (typeof FIELDS)[number];
  showProblems: boolean;
  onChange: (key: string, field: Field, value: string) => void;
}) {
  const inputId = `${id}-${row.key}-${spec.field}`;
  const problem = showProblems ? problemOf(row, spec.field) : null;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId} className="text-muted-foreground text-xs">
        {spec.label}
        {!spec.required && <span className="font-normal"> (optional)</span>}
      </Label>
      <Input
        id={inputId}
        value={row[spec.field]}
        placeholder={spec.placeholder}
        required={spec.required}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${inputId}-problem` : undefined}
        autoComplete="off"
        onChange={(e) => onChange(row.key, spec.field, e.target.value)}
      />
      {problem && (
        <p id={`${inputId}-problem`} className="text-destructive text-xs">
          {problem}
        </p>
      )}
    </div>
  );
}
