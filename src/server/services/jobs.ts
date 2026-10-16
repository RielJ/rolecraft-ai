import { and, desc, eq, isNotNull } from "drizzle-orm";
import { applyUrlKey, companyKey, titleKey } from "@/domain/dedup";
import { contentHash, descriptionKey } from "@/domain/text";
import type { AddJobResult, BoardItemDto, PasteJobInput } from "@/shared/api";
import { FILE_KINDS } from "@/shared/enums";
import { jobs, opportunities, outputs } from "../db/schema";
import type { Deps } from "./context";
import { isReady } from "./workspace";

/**
 * Add a pasted job (section 3.2 step 6). Creates the job, its Saved opportunity and its three
 * empty file rows. A paste with the same apply URL and title returns the existing job: that
 * pair is DB-unique. Content dedup (company + title + description) arrives in slice 5.
 */
export async function addPastedJob(deps: Deps, input: PasteJobInput): Promise<AddJobResult> {
  const now = deps.clock.now();
  const url = input.url ?? null;
  const keys = {
    titleKey: titleKey(input.title),
    companyKey: companyKey(input.company),
    applyUrlKey: url === null ? null : applyUrlKey(url),
  };

  return deps.db.transaction(async (tx) => {
    if (keys.applyUrlKey !== null) {
      const [same] = await tx
        .select({ jobId: jobs.id, opportunityId: opportunities.id })
        .from(jobs)
        .leftJoin(opportunities, eq(opportunities.jobId, jobs.id))
        .where(
          and(eq(jobs.userId, deps.userId), eq(jobs.applyUrlKey, keys.applyUrlKey), eq(jobs.titleKey, keys.titleKey)),
        );
      if (same?.opportunityId) return { kind: "existing", opportunityId: same.opportunityId };
    }

    const [job] = await tx
      .insert(jobs)
      .values({
        userId: deps.userId,
        origin: "paste",
        title: input.title,
        company: input.company,
        ...keys,
        applyUrl: url,
        description: input.description,
        contentHash: contentHash({
          title: input.title,
          company: input.company,
          locationText: "",
          description: input.description,
          payPhrase: null,
        }),
        descriptionKey: descriptionKey(input.description),
        firstSeenAt: now,
        updatedAt: now,
      })
      .returning({ id: jobs.id });
    if (!job) throw new Error("Could not save the job.");

    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        userId: deps.userId,
        jobId: job.id,
        status: "saved",
        statusChangedAt: now,
        history: [{ at: now.toISOString(), from: null, to: "saved" }],
      })
      .returning({ id: opportunities.id });
    if (!opportunity) throw new Error("Could not save the job to the board.");

    await tx.insert(outputs).values(
      FILE_KINDS.map((kind, position) => ({
        userId: deps.userId,
        opportunityId: opportunity.id,
        kind,
        position,
      })),
    );
    return { kind: "created", opportunityId: opportunity.id };
  });
}

/** Board list. Slice 1 shows a plain list; status columns arrive in slice 4. */
export async function listBoard(deps: Deps): Promise<BoardItemDto[]> {
  const rows = await deps.db
    .select({
      opportunityId: opportunities.id,
      type: opportunities.type,
      status: opportunities.status,
      title: jobs.title,
      company: jobs.company,
      savedAt: opportunities.createdAt,
    })
    .from(opportunities)
    .innerJoin(jobs, eq(jobs.id, opportunities.jobId))
    .where(and(eq(opportunities.userId, deps.userId), isNotNull(opportunities.status)))
    .orderBy(desc(opportunities.createdAt));

  const items: BoardItemDto[] = [];
  for (const row of rows) {
    if (row.status === null) continue;
    items.push({
      ...row,
      status: row.status,
      savedAt: row.savedAt.toISOString(),
      ready: await isReady(deps, { opportunityId: row.opportunityId }),
    });
  }
  return items;
}
