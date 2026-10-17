import { Link } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";
import type { JobId, MatchDetail, MatchReason, PossibleDuplicate } from "@/shared/api";
import { cn } from "@/web/lib/utils";
import { Button } from "../ui/button";
import { DuplicateDiffLines, JobFacts } from "./job-facts";
import { LevelBadge, RoleUnclearChip } from "./job-list";

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

/**
 * The Matches reading pane (section 4): verdict phrase, PH-time hours, converted pay, match
 * reasons, attribution and the duplicate hint, then the posting. Nothing here animates: the pane
 * swaps content in place when the selection moves.
 */
export function ReadingPane({
  job,
  stale,
  onSave,
  onDismiss,
  onMerge,
  merging,
  ref,
}: {
  job: MatchDetail | null;
  /** True while the next job loads and the previous one is still shown. */
  stale: boolean;
  onSave: () => void;
  onDismiss: () => void;
  /** Merge this job into a likely duplicate (`POST /api/jobs/:id/merge`). */
  onMerge: (into: JobId) => void;
  /** The duplicate a merge is running against, if any. */
  merging: JobId | null;
  ref?: Ref<HTMLElement>;
}): ReactNode {
  const postingUrl = job ? (job.applyUrl ?? job.seenOn[0]?.listingUrl ?? null) : null;
  return (
    <section
      ref={ref}
      aria-label="Reading pane"
      aria-busy={stale}
      className="min-h-0 overflow-y-auto rounded-md border bg-card px-5 py-4 md:px-7 md:py-6"
    >
      {job && (
        <article className="grid max-w-[68ch] gap-5">
          <header className="grid gap-2">
            <h2 className="font-semibold text-xl leading-tight tracking-tight">{job.title}</h2>
            <p className="text-muted-foreground">{job.company}</p>
            <div className="flex flex-wrap items-center gap-2">
              <LevelBadge level={job.level} />
              {job.roleUnclear && (
                <>
                  <RoleUnclearChip />
                  <span className="text-muted-foreground text-sm">{job.roleUnclear}</span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" onClick={onSave}>
                Save to board
              </Button>
              <Button size="sm" variant="outline" onClick={onDismiss}>
                Dismiss
              </Button>
              {postingUrl && (
                <Button size="sm" variant="ghost" asChild>
                  <a href={postingUrl} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon aria-hidden />
                    View posting
                  </a>
                </Button>
              )}
            </div>
          </header>

          <JobFacts job={job.facts} />

          {job.reasons.length > 0 && (
            <section aria-label="Match reasons" className="grid gap-1.5">
              <h3 className="font-medium text-sm">Why this level</h3>
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

          <div className="whitespace-pre-wrap border-t pt-5 font-serif text-[0.95rem] leading-relaxed">
            {job.description}
          </div>
        </article>
      )}
    </section>
  );
}
