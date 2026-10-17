import { CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { MatchDetail, MatchReason } from "@/shared/api";
import { cn } from "@/web/lib/utils";
import { Button } from "../ui/button";
import { JobFacts, PossibleDuplicates } from "./job-facts";
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

/** Where the job was seen, with the listing on each board (attribution, section 4). */
function SeenOn({ seenOn }: { seenOn: MatchDetail["seenOn"] }) {
  if (seenOn.length === 0) return null;
  return (
    <p className="text-muted-foreground text-sm">
      Seen on{" "}
      {seenOn.map((s, i) => (
        <span key={s.listingUrl}>
          {i > 0 && ", "}
          <a
            href={s.listingUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            {s.label}
          </a>
        </span>
      ))}
    </p>
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
  ref,
}: {
  job: MatchDetail | null;
  /** True while the next job loads and the previous one is still shown. */
  stale: boolean;
  onSave: () => void;
  onDismiss: () => void;
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
          <PossibleDuplicates duplicates={job.facts.possibleDuplicates} />

          <div className="whitespace-pre-wrap border-t pt-5 font-serif text-[0.95rem] leading-relaxed">
            {job.description}
          </div>
        </article>
      )}
    </section>
  );
}
