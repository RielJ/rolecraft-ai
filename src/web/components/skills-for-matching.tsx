import { ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { ProfileDto, SetSkillInput } from "@/shared/api";
import { errorMessage } from "../api";
import { cn } from "../lib/utils";
import { useSetSkill } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** Most rows the Add skill picker lists before asking to type. */
const PICKER_ROWS = 40;

type Chip = ProfileDto["skillChips"][number];

const onError = (error: unknown) => toast.error(errorMessage(error));

/**
 * Profile → Facts: the skills Matches scores against (decision 66). Skills found in confirmed facts
 * and skills the user added show as chips; hidden ones sit in a collapsed list with Restore. Facts
 * stay the only source of what a draft may claim; this list only changes matching.
 */
export function SkillsForMatching({ profile }: { profile: ProfileDto }) {
  const id = useId();
  const setSkill = useSetSkill();
  const [note, setNote] = useState<string | null>(null);
  const shown = profile.skillChips.filter((c) => c.source !== "hidden");
  const hidden = profile.skillChips.filter((c) => c.source === "hidden");

  function send(input: SetSkillInput, after: (profile: ProfileDto) => void = () => {}) {
    setNote(null);
    setSkill.mutate(input, { onError, onSuccess: after });
  }

  function add(name: string) {
    const before = new Set(profile.skillChips.map((c) => c.name));
    send({ name, state: "added" }, (next) => {
      // An off-list skill is read in stored jobs on the next Refresh; say so.
      const fresh = next.skillChips.find((c) => c.source === "added" && !c.builtin && !before.has(c.name));
      if (fresh) setNote(`Jobs you already have are read for ${fresh.name} on the next Refresh.`);
    });
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 id={`${id}-h`} className="font-medium text-sm">
          Skills used for matching
        </h3>
        <ul aria-label="Legend" className="flex items-center gap-3 text-muted-foreground text-xs">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className={cn(chipClass("facts"), "size-3 p-0")} />
            Found in your facts
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className={cn(chipClass("added"), "size-3 p-0")} />
            Added by you
          </li>
        </ul>
      </div>
      <ul className="flex flex-wrap items-center gap-1.5" aria-labelledby={`${id}-h`}>
        {shown.map((chip) => (
          <li key={chip.name} className={chipClass(chip.source)}>
            <span>{chip.name}</span>
            <button
              type="button"
              aria-label={chip.source === "facts" ? `Hide ${chip.name} from matching` : `Remove ${chip.name}`}
              title={chip.source === "facts" ? "Hide from matching" : "Remove"}
              disabled={setSkill.isPending}
              onClick={() => send({ name: chip.name, state: chip.source === "facts" ? "hidden" : "none" })}
              className="-mr-1 grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </li>
        ))}
        <li>
          <AddSkill
            catalog={profile.skillCatalog}
            taken={new Set(shown.map((c) => c.name.toLowerCase()))}
            disabled={setSkill.isPending}
            onAdd={add}
          />
        </li>
      </ul>
      {shown.length === 0 && (
        <p className="text-muted-foreground text-sm">
          None yet. A skill counts once a confirmed fact names it, or once you add it.
        </p>
      )}
      {note && (
        <p role="status" className="text-muted-foreground text-sm">
          {note}
        </p>
      )}
      {hidden.length > 0 && (
        <details className="group text-sm">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            Hidden from matching ({hidden.length})
          </summary>
          <ul aria-label="Hidden from matching" className="mt-1 grid gap-0.5 pl-5">
            {hidden.map((chip) => (
              <li key={chip.name} className="flex min-h-8 items-center gap-2">
                <span className="text-muted-foreground">{chip.name}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Restore ${chip.name}`}
                  disabled={setSkill.isPending}
                  onClick={() => send({ name: chip.name, state: "none" })}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function chipClass(source: Chip["source"]) {
  return cn(
    "inline-flex h-6 items-center gap-1 rounded-full border px-2 font-medium text-xs",
    source === "facts"
      ? "border-transparent bg-secondary text-secondary-foreground"
      : "border-primary/40 border-dashed",
  );
}

function AddSkill({
  catalog,
  taken,
  disabled,
  onAdd,
}: {
  catalog: readonly string[];
  /** Lowercased names already used for matching. */
  taken: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const typed = find.trim().replace(/\s+/g, " ");
  const needle = typed.toLowerCase();
  const options = catalog.filter((name) => !taken.has(name.toLowerCase()) && name.toLowerCase().includes(needle));
  const rows = options.slice(0, PICKER_ROWS);
  const exact = catalog.some((name) => name.toLowerCase() === needle) || taken.has(needle);

  function pick(name: string) {
    onAdd(name);
    setOpen(false);
    setFind("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFind("");
      }}
    >
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" disabled={disabled} className="text-muted-foreground">
          <PlusIcon aria-hidden />
          Add skill
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-72 gap-0 p-0" aria-label="Add a skill">
        <form
          className="relative border-b"
          onSubmit={(e) => {
            e.preventDefault();
            const first = rows[0];
            if (typed === "") return;
            pick(first !== undefined && first.toLowerCase() === needle ? first : typed);
          }}
        >
          <label htmlFor={searchId} className="sr-only">
            Find or type a skill
          </label>
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            placeholder="Find or type a skill"
            maxLength={60}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            className="h-10 rounded-none border-0 pl-9 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </form>
        <ul aria-label="Skills" className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {typed !== "" && !exact && (
            <li>
              <button type="button" className={rowClass} onClick={() => pick(typed)}>
                <PlusIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">Add “{typed}” as your own skill</span>
              </button>
            </li>
          )}
          {rows.map((name) => (
            <li key={name}>
              <button type="button" className={rowClass} onClick={() => pick(name)}>
                {name}
              </button>
            </li>
          ))}
          {options.length > rows.length && (
            <li className="px-2 py-2 text-muted-foreground text-xs">
              {options.length - rows.length} more. Type to find one.
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

const rowClass =
  "flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";
