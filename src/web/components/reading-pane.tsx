import { Link } from "@tanstack/react-router";
import {
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";
import type { JobId, MatchDetail, MatchReason, PossibleDuplicate } from "@/shared/api";
import { matchSkillsLabel } from "@/shared/labels";
import { cn } from "@/web/lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Kbd } from "../ui/kbd";
import { DuplicateDiffLines, JobFacts } from "./job-facts";
import { LevelBadge, RoleUnclearChip } from "./job-list";
import { PostingText } from "./posting-text";

function ReasonIcon({ sign }: { sign: MatchReason["sign"] }) {
  switch (sign) {
    case "positive":
      return <CheckIcon aria-label="For" className="mt-0.5 size-4 shrink-0 text-primary" />;
    case "negative":
      return <MinusIcon aria-label="Against" className="mt-0.5 size-4 shrink-0 text-destructive" />;
    case "neutral":
      return <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
    default: {
      const _exhaustive: never = sign;
      return _exhaustive;
    }
  }
}

function ListingLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
      {children}
    </a>
  );
}

/**
 * Where the job was seen, with the listing on each board (attribution, section 4). Boards whose
 * terms ask for credit read "via RemoteOK", linked to the listing there.
 */
function SeenOn({ seenOn }: { seenOn: MatchDetail["seenOn"] }) {
  const plain = seenOn.filter((s) => s.via === null);
  const credited = seenOn.filter((s) => s.via !== null);
  if (seenOn.length === 0) return null;
  return (
    <p className="text-muted-foreground text-sm">
      {plain.length > 0 && "Seen on "}
      {plain.map((s, i) => (
        <span key={s.listingUrl}>
          {i > 0 && ", "}
          <ListingLink href={s.listingUrl}>{s.label}</ListingLink>
        </span>
      ))}
      {credited.map((s, i) => (
        <span key={s.listingUrl}>
          {(plain.length > 0 || i > 0) && " · "}
          via <ListingLink href={s.listingUrl}>{s.via}</ListingLink>
        </span>
      ))}
    </p>
  );
}

/**
 * One duplicate hint (section 3.8): "Possibly the same job as Senior Engineer at Acme
 * (Greenhouse) · Merge", then the two-line diff. When both jobs are on the board, Merge stays
 * visible but disabled, with the reason next to it.
 */
function DuplicateHint({
  duplicate: d,
  merging,
  onMerge,
}: {
  duplicate: PossibleDuplicate;
  merging: boolean;
  onMerge: (into: JobId) => void;
}) {
  const reasonId = useId();
  const name = `${d.title} at ${d.company}`;
  const blocked = d.merge.kind === "blocked" ? d.merge.reason : null;
  return (
    <li className="grid gap-1">
      <p className="text-muted-foreground">
        Possibly the same job as{" "}
        {d.opportunityId ? (
          <Link
            to="/jobs/$opportunityId"
            params={{ opportunityId: d.opportunityId }}
            className="text-foreground underline underline-offset-4"
          >
            {name}
          </Link>
        ) : (
          <span className="text-foreground">{name}</span>
        )}{" "}
        ({d.source}) ·{" "}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 align-baseline"
          disabled={blocked !== null || merging}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => onMerge(d.jobId)}
        >
          {merging ? "Merging…" : "Merge"}
        </Button>
        {blocked && (
          <span id={reasonId} className="ml-2">
            {blocked}
          </span>
        )}
      </p>
      <DuplicateDiffLines diff={d.diff} />
    </li>
  );
}

function DuplicateHints({
  duplicates,
  merging,
  onMerge,
}: {
  duplicates: readonly PossibleDuplicate[];
  merging: JobId | null;
  onMerge: (into: JobId) => void;
}) {
  if (duplicates.length === 0) return null;
  return (
    <ul aria-label="Possible duplicates" className="grid gap-3 text-sm">
      {duplicates.map((d) => (
        <DuplicateHint key={d.jobId} duplicate={d} merging={merging === d.jobId} onMerge={onMerge} />
      ))}
    </ul>
  );
}

/** What the reading pane's buttons do; Matches owns the state behind each. */
export type PaneActions = {
  /** Save and open the workspace: apply, or write the files, now. */
  onStart: () => void;
  /** Save to the Board and move on. */
  onSave: () => void;
  /** Save, start writing the files in the background, and move on. */
  onSaveAndWrite: () => void;
  onDismiss: () => void;
};

const KEY_HINT = "hidden pointer-fine:inline-flex";

/**
 * Start application, Save for later (with "Save and write files" behind its arrow), Dismiss and
 * View posting. Key hints show only where there is a keyboard. `dismissAnchor` is the dismiss
 * reason popover, anchored here when the list is not on screen to anchor it.
 */
function Actions({
  actions,
  postingUrl,
  dismissAnchor,
  className,
}: {
  actions: PaneActions;
  postingUrl: string | null;
  dismissAnchor: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative flex flex-wrap items-center gap-2", className)}>
      <Button size="sm" onClick={actions.onStart}>
        Start application
        <Kbd aria-hidden className={cn(KEY_HINT, "bg-primary-foreground/15 text-primary-foreground")}>
          Enter
        </Kbd>
      </Button>
      <div className="flex">
        <Button size="sm" variant="outline" className="rounded-r-none" onClick={actions.onSave}>
          Save for later
          <Kbd aria-hidden className={KEY_HINT}>
            S
          </Kbd>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-l-none border-l-0"
              aria-label="More ways to save"
            >
              <ChevronDownIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={actions.onSaveAndWrite}>
              Save and write files
              <DropdownMenuShortcut>⇧S</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button size="sm" variant="outline" onClick={actions.onDismiss}>
        Dismiss
        <Kbd aria-hidden className={KEY_HINT}>
          D
        </Kbd>
      </Button>
      {postingUrl && (
        <Button size="sm" variant="ghost" asChild>
          <a href={postingUrl} target="_blank" rel="noreferrer">
            <ExternalLinkIcon aria-hidden />
            View posting
            <Kbd aria-hidden className={KEY_HINT}>
              V
            </Kbd>
          </a>
        </Button>
      )}
      {dismissAnchor}
    </div>
  );
}

/** The phone's action bar: one row under the thumb, Start filling it and the rest as icons. */
function PhoneActions({
  actions,
  postingUrl,
  dismissAnchor,
}: {
  actions: PaneActions;
  postingUrl: string | null;
  dismissAnchor: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 flex items-center gap-2 rounded-b-xl border-t bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
      <Button className="flex-1" onClick={actions.onStart}>
        Start application
      </Button>
      <Button size="icon" variant="outline" aria-label="Save for later" onClick={actions.onSave}>
        <BookmarkPlusIcon aria-hidden />
      </Button>
      <Button size="icon" variant="outline" aria-label="Dismiss" onClick={actions.onDismiss}>
        <XIcon aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="More">
            <EllipsisIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem onSelect={actions.onSaveAndWrite}>Save and write files</DropdownMenuItem>
          {postingUrl && (
            <DropdownMenuItem asChild>
              <a href={postingUrl} target="_blank" rel="noreferrer">
                View posting
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dismissAnchor}
    </div>
  );
}

/** Who can apply, pay, why this level, where it was seen and likely duplicates. */
function Details({
  job,
  stacked,
  merging,
  onMerge,
}: {
  job: MatchDetail;
  stacked: boolean;
  merging: JobId | null;
  onMerge: (into: JobId) => void;
}) {
  const skills = matchSkillsLabel(job.skills);
  return (
    <>
      <JobFacts job={job.facts} location={false} stacked={stacked} />
      {job.reasons.length > 0 && (
        <section aria-label="Match reasons" className="grid gap-1.5">
          <h3 className="font-medium text-sm">Why this level</h3>
          {skills && <p className="text-muted-foreground text-sm tabular-nums">{skills.full}</p>}
          <ul className="grid gap-1 text-sm">
            {job.reasons.map((r) => (
              <li key={`${r.sign}:${r.text}`} className="flex gap-2">
                <ReasonIcon sign={r.sign} />
                <span className={cn(r.sign === "neutral" && "text-muted-foreground")}>{r.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <SeenOn seenOn={job.seenOn} />
      <DuplicateHints duplicates={job.facts.possibleDuplicates} merging={merging} onMerge={onMerge} />
    </>
  );
}

/**
 * The Matches reading pane (section 4): the job's header and actions, its details, then the
 * posting. Beside the list (`split`) the details sit above the posting. On its own (`focus`) the
 * posting keeps a reading measure and the details move to a column beside it. Nothing here
 * animates: the pane swaps content in place when the selection moves.
 */
export function ReadingPane({
  job,
  stale,
  layout,
  actions,
  onMerge,
  merging,
  top,
  dismissAnchor,
  phoneDismissAnchor,
  className,
  ref,
}: {
  job: MatchDetail | null;
  /** True while the next job loads and the previous one is still shown. */
  stale: boolean;
  layout: "split" | "focus";
  actions: PaneActions;
  /** Merge this job into a likely duplicate (`POST /api/jobs/:id/merge`). */
  onMerge: (into: JobId) => void;
  /** The duplicate a merge is running against, if any. */
  merging: JobId | null;
  /** Above the job: back to the list and the pager, where the page shows them. */
  top?: ReactNode;
  /** The dismiss reason popover, when it anchors at the header's actions. */
  dismissAnchor?: ReactNode;
  /** The dismiss reason popover, when it anchors at the phone's action bar. */
  phoneDismissAnchor?: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
}): ReactNode {
  const postingUrl = job ? (job.applyUrl ?? job.seenOn[0]?.listingUrl ?? null) : null;
  const focus = layout === "focus";
  return (
    <section
      ref={ref}
      aria-label="Reading pane"
      aria-busy={stale}
      className={cn("min-h-0 md:overflow-y-auto md:overscroll-contain", className)}
    >
      {top}
      {job && (
        <article
          className={cn(
            "grid gap-6 px-4 pt-3 pb-6 md:px-8 md:pt-7 md:pb-8",
            focus
              ? "mx-auto max-w-6xl lg:grid-cols-[minmax(0,68ch)_minmax(15rem,20rem)] lg:justify-between lg:gap-x-12"
              : "max-w-[68ch]",
          )}
        >
          <header className="grid gap-3 lg:col-span-full">
            <div className="grid gap-1">
              <h2
                className={cn(
                  "text-balance font-semibold leading-tight tracking-tight",
                  focus ? "text-xl md:text-2xl" : "text-xl",
                )}
              >
                {job.title}
              </h2>
              <p className="text-muted-foreground">
                {job.company}
                {job.facts.locationText && ` · ${job.facts.locationText}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LevelBadge level={job.level} />
              {job.roleUnclear && (
                <>
                  <RoleUnclearChip />
                  <span className="text-muted-foreground text-sm">{job.roleUnclear}</span>
                </>
              )}
            </div>
            <Actions
              actions={actions}
              postingUrl={postingUrl}
              dismissAnchor={dismissAnchor}
              className="max-md:hidden"
            />
          </header>

          {focus ? (
            <>
              {/* Beside the posting on wide screens, stuck in view while it scrolls; above it below lg. */}
              <aside
                aria-label="About this job"
                className="grid h-fit gap-6 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-2 lg:border-l lg:pl-8"
              >
                <Details job={job} stacked merging={merging} onMerge={onMerge} />
              </aside>
              <PostingText
                text={job.description}
                className="border-t pt-6 lg:col-start-1 lg:row-start-2 lg:border-t-0 lg:pt-0"
              />
            </>
          ) : (
            <>
              <Details job={job} stacked={false} merging={merging} onMerge={onMerge} />
              <PostingText text={job.description} className="border-t pt-6" />
            </>
          )}
        </article>
      )}
      {job && <PhoneActions actions={actions} postingUrl={postingUrl} dismissAnchor={phoneDismissAnchor} />}
    </section>
  );
}
