import type { ProfileItemKind, ProjectRole } from "@/shared/enums";
import { githubProfileUser, parseGithubLink } from "@/shared/github-link";

/** Where the user's GitHub account name came from. */
export type GithubUserFrom = "HB_GITHUB_USER" | "profile link";
export type GithubUser = { user: string; from: GithubUserFrom };

/**
 * The account whose commits count as the user's: `HB_GITHUB_USER` when set (always with gh, which
 * is pinned to it), else the first `github.com/<name>` profile link in the contact links.
 */
export function githubUserFor({
  configured,
  links,
}: {
  configured: string | null;
  links: readonly string[];
}): GithubUser | null {
  if (configured) return { user: configured, from: "HB_GITHUB_USER" };
  for (const link of links) {
    const user = githubProfileUser(link);
    if (user) return { user, from: "profile link" };
  }
  return null;
}

/** Who decided a project's role: the user in the add-on form, the last read, or its link's owner. */
export type ProjectRoleFrom = "you" | "read" | "link";

/**
 * Whether a project add-on is the user's own project or a contribution (decision 82). The user's
 * choice wins, then the last read's commit share. Before a read, a GitHub link another account
 * owns, or any pull request link, is a contribution, and anything else is the user's own. Null for
 * add-ons that are not projects.
 */
export function projectRoleOf({
  kind,
  choice,
  read,
  link,
  githubUser,
}: {
  kind: ProfileItemKind;
  choice: ProjectRole | null;
  read: ProjectRole | null;
  link: string | null;
  githubUser: string | null;
}): { role: ProjectRole; from: ProjectRoleFrom } | null {
  if (kind !== "open_source") return null;
  if (choice) return { role: choice, from: "you" };
  if (read) return { role: read, from: "read" };
  const parsed = link ? parseGithubLink(link) : null;
  if (!parsed) return { role: "own", from: "link" };
  if (parsed.kind === "pull") return { role: "contribution", from: "link" };
  const theirs = githubUser !== null && parsed.owner.toLowerCase() !== githubUser.toLowerCase();
  return { role: theirs ? "contribution" : "own", from: "link" };
}
