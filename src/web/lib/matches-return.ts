import { z } from "zod";
import { JobId, OpportunityId } from "@/shared/api";

/**
 * Start application leaves Matches for the workspace. This remembers the job after the one you
 * started, so the workspace's "Next match" link returns to it rather than to the top of the list.
 * Session storage: it lasts as long as the tab.
 */
const KEY = "hb.matches.return";
const Return = z.object({ opportunityId: OpportunityId, nextJobId: JobId.nullable() });
export type MatchesReturn = z.infer<typeof Return>;

export function rememberReturn(value: MatchesReturn): void {
  sessionStorage.setItem(KEY, JSON.stringify(value));
}

/** The stored return, if any. Broken or foreign data reads as none. */
export function readReturn(): MatchesReturn | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = Return.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Matches calls this once it has used the return, so a later visit starts fresh. */
export function clearReturn(): void {
  sessionStorage.removeItem(KEY);
}
