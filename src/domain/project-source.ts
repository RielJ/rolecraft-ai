import { type GithubLink, parseGithubLink, pullUrl, repoUrl } from "@/shared/github-link";
import {
  type LocalFolder,
  type LocalHideReason,
  localAddon,
  parseGithubRemote,
  readmeSummary,
  scanLocal,
} from "./local-scan";
import { repoAddon } from "./repo-scan";

/**
 * Filling the add-on form from one project (decision 80): a GitHub repo or pull request link, a
 * GitLab project link, or a folder path. Nothing is saved here; the form shows the result for the
 * user to edit and save.
 */

export type ProjectSource =
  | { kind: "github"; link: GithubLink }
  | { kind: "gitlab"; host: string; path: string }
  | { kind: "folder"; path: string };

/** What the form is filled with. */
export type AddonPrefill = {
  title: string;
  body: string;
  link: string | null;
  skills: string[];
  /** The link is to a private repo, or one whose visibility is unknown: exports leave it out. */
  linkPrivate: boolean;
  /** Something the user should know before saving, or null. */
  note: string | null;
};

export const SOURCE_HELP = "Paste a GitHub or GitLab link, or a folder path starting with / or ~/.";

const GITLAB_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/** `group/sub/project` from a GitLab URL path; `/-/tree/main`, `.git` and trailing slashes go. */
function gitlabPath(pathname: string): string | null {
  const segments = pathname.split("/-/")[0]?.split("/").filter(Boolean) ?? [];
  const last = segments.at(-1);
  if (last) segments[segments.length - 1] = last.replace(/\.git$/i, "");
  if (segments.length < 2 || !segments.every((s) => GITLAB_PATH.test(s))) return null;
  return segments.join("/");
}

/**
 * What a pasted text points to. GitLab is read on gitlab.com and on hosts in `gitlabHosts`
 * (`HB_GITLAB_HOSTS`) only, so a paste never makes the server call an arbitrary host.
 */
export function parseProjectSource({
  raw,
  gitlabHosts,
}: {
  raw: string;
  gitlabHosts: readonly string[];
}): ProjectSource | { kind: "unknown"; message: string } {
  const text = raw.trim();
  if (text === "") return { kind: "unknown", message: SOURCE_HELP };
  if (text.startsWith("/") || text === "~" || text.startsWith("~/")) return { kind: "folder", path: text };

  // SSH remotes, as `git remote -v` prints them.
  const ssh = /^git@([^:/\s]+):(.+)$/.exec(text);
  const githubRemote = parseGithubRemote(text);
  if (githubRemote) return { kind: "github", link: { kind: "repo", ...githubRemote } };

  const url = URL.parse(
    ssh ? `https://${ssh[1]}/${ssh[2]}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
  );
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return { kind: "unknown", message: SOURCE_HELP };
  }
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const link = parseGithubLink(url.href);
    return link
      ? { kind: "github", link }
      : { kind: "unknown", message: "That GitHub link isn't a repo or a pull request." };
  }
  const allowed = ["gitlab.com", ...gitlabHosts.map((h) => h.trim().toLowerCase())];
  if (allowed.includes(host) && !url.port) {
    const path = gitlabPath(url.pathname);
    return path ? { kind: "gitlab", host, path } : { kind: "unknown", message: "That GitLab link isn't a project." };
  }
  if (host.includes("gitlab") && !allowed.includes(host)) {
    return { kind: "unknown", message: `To read ${host}, add it to HB_GITLAB_HOSTS and restart the app.` };
  }
  return { kind: "unknown", message: SOURCE_HELP };
}

// ---------- GitHub ----------

/** One repo or pull request, as the GitHub reader's `about` reports it. */
export type GithubAbout = {
  owner: string;
  repo: string;
  private: boolean;
  description: string | null;
  language: string | null;
  readme: string | null;
  pull: { number: number; title: string; body: string | null } | null;
};

/** An add-on from a GitHub repo or pull request. A repo you don't own gets a note to say your part. */
export function githubPrefill({ about, user }: { about: GithubAbout; user: string | null }): AddonPrefill {
  const others = user !== null && about.owner.toLowerCase() !== user.toLowerCase();
  if (about.pull) {
    const summary = readmeSummary(about.pull.body);
    const where = `${about.owner}/${about.repo}`;
    return {
      title: about.pull.title.trim().slice(0, 200),
      body: summary ? `Pull request to ${where}: ${summary}` : `Pull request to ${where}.`,
      link: pullUrl({ owner: about.owner, repo: about.repo, number: about.pull.number }),
      skills: about.language ? [about.language] : [],
      linkPrivate: about.private,
      note: null,
    };
  }
  const addon = repoAddon({
    owner: about.owner,
    name: about.repo,
    description: about.description,
    language: about.language,
    localSummary: readmeSummary(about.readme),
  });
  return {
    ...addon,
    link: repoUrl({ owner: about.owner, repo: about.repo }),
    linkPrivate: about.private,
    note: others
      ? `${about.owner} owns this repo, not ${user}. Write what you did in it, or link your pull request instead.`
      : null,
  };
}

// ---------- GitLab ----------

/** One public GitLab project, as the GitLab reader reports it. */
export type GitlabAbout = {
  name: string;
  webUrl: string;
  description: string | null;
  /** Most used first. */
  languages: string[];
  readme: string | null;
};

export function gitlabPrefill(about: GitlabAbout): AddonPrefill {
  const description = about.description?.trim() || readmeSummary(about.readme);
  return {
    title: about.name.slice(0, 200),
    body: description || `${about.name}, a project on GitLab.`,
    link: about.webUrl,
    skills: about.languages.slice(0, 3),
    linkPrivate: false,
    note: null,
  };
}

// ---------- A folder ----------

const FOLDER_NOTES: Record<LocalHideReason, string> = {
  not_git: "This folder isn't a git repo, so nothing shows the work is yours.",
  few_commits:
    "Few of this repo's commits use your email. Check it's yours, or add your other emails to HB_GIT_EMAILS.",
  others: "Most of this repo's commits are by someone else. Write what you did in it.",
  same_remote: "",
};

/** An add-on from one folder, judged by the same rules as the folder scan (decision 79). */
export function folderPrefill({
  folder,
  emails,
  githubUser,
}: {
  folder: LocalFolder;
  emails: readonly string[];
  githubUser: string | null;
}): AddonPrefill {
  const scanned = scanLocal({ folders: [folder], emails, githubUser, listed: null, linked: [], titles: [] });
  const [repo] = [...scanned.shown, ...scanned.hidden];
  if (!repo) throw new Error("A scan of one folder returned none.");
  const addon = localAddon(repo);
  // A remote on GitHub that isn't yours, or a GitLab remote, is still worth linking.
  const remote = folder.git?.remote ?? null;
  const theirs = remote && !addon.link ? publicRemoteUrl(remote) : null;
  return {
    title: addon.title,
    body: addon.body,
    link: addon.link ?? theirs,
    skills: addon.skills,
    // Visibility is unknown without reading the repo: kept out of exports until a read says public.
    linkPrivate: addon.link !== null || theirs !== null,
    note: (repo.hiddenBy && FOLDER_NOTES[repo.hiddenBy]) || null,
  };
}

/** A remote as a browsable https URL, for GitHub and GitLab remotes; null for anything else. */
function publicRemoteUrl(remote: string): string | null {
  const github = parseGithubRemote(remote);
  if (github) return repoUrl(github);
  const ssh = /^git@(gitlab\.com):(.+?)(?:\.git)?$/.exec(remote.trim());
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/(gitlab\.com)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return https ? `https://${https[1]}/${https[2]}` : null;
}
