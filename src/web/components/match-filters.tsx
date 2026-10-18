import { ChevronDownIcon, EyeOffIcon, SearchIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { MatchList, MatchSourceGroup, SourceId } from "@/shared/api";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type Facets = MatchList["facets"];
export type SourcePick = MatchSourceGroup | SourceId | null;

/** A filter button that reads as pressed while its filter is on. */
const triggerClass = (active: boolean) =>
  cn("max-w-56 gap-1.5", active && "border-primary/50 bg-accent text-accent-foreground");

/** Past this many, the list asks for typing instead of growing. */
const COMPANY_ROWS = 80;

/**
 * Company: pick one or more companies. Each count is what picking it shows with the other filters
 * on. Hidden companies stay in the list, marked, and can be shown again from the bottom section.
 */
export function CompanyFilter({
  companies,
  hidden,
  picked,
  onPick,
  onShowCompany,
  open,
  onOpenChange,
}: {
  companies: Facets["companies"];
  hidden: MatchList["hiddenCompanies"];
  /** Picked company keys, with the name each was picked under (it may leave `companies`). */
  picked: ReadonlyMap<string, string>;
  onPick: (next: ReadonlyMap<string, string>) => void;
  onShowCompany: (name: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const searchId = useId();
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const matching = needle === "" ? companies : companies.filter((c) => c.name.toLowerCase().includes(needle));
  // Picked companies first, so they stay in reach; a pick with no jobs left still shows, at 0.
  const missing = [...picked].filter(([key]) => !companies.some((c) => c.key === key));
  const rows = [
    ...missing.map(([key, name]) => ({ key, name, count: 0, hidden: false })),
    ...matching.filter((c) => picked.has(c.key)),
    ...matching.filter((c) => !picked.has(c.key)),
  ];
  const shown = rows.slice(0, COMPANY_ROWS);

  function toggle(key: string, name: string) {
    const next = new Map(picked);
    if (next.has(key)) next.delete(key);
    else next.set(key, name);
    onPick(next);
  }

  const [first] = picked.values();
  const label = first === undefined ? "Company" : picked.size === 1 ? first : `${first} +${picked.size - 1}`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setFind("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={triggerClass(picked.size > 0)}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-0 p-0" aria-label="Filter by company">
        <div className="relative border-b">
          <label htmlFor={searchId} className="sr-only">
            Find a company
          </label>
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            placeholder="Find a company"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            className="h-10 rounded-none border-0 pl-9 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <ul aria-label="Companies" className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {shown.map((c) => {
            const id = `${searchId}-${c.key}`;
            return (
              <li key={c.key}>
                <label
                  htmlFor={id}
                  className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm hover:bg-accent has-focus-visible:bg-accent"
                >
                  <Checkbox id={id} checked={picked.has(c.key)} onCheckedChange={() => toggle(c.key, c.name)} />
                  <span className={cn("min-w-0 flex-1 truncate", c.hidden && "text-muted-foreground")}>{c.name}</span>
                  {c.hidden && <EyeOffIcon aria-label="Hidden" className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="text-muted-foreground text-xs tabular-nums">{c.count}</span>
                </label>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="px-2 py-3 text-muted-foreground text-sm">No company matches “{find.trim()}”.</li>
          )}
          {rows.length > shown.length && (
            <li className="px-2 py-2 text-muted-foreground text-xs">
              {rows.length - shown.length} more. Type to find one.
            </li>
          )}
        </ul>
        {hidden.length > 0 && (
          <section aria-label="Hidden companies" className="border-t p-1">
            <h3 className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">Hidden from Matches</h3>
            <ul className="max-h-32 overflow-y-auto overscroll-contain">
              {hidden.map((h) => (
                <li key={h.key} className="flex min-h-9 items-center gap-2 px-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{h.name}</span>
                  <Button size="xs" variant="ghost" onClick={() => onShowCompany(h.name)}>
                    Show
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {picked.size > 0 && (
          <div className="border-t p-1">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => onPick(new Map())}>
              <XIcon aria-hidden />
              Clear {picked.size === 1 ? "company" : `${picked.size} companies`}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

const GROUPS: readonly { value: MatchSourceGroup; label: string }[] = [
  { value: "boards", label: "Company boards" },
  { value: "sites", label: "Job sites" },
  { value: "added", label: "Added by you" },
];

/** Source: a company board, any job site or one of them, or jobs you pasted or linked. */
export function SourceFilter({
  sources,
  value,
  onChange,
}: {
  sources: Facets["sources"];
  value: SourcePick;
  onChange: (next: SourcePick) => void;
}) {
  const label =
    value === null
      ? "Source"
      : (GROUPS.find((g) => g.value === value)?.label ?? sources.sites.find((s) => s.id === value)?.label ?? "Source");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={triggerClass(value !== null)}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-60">
        <DropdownMenuRadioGroup value={value ?? "all"} onValueChange={(v) => onChange(pick(v, sources))}>
          <DropdownMenuRadioItem value="all">All sources</DropdownMenuRadioItem>
          {GROUPS.map((g) => (
            <DropdownMenuRadioItem key={g.value} value={g.value} disabled={sources.groups[g.value] === 0}>
              {g.label}
              <DropdownMenuShortcut className="tabular-nums tracking-normal">
                {sources.groups[g.value]}
              </DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
          {sources.sites.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs">Job sites</DropdownMenuLabel>
              {sources.sites.map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id}>
                  <span className="truncate">{s.label}</span>
                  <DropdownMenuShortcut className="tabular-nums tracking-normal">{s.count}</DropdownMenuShortcut>
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A radio value back to a pick: "all", a group name, or one of the listed sites' ids. */
function pick(v: string, sources: Facets["sources"]): SourcePick {
  return GROUPS.find((g) => g.value === v)?.value ?? sources.sites.find((s) => s.id === v)?.id ?? null;
}
