import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { JobList } from "@/shared/api";
import { jobListings, jobs, opportunities, sources } from "../db/schema";
import type { Deps } from "./context";

/**
 * The plain Matches list for slice 6: open jobs, newest first, with where each was seen.
 * Matching, levels, filters and save/dismiss arrive in slice 7. Dismissed jobs are hidden.
 */
export async function listOpenJobs(deps: Pick<Deps, "db" | "userId">): Promise<JobList> {
  const rows = await deps.db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      locationText: jobs.locationText,
      firstSeenAt: jobs.firstSeenAt,
      applyUrl: jobs.applyUrl,
      opportunityId: opportunities.id,
      dismissedAt: opportunities.dismissedAt,
    })
    .from(jobs)
    .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
    .where(and(eq(jobs.userId, deps.userId), isNull(jobs.closedAt)))
    .orderBy(desc(jobs.firstSeenAt), asc(jobs.title))
    .limit(500);
  const shown = rows.filter((r) => r.dismissedAt === null);
  const ids = shown.map((r) => r.id);
  const listings =
    ids.length === 0
      ? []
      : await deps.db
          .select({ jobId: jobListings.jobId, label: sources.label, listingUrl: jobListings.listingUrl })
          .from(jobListings)
          .innerJoin(sources, eq(sources.id, jobListings.sourceId))
          .where(inArray(jobListings.jobId, ids))
          .orderBy(desc(jobListings.isPrimary), asc(sources.label));
  return {
    jobs: shown.map((r) => ({
      id: r.id,
      title: r.title,
      company: r.company,
      locationText: r.locationText,
      firstSeenAt: r.firstSeenAt.toISOString(),
      applyUrl: r.applyUrl,
      opportunityId: r.opportunityId,
      seenOn: listings.filter((l) => l.jobId === r.id).map(({ label, listingUrl }) => ({ label, listingUrl })),
    })),
  };
}
