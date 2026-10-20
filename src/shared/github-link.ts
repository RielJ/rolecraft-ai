/**
 * GitHub links on add-ons (decision 55). A repo link (`github.com/o/r`, with or without `.git` or a
 * trailing path) or a pull request link (`github.com/o/r/pull/N`) can be read; any other link is
 * stored only (decision 4).
 */

export type GithubRepoRef = { owner: string; repo: string };

export type GithubLink = ({ kind: "repo" } & GithubRepoRef) | ({ kind: "pull"; number: number } & GithubRepoRef);

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** First path segments that are GitHub pages, not accounts. */
const RESERVED = new Set([
  "about",
  "account",
  "apps",
  "collections",
  "customer-stories",
  "enterprise",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
]);

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** The path segments of a github.com URL, or null for any other host or scheme. */
function githubSegments(raw: string): string[] | null {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = URL.parse(withScheme);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username || url.password || url.port) return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.pathname.split("/").filter((s) => s !== "");
}

/** A repo or pull request link, or null when the link is anything else (stored only). */
export function parseGithubLink(raw: string): GithubLink | null {
  const segments = githubSegments(raw);
  if (!segments) return null;
  const [owner, rawRepo, section, number] = segments;
  if (owner === undefined || rawRepo === undefined) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || RESERVED.has(owner.toLowerCase())) return null;
  if (!REPO.test(repo) || repo === "." || repo === "..") return null;
  if (section === "pull") {
    if (number === undefined || !/^[1-9]\d{0,9}$/.test(number)) return null;
    return { kind: "pull", owner, repo, number: Number(number) };
  }
  return { kind: "repo", owner, repo };
}

/** The account name in a profile link like `https://github.com/juandc`, or null. */
export function githubProfileUser(raw: string): string | null {
  const segments = githubSegments(raw);
  if (segments?.length !== 1) return null;
  const [user] = segments;
  return user !== undefined && OWNER.test(user) && !RESERVED.has(user.toLowerCase()) ? user : null;
}

/** `owner/repo`, or `owner/repo#N` for a pull request. */
export function githubLabel(link: GithubLink): string {
  return link.kind === "pull" ? `${link.owner}/${link.repo}#${link.number}` : `${link.owner}/${link.repo}`;
}

const BASE = "https://github.com";

export function repoUrl({ owner, repo }: GithubRepoRef): string {
  return `${BASE}/${owner}/${repo}`;
}

export function commitUrl(ref: GithubRepoRef & { sha: string }): string {
  return `${repoUrl(ref)}/commit/${ref.sha}`;
}

/** A file at a branch or commit. Each path segment is escaped; the slashes stay. */
export function fileUrl(ref: GithubRepoRef & { at: string; path: string }): string {
  const path = ref.path.split("/").map(encodeURIComponent).join("/");
  return `${repoUrl(ref)}/blob/${encodeURIComponent(ref.at)}/${path}`;
}

export function pullUrl(ref: GithubRepoRef & { number: number }): string {
  return `${repoUrl(ref)}/pull/${ref.number}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every link into the given private repos from `text`: the repo itself and anything under
 * it (commits, files, pull requests), with or without `https://` or `www.`. A link left in empty
 * brackets takes them with it. Matching is case-insensitive, like GitHub's own paths.
 */
export function stripPrivateGithubUrls({ text, repos }: { text: string; repos: readonly GithubRepoRef[] }): string {
  if (repos.length === 0) return text;
  const names = repos.map((r) => `${escapeRegExp(r.owner)}/${escapeRegExp(r.repo)}`).join("|");
  // The repo name must end here (`o/r` must not match `o/r-other`), and a sentence's closing
  // punctuation is not part of the link.
  const url = new RegExp(
    String.raw`(?:https?://)?(?:www\.)?github\.com/(?:${names})(?:\.git)?(?![A-Za-z0-9_-]|\.[A-Za-z0-9])(?:[/?#](?:[^\s<>"'\])]*[^\s<>"'\]).,;:!?])?)?`,
    "gi",
  );
  const stripped = text.replace(url, "");
  if (stripped === text) return text;
  return stripped
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

/** Whether `link` points into one of `repos` (same rule as `stripPrivateGithubUrls`). */
export function isPrivateGithubUrl({ link, repos }: { link: string; repos: readonly GithubRepoRef[] }): boolean {
  return stripPrivateGithubUrls({ text: link, repos }) !== link;
}
