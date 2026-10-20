import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { compileSkills, type SkillDictionary } from "@/domain/features";
import { splitNiceToHave } from "@/domain/skill-sections";
import { customSkillNames, dictionaryStamp, normalizeSkillName } from "@/domain/user-skills";
import type { JobId, UserId } from "@/shared/api";
import type { UserSkillKind } from "@/shared/enums";
import type { DbOrTx, Tx } from "../db/client";
import { jobs, userSkills } from "../db/schema";

/**
 * The user's own skill list (decision 66), read as the app role. Refresh reads it here, before it
 * switches to `hb_sync`, and passes the compiled dictionary in: the sync role has no grant on
 * `user_skills`. Drafting never reads it (test/draft.test.ts).
 */

export type UserSkillRow = { name: string; kind: UserSkillKind };
type Scope = { db: DbOrTx; userId: UserId };

/** The user's rows, oldest first, with names cleaned again so a skill built in since reads as built in. */
export async function loadUserSkillRows(deps: Scope): Promise<UserSkillRow[]> {
  const rows = await deps.db
    .select({ name: userSkills.name, kind: userSkills.kind })
    .from(userSkills)
    .where(eq(userSkills.userId, deps.userId))
    .orderBy(asc(userSkills.createdAt), asc(userSkills.key));
  return rows.map((row) => {
    const clean = normalizeSkillName(row.name);
    return { name: clean.kind === "ok" ? clean.name : row.name, kind: row.kind };
  });
}

/** The dictionary jobs are read with: the built-ins, then the user's added skills that are not built in. */
export async function loadSkillDictionary(deps: Scope): Promise<SkillDictionary> {
  return compileSkills(customSkillNames(await loadUserSkillRows(deps)));
}

/**
 * Bring stored jobs in line with a change to the user's own skills (decision 68). Runs inside
 * `setSkill`'s transaction, as the app role, after the row is written; `before` and `after` are
 * the dictionaries on either side of it. The caller holds `MERGE_SYNC_LOCK` exclusive, so no sync
 * transaction writes a job between this read and its commit.
 *
 * - A removed name leaves every job's skills, open or closed, through `array_remove`.
 * - An added name: Postgres keeps the open jobs whose text contains one of its pieces, lowercased
 *   by `lower` on both sides, and the exact regex decides on those. `lower` is not the regex's
 *   case folding: a text that writes a letter as ſ or the Kelvin sign K matches the regex but is
 *   not found here. A name with an empty piece reads every open job.
 * - Open jobs that held the old stamp take the new one. A job with any other stamp was read with
 *   another list and stays stale, so the next Refresh reads it again.
 */
export async function applySkillChange(
  tx: Tx,
  { userId, before, after }: { userId: UserId; before: SkillDictionary; after: SkillDictionary },
): Promise<void> {
  const from = dictionaryStamp(before);
  const to = dictionaryStamp(after);
  if (from === to) return;
  const mine = eq(jobs.userId, userId);
  const removed = before.custom.filter((n) => !after.custom.includes(n));
  const added = after.custom.filter((n) => !before.custom.includes(n));

  // A list goes as one JSON parameter: drizzle spreads a bare array into separate parameters.
  const textArray = (list: readonly string[]) =>
    sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`;
  // `IN (subquery)` is hashed once; `= ANY(array)` would compare each row with every id.
  const idIn = (ids: readonly string[]) =>
    sql`${jobs.id} IN (SELECT e::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) e)`;

  // The new skills: removed names dropped, then each added name appended to the jobs it matches,
  // and to their nice skills where the posting names it only in its nice-to-have text.
  let skills = sql`${jobs.skills}`;
  let niceSkills = sql`${jobs.niceSkills}`;
  const touched: JobId[] = [];
  for (const name of removed) {
    skills = sql`array_remove(${skills}, ${name})`;
    niceSkills = sql`array_remove(${niceSkills}, ${name})`;
  }
  for (const name of added) {
    const patterns = after.patterns.filter((p) => p.name === name);
    const text = sql`lower(${jobs.title} || E'\n' || ${jobs.description})`;
    const contains = patterns.some((p) => p.piece === "")
      ? undefined
      : or(...patterns.map((p) => sql`strpos(${text}, lower(${p.piece})) > 0`));
    const candidates = await tx
      .select({ id: jobs.id, title: jobs.title, description: jobs.description })
      .from(jobs)
      .where(and(mine, isNull(jobs.closedAt), sql`NOT (${name} = ANY(${jobs.skills}))`, contains));
    // The same text and patterns `jobSkills` reads.
    const named = (text: string) => patterns.some((p) => p.re.test(text));
    const matched = candidates.filter((job) => named(`${job.title}\n${job.description}`));
    if (matched.length === 0) continue;
    const ids = matched.map((job) => job.id);
    touched.push(...ids);
    skills = sql`CASE WHEN ${idIn(ids)} THEN array_append(${skills}, ${name}) ELSE ${skills} END`;
    const nice = matched
      .filter((job) => {
        const split = splitNiceToHave(job.description);
        return named(split.nice) && !named(`${job.title}\n${split.main}`);
      })
      .map((job) => job.id);
    if (nice.length > 0) {
      niceSkills = sql`CASE WHEN ${idIn(nice)} THEN array_append(${niceSkills}, ${name}) ELSE ${niceSkills} END`;
    }
  }

  // One statement: jobs that drop a removed name or gain an added one, and open jobs that held the
  // old stamp, which take the new one.
  const holdsRemoved = removed.length > 0 ? sql`${jobs.skills} && ${textArray(removed)}` : sql`false`;
  const stale = and(isNull(jobs.closedAt), eq(jobs.skillsStamp, from));
  await tx
    .update(jobs)
    .set({
      skills,
      niceSkills,
      skillsStamp: sql`CASE WHEN ${stale} THEN ${to} ELSE ${jobs.skillsStamp} END`,
    })
    .where(and(mine, or(stale, holdsRemoved, touched.length > 0 ? idIn(touched) : undefined)));
}
