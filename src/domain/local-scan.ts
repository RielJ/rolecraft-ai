import type { GithubRepoRef } from "@/shared/github-link";
import { type CloneInfo, MIN_OWN_COMMITS, repoKey } from "./repo-scan";

/**
 * Finding the user's projects in a local folder (decision 78). Rules only, no AI: a folder is the
 * user's when most of its commits are by one of the user's emails. Folders that aren't git repos,
 * repos with few commits by the user, and repos mostly by others go to the hidden group with their
 * reason; the user can still pick them. So does a clone of a GitHub repo someone else owns, such as
 * an employer's, even when the commits are the user's (decision 85). A repo whose remote is one of the user's listed GitHub
 * repos is shown once, under GitHub.
 */

/** One folder in the projects folder, as the reader found it. */
export type LocalFolder = {
  folder: string;
  /** Null when the folder is not a git repo. */
  git: {
    /** Commit counts by author email, as written in the commits. */
    authors: Readonly<Record<string, number>>;
    /** ISO 8601 of the newest commit, or null for a repo with no commits. */
    lastCommitAt: string | null;
    /** `remote.origin.url`, or null. */
    remote: string | null;
  } | null;
  /** Names of the files at the folder's root, for the language guess. */
  rootFiles: readonly string[];
  /** The README's text (at most 64 KB), or null. */
  readme: string | null;
};

/** The longest add-on text taken from a README. */
export const MAX_SUMMARY_CHARS = 1500;

export type LocalHideReason = "not_git" | "owned_by" | "few_commits" | "others" | "same_remote";

export type ScannedLocal = {
  folder: string;
  ownCommits: number;
  totalCommits: number;
  lastCommitAt: string | null;
  /** The GitHub repo the remote points to, when it is one of the user's. */
  github: GithubRepoRef | null;
  /** The owner of the GitHub remote, when it isn't the user: why the folder is `owned_by`. */
  remoteOwner: string | null;
  languages: string[];
  /** The README's first paragraph, cleaned, or null. */
  summary: string | null;
  added: boolean;
  hiddenBy: LocalHideReason | null;
};

export type LocalScan = {
  shown: ScannedLocal[];
  hidden: ScannedLocal[];
  /** Folders shown under GitHub instead, as clones of a listed repo. */
  onGithub: number;
  /** By `repoKey`: the best clone of each listed GitHub repo. */
  clones: Map<string, CloneInfo>;
};

// ---------- Remotes and emails ----------

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git` → o/r. */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const m = url
    .trim()
    .match(
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    );
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/** Whether a commit email is the user's: a configured email, or the GitHub noreply of `githubUser`. */
export function isOwnEmail({
  email,
  emails,
  githubUser,
}: {
  email: string;
  emails: ReadonlySet<string>;
  githubUser: string | null;
}): boolean {
  const e = email.trim().toLowerCase();
  if (emails.has(e)) return true;
  if (!githubUser) return false;
  const user = githubUser.toLowerCase();
  return (
    e === `${user}@users.noreply.github.com` ||
    new RegExp(`^\\d+\\+${escapeRegExp(user)}@users\\.noreply\\.github\\.com$`).test(e)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Language and README ----------

/** Root files that name a language, in the order they are listed. */
const LANGUAGE_MARKERS: readonly (readonly [string, string])[] = [
  ["tsconfig.json", "TypeScript"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["setup.py", "Python"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["build.gradle.kts", "Kotlin"],
  ["pom.xml", "Java"],
  ["build.gradle", "Java"],
  ["Package.swift", "Swift"],
  ["pubspec.yaml", "Dart"],
  ["mix.exs", "Elixir"],
  ["package.json", "JavaScript"],
];

/** Languages guessed from root files, at most three. `package.json` counts only without TypeScript. */
export function guessLanguages(rootFiles: readonly string[]): string[] {
  const files = new Set(rootFiles);
  const found: string[] = [];
  for (const [file, language] of LANGUAGE_MARKERS) {
    if (!files.has(file) || found.includes(language)) continue;
    if (language === "JavaScript" && found.includes("TypeScript")) continue;
    found.push(language);
  }
  return found.slice(0, 3);
}

/** Markdown and HTML reduced to plain words: links keep their text, images and tags go. */
function plain(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SKIP_LINE = /^(#|={3,}|-{3,}|\*{3,}|\||!\[|\[!\[|<|[\u2500-\u257f])/;
const LIST_ITEM = /^([-*+]|\d+[.)])\s+/;

/**
 * The README's opening paragraph, as plain text: headings, badges, HTML, tables, code blocks and
 * box drawing are skipped. A paragraph ending in ":" keeps the list right after it. Null when no
 * prose is found.
 */
/** Openers project generators write; a README starting with one says nothing about the project. */
const BOILERPLATE =
  /\b(bootstrapped with|this template (should help|provides a minimal setup)|generated (by|with) (create-|cargo-generate|the \w+ cli))/i;

export function readmeSummary(readme: string | null): string | null {
  if (!readme) return null;
  const lines = readme.replace(/\r\n?/g, "\n").split("\n");
  const blocks: { list: boolean; lines: string[] }[] = [];
  let current: { list: boolean; lines: string[] } | null = null;
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      current = null;
      continue;
    }
    // A setext heading: the line above "===" or "---" was a title, not prose.
    if (/^(={3,}|-{3,})$/.test(line) && current && !current.list) {
      current.lines.pop();
      if (current.lines.length === 0) blocks.pop();
      current = null;
      continue;
    }
    if (fenced || line === "" || SKIP_LINE.test(line)) {
      current = null;
      continue;
    }
    const list = LIST_ITEM.test(line);
    if (!current || current.list !== list) {
      current = { list, lines: [] };
      blocks.push(current);
    }
    current.lines.push(list ? `- ${plain(line.replace(LIST_ITEM, ""))}` : plain(line));
  }
  const first = blocks.findIndex((b) => !b.list && b.lines.join(" ").trim() !== "");
  if (first < 0) return null;
  const paragraph = blocks[first]?.lines.join(" ").trim() ?? "";
  if (BOILERPLATE.test(paragraph)) return null;
  const next = blocks[first + 1];
  const text = paragraph.endsWith(":") && next?.list ? `${paragraph}\n${next.lines.join("\n")}` : paragraph;
  return cap(text);
}

function cap(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const cut = text.slice(0, MAX_SUMMARY_CHARS);
  const sentence = cut.lastIndexOf(". ");
  return sentence > MAX_SUMMARY_CHARS / 2 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// ---------- The scan ----------

function hiddenBy({
  git,
  own,
  total,
  remoteOwner,
}: {
  git: LocalFolder["git"];
  own: number;
  total: number;
  remoteOwner: string | null;
}): LocalHideReason | null {
  if (!git) return "not_git";
  if (remoteOwner) return "owned_by";
  if (total > 0 && own * 2 < total) return "others";
  if (own < MIN_OWN_COMMITS) return "few_commits";
  return null;
}

/** Newest commit first, then more commits by the user, then folder name. */
function byActivity(a: ScannedLocal, b: ScannedLocal): number {
  const last = (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "");
  return last || b.ownCommits - a.ownCommits || a.folder.localeCompare(b.folder);
}

/**
 * Every folder, split into shown and hidden by rules. A clone of a repo in `listed` (the user's
 * GitHub listing) is left out and returned in `clones`, so it shows once, under GitHub. Two folders
 * on one remote that isn't listed: the newest is kept and the other is hidden as `same_remote`.
 */
export function scanLocal({
  folders,
  emails,
  githubUser,
  listed,
  linked,
  titles,
}: {
  folders: readonly LocalFolder[];
  /** The user's commit emails, any case. */
  emails: readonly string[];
  /** `HB_GITHUB_USER`: its noreply emails count as the user's, and its repos get links. */
  githubUser: string | null;
  /**
   * `repoKey`s of the user's GitHub repos, or null without a gh listing. With one, the user's own
   * remote that isn't listed is gone (deleted or renamed), so the folder gets no link.
   */
  listed: ReadonlySet<string> | null;
  /** Repos that add-ons already link. */
  linked: readonly GithubRepoRef[];
  /** Titles of add-ons without a link, any case: a folder added before matches its title. */
  titles: readonly string[];
}): LocalScan {
  const own = new Set(emails.map((e) => e.trim().toLowerCase()));
  const taken = new Set(linked.map(repoKey));
  const takenTitles = new Set(titles.map((t) => t.trim().toLowerCase()));
  const clones = new Map<string, CloneInfo>();
  const all: ScannedLocal[] = [];
  let onGithub = 0;

  for (const f of folders) {
    // An author without an "@" ("local", "root") names no one: it is neither the user nor others.
    const authors = Object.entries(f.git?.authors ?? {}).filter(([email]) => email.includes("@"));
    const ownCommits = authors.reduce(
      (n, [email, count]) => n + (isOwnEmail({ email, emails: own, githubUser }) ? count : 0),
      0,
    );
    const totalCommits = authors.reduce((n, [, count]) => n + count, 0);
    const remote = f.git?.remote ? parseGithubRemote(f.git.remote) : null;
    const summary = readmeSummary(f.readme);
    if (remote && listed?.has(repoKey(remote))) {
      onGithub += 1;
      const prev = clones.get(repoKey(remote));
      if (!prev || ownCommits > prev.ownCommits) clones.set(repoKey(remote), { ownCommits, summary });
      continue;
    }
    const ownRemote = remote && githubUser ? remote.owner.toLowerCase() === githubUser.toLowerCase() : null;
    const mine = remote && !listed && ownRemote ? remote : null;
    // Without HB_GITHUB_USER no owner can be judged, so nothing is hidden for it.
    const remoteOwner = remote && ownRemote === false ? remote.owner : null;
    all.push({
      folder: f.folder,
      ownCommits,
      totalCommits,
      lastCommitAt: f.git?.lastCommitAt ?? null,
      github: mine,
      remoteOwner,
      languages: guessLanguages(f.rootFiles),
      summary,
      added: mine ? taken.has(repoKey(mine)) : takenTitles.has(f.folder.toLowerCase()),
      hiddenBy: hiddenBy({ git: f.git, own: ownCommits, total: totalCommits, remoteOwner }),
    });
  }

  // One folder per unlisted remote: the newest stays, the rest are hidden.
  const sorted = all.toSorted(byActivity);
  const seen = new Set<string>();
  for (const repo of sorted) {
    if (!repo.github) continue;
    const key = repoKey(repo.github);
    if (seen.has(key) && repo.hiddenBy === null) repo.hiddenBy = "same_remote";
    seen.add(key);
  }
  return {
    shown: sorted.filter((r) => r.hiddenBy === null),
    hidden: sorted.filter((r) => r.hiddenBy !== null),
    onGithub,
    clones,
  };
}

/** The add-on a picked folder becomes. A private or unknown repo is treated as private (decision 55). */
export function localAddon(repo: ScannedLocal): {
  title: string;
  body: string;
  link: string | null;
  skills: string[];
  githubPrivate: boolean | null;
} {
  const [language] = repo.languages;
  const fallback = language ? `${repo.folder}, a ${language} project.` : `${repo.folder}, a personal project.`;
  return {
    title: repo.folder,
    body: repo.summary ?? fallback,
    link: repo.github ? `https://github.com/${repo.github.owner}/${repo.github.repo}` : null,
    skills: repo.languages,
    // Not in the gh listing, so its visibility is unknown: links stay out of exports until a read.
    githubPrivate: repo.github ? true : null,
  };
}
