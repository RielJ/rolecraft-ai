import { asc, eq } from "drizzle-orm";
import { compileSkills, type SkillDictionary } from "@/domain/features";
import { customSkillNames, normalizeSkillName } from "@/domain/user-skills";
import type { UserSkillKind } from "@/shared/enums";
import { userSkills } from "../db/schema";
import type { Deps } from "./context";

/**
 * The user's own skill list (decision 66), read as the app role. Refresh reads it here, before it
 * switches to `hb_sync`, and passes the compiled dictionary in: the sync role has no grant on
 * `user_skills`. Drafting never reads it (test/draft.test.ts).
 */

export type UserSkillRow = { name: string; kind: UserSkillKind };

/** The user's rows, oldest first, with names cleaned again so a skill built in since reads as built in. */
export async function loadUserSkillRows(deps: Pick<Deps, "db" | "userId">): Promise<UserSkillRow[]> {
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
export async function loadSkillDictionary(deps: Pick<Deps, "db" | "userId">): Promise<SkillDictionary> {
  return compileSkills(customSkillNames(await loadUserSkillRows(deps)));
}
