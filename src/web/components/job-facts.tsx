import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { JobFacts as JobFactsDto, PossibleDuplicate } from "@/shared/api";

const DATE = new Intl.DateTimeFormat("en-PH", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "Asia/Manila",
});

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Who can apply, the hours in PH time and the pay in the view currency (decisions 7 and 20).
 * The phrase that decided each value is shown so a wrong verdict is easy to spot.
 */
export function JobFacts({ job }: { job: JobFactsDto }) {
  const { eligibility, hours, pay } = job;
  return (
    <dl className="grid max-w-[68ch] gap-1.5 text-sm">
      <Row term="Who can apply">
        <span className="font-medium">{eligibility.label}</span>
        {eligibility.phrase && <q className="ml-2 text-muted-foreground">{eligibility.phrase}</q>}
        {job.locationText && <span className="block text-muted-foreground">{job.locationText}</span>}
      </Row>
      {hours && (
        <Row term="Hours">
          <span className="tabular-nums">{hours.manila}</span>
          <span className="ml-2 text-muted-foreground">posted as “{hours.phrase}”</span>
        </Row>
      )}
      <Row term="Pay">
        {pay === null ? (
          <span className="text-muted-foreground">Pay not stated</span>
        ) : (
          <>
            <span className="tabular-nums">{pay.converted ?? pay.posted}</span>
            {pay.converted && <span className="ml-2 text-muted-foreground tabular-nums">posted as {pay.posted}</span>}
            {pay.missingRate && (
              <Link
                to="/settings"
                hash="money"
                className="ml-2 text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Set a {pay.missingRate} rate to convert
              </Link>
            )}
          </>
        )}
      </Row>
      {job.expiresAt && (
        <Row term="Closes">
          <time dateTime={job.expiresAt} className="tabular-nums">
            {DATE.format(new Date(job.expiresAt))}
          </time>
        </Row>
      )}
    </dl>
  );
}

/** The two-line diff under a duplicate hint: what sets each job apart (section 3.8). */
export function DuplicateDiffLines({ diff }: { diff: PossibleDuplicate["diff"] }) {
  return (
    <dl className="grid gap-0.5">
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">This job</dt>
        <dd className="min-w-0 break-words">{diff.job}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">That job</dt>
        <dd className="min-w-0 break-words">{diff.other}</dd>
      </div>
    </dl>
  );
}

/**
 * The quiet "possibly the same job" hint (section 3.8) with the two-line diff, as the workspace
 * shows it. Merge lives in the Matches reading pane (`reading-pane.tsx`).
 */
export function PossibleDuplicates({ duplicates }: { duplicates: JobFactsDto["possibleDuplicates"] }) {
  if (duplicates.length === 0) return null;
  return (
    <ul aria-label="Possible duplicates" className="grid max-w-[68ch] gap-3 text-sm">
      {duplicates.map((d) => {
        const name = `${d.title} at ${d.company}`;
        return (
          <li key={d.jobId} className="grid gap-1 border-l-2 pl-3">
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
              )}
            </p>
            <DuplicateDiffLines diff={d.diff} />
          </li>
        );
      })}
    </ul>
  );
}
