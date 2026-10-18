import { and, eq } from "drizzle-orm";
import { applyUrlKey } from "@/domain/dedup";
import type { AddJobResult } from "@/shared/api";
import type { ImportJobInput, LookupQuery, LookupResult } from "@/shared/extension";
import { jobs, opportunities } from "../db/schema";
import { AppError, type Deps } from "./context";
import { addPastedJob } from "./jobs";

// Lookup and import for the extension panel (docs/plans/chrome-extension.md, Task 7). The panel
// asks whether the visible page is a known job before it offers to import it. Lookup only reads;
// import is the web app's paste path, origin `paste`.

/**
 * The job whose apply URL has the same `applyUrlKey` as `url`, with its opportunity if any. Reads
 * only. Several jobs on one key (a generic careers page) answer `none`, as add-by-link does: the
 * import then matches on the title too, so the panel never names the wrong job.
 */
export async function lookupByUrl(deps: Pick<Deps, "db" | "userId">, { url }: LookupQuery): Promise<LookupResult> {
  const key = applyUrlKey(url);
  if (key === null) {
    throw new AppError({ code: "invalid_input", message: "Only http and https pages can be looked up." });
  }
  const rows = await deps.db
    .select({
      title: jobs.title,
      company: jobs.company,
      opportunityId: opportunities.id,
      status: opportunities.status,
    })
    .from(jobs)
    .leftJoin(opportunities, and(eq(opportunities.jobId, jobs.id), eq(opportunities.userId, deps.userId)))
    .where(and(eq(jobs.userId, deps.userId), eq(jobs.applyUrlKey, key)))
    .limit(2);
  const [only] = rows;
  if (!only || rows.length > 1) return { kind: "none" };
  return {
    kind: "found",
    opportunityId: only.opportunityId,
    title: only.title,
    company: only.company,
    status: only.status,
  };
}

/** Add the page the user reviewed in the panel, exactly as a paste in the web app would. */
export async function importJob(deps: Deps, input: ImportJobInput): Promise<AddJobResult> {
  return addPastedJob(deps, input);
}
