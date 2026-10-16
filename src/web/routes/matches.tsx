import { Link } from "@tanstack/react-router";
import type { JobListItem } from "@/shared/api";
import { errorMessage } from "../api";
import { useJobs } from "../queries";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const DATE = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });

function JobRow({ job }: { job: JobListItem }) {
  const where = job.seenOn.map((s) => s.label).join(", ");
  return (
    <li className="grid gap-1 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {job.opportunityId ? (
          <Link
            to="/jobs/$opportunityId"
            params={{ opportunityId: job.opportunityId }}
            className="font-medium hover:underline"
          >
            {job.title}
          </Link>
        ) : job.applyUrl ? (
          <a href={job.applyUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
            {job.title}
          </a>
        ) : (
          <span className="font-medium">{job.title}</span>
        )}
        <span className="text-muted-foreground">{job.company}</span>
      </div>
      <p className="text-muted-foreground text-sm">
        {[job.locationText, where && `Seen on ${where}`, `Found ${DATE.format(new Date(job.firstSeenAt))}`]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  );
}

/** A plain list of open jobs. Match levels, filters and save/dismiss arrive in slice 7. */
export function MatchesPage() {
  const jobs = useJobs();
  return (
    <div className="grid gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">Matches</h1>
      {jobs.isPending ? (
        <div className="grid max-w-3xl gap-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : jobs.isError ? (
        <div
          role="alert"
          className="flex max-w-3xl items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm"
        >
          <span>Could not load jobs. {errorMessage(jobs.error)}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => jobs.refetch()}>
            Retry
          </Button>
        </div>
      ) : jobs.data.jobs.length === 0 ? (
        <p className="max-w-3xl text-muted-foreground">
          No open jobs yet. Press Refresh to read your sources, or add a company board under{" "}
          <Link to="/sources" className="underline">
            Sources
          </Link>
          .
        </p>
      ) : (
        <ul aria-label="Open jobs" className="max-w-3xl divide-y border-y">
          {jobs.data.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </div>
  );
}
