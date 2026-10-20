# Plan: finding your projects (slice 19, decision 78)

Decided with the user on 2026-10-20. Builds on slice 14 (GitHub add-ons, decision 55).

## Problem

A side project reaches drafts only after the user adds it as an add-on by hand: one dialog per repo, with a title, a description and the link typed in. Most users have more projects than they remember to add, and the ones they forget are often the ones a posting asks about.

## What the data shows (measured 2026-10-20 on the user's own accounts)

- **GitHub, public API.** `users/rielj/repos?type=owner` returns 62 repos in one request. 25 are forks, one is the profile README repo (`RielJ/RielJ`), and 7 are under 5 KB (a README and nothing else). That leaves 29 worth showing. Private repos such as `point-of-sale` and `akashic` are missing; only the gh reader sees them.
- **Commit share needs one request per repo.** The contributors list is per repo, so checking "mostly yours" for 29 repos would use half of the 60 unauthenticated requests an hour. Forks already catch the clear cases (`sqlc-gen-typescript`, where 14 of 23 commits are someone else's, is a fork).
- **Local folder.** `~/personal/projects` holds 24 folders: 19 are git repos and 6 of those have no remote (`hanapbuhay`, `pi-adw`, `jersey-studio`, …), so GitHub never sees them. Commit authors separate own work from clones: `pi-mux-ref` has 0 of 31 commits by the user, `job-hunter` has 1 commit by `local`. Two folders (`point-of-sale`, `pos-2`) share one remote.
- **Pull requests to other people's projects** (238 merged; nearly all to an employer's private repo) stay out. A PR link can still be pasted as an add-on (decision 55).

## Decisions

1. **gh only.** The scan runs through the local `gh` CLI (`HB_GITHUB=gh`), pinned to `HB_GITHUB_USER` as in decision 55. The user's machine is signed in to two accounts (`RielJ` and a work account), and a scan is refused before any list request when gh's active account is not `HB_GITHUB_USER`. Without `HB_GITHUB=gh` the Find button is hidden; the public API and fixture readers don't list. gh also lists the 13 private repos the public API can't see.
2. **Own repos only.** `user/repos?affiliation=owner`: repos the account owns, never organization repos, so an employer's code never shows up.
3. **Rules suggest; the user decides.** Detection makes no AI call and costs nothing.
   - Hidden by rules: forks, the profile README repo (`<user>/<user>`), and repos under 5 KB. Archived repos stay. A hidden repo is not dropped: it sits in a collapsed "Hidden by rules" group with its reason (Fork, Profile README, Small) and can be ticked like any other.
   - Order: most recent push first, then more stars, then name.
   - A repo that an add-on already links (same owner and name, any case) is shown as Added and can't be picked again.
   - The group's heading counts each reason, so nothing disappears silently.
   - Nothing is remembered between scans: each scan lists every owned repo again.
4. **Pick, then add.** The user ticks repos and clicks Add. Each becomes an `open_source` add-on:
   - Title: the repo name. Link: the repo URL. Skills: the repo's main language, when GitHub names one.
   - Text: the repo description. With none, "`<name>`, a `<language>` repository on GitHub." (or without the language).
   - Each add-on's text is split into facts like any add-on (one light-tier call each), so its facts appear under Facts to review.
   - A private repo is marked private when it is added, so exports strip its URL before it is ever read (decision 55).
   - At most 20 repos per Add, to keep the splits started at once small.
5. **Reading stays on demand.** Adding a repo doesn't read it. The user clicks Read from GitHub on the add-ons they want, with the token cap of decision 55 per read.
6. **The server re-lists before it adds.** Add sends only repo names. The server lists the repos again and adds only names in that list, so a client can't plant a description or link. That is one to three extra requests.
7. **Request budget.** A scan is the account check, then one request per 100 repos, at most 3 (300 repos).

## Slice 19: Find my GitHub repos

- **Files owned**: `src/domain/repo-scan.ts` and its test, `listRepos` in `src/server/adapters/github.ts` (gh reader; the fixture reader gets a recorded list for tests), `scanGithubRepos` and `addGithubRepos` in `src/server/services/github.ts`, two routes in `src/server/http/routes/profile.ts`, DTOs in `src/shared/api.ts`, the dialog in `src/web/routes/profile.tsx`, `test/github.test.ts`, `e2e/github.spec.ts`.
- **Acceptance**:
  - Forks, the profile repo and repos under 5 KB sit in a collapsed group with their reasons, and can still be picked and added.
  - Repos already linked by an add-on show as Added.
  - Without `HB_GITHUB=gh` the Find button is hidden and the route answers 409.
  - A scan on the wrong gh account is refused before any list request; private repos are listed with a lock.
  - Add creates one `open_source` add-on per picked repo, starts its split, and ignores names not in the fresh list.
  - A private repo added from the list is excluded from exports before any read.
- **Verify**: `bun test test/github.test.ts src/domain/repo-scan.test.ts`, `bun run check`.

## Later (not planned)

- **Public API listing**, for Docker or users without gh: `users/<user>/repos?type=owner`, public repos only, 60 requests an hour.

## Local folder scan (decision 79, built)

`HB_PROJECTS_DIR` adds a second section to the dialog, listed first. Findings from the real folder (25 subfolders) that shaped the rules:

- 13 folders are clones of listed repos. They merge into the GitHub row and show "N commits by you locally". Five of those repos are under 5 KB on GitHub but have 10 to 277 local commits, so local history overrides "nearly empty".
- 4 repos have no remote or a remote GitHub no longer has: `hanapbuhay`, `pi-adw`, `adw-graph-tui`, and `portfolio-next`, whose remote returns 404. With a gh listing, an unlisted remote of yours gets no link, so a dead link never reaches a resume.
- `pi-mux-ref` is a clone of someone else's repo (0 of 31 commits yours), so it is hidden as "mostly others".
- `job-hunter`'s one commit is by `local`. Authors without an "@" count as no one, so it is hidden as "few commits", not "others".
- 5 folders are not git repos.
- `portfolio-next`'s README opens with create-next-app's boilerplate. Known generator openers give no summary.

The folder is read with `git log --format=%ae%x09%cI` (at most 5000 commits) and `git config --get remote.origin.url`, both with `-c core.fsmonitor=false` and `GIT_OPTIONAL_LOCKS=0`. A scan of 25 folders and 75 GitHub repos takes about 2 seconds.

## One project into the add-on form (decision 80, built)

- `src/domain/project-source.ts` parses a pasted GitHub link, GitLab link or folder path and turns what was read into form values. Only gitlab.com and `HB_GITLAB_HOSTS` count as GitLab.
- `about` on the GitHub reader returns a repo's or pull request's name, visibility, description, language and README. `src/server/adapters/gitlab.ts` reads public GitLab projects. `createFolderReader` in `local-projects.ts` reads one folder; the folder scan now uses it too.
- `POST /profile/addons/prefill` only reads. The form's save sends `linkPrivate` while the filled-in link is unchanged.
- Tests: `src/domain/project-source.test.ts`, `test/prefill.test.ts` (GitHub fixtures, a fake GitLab, real temporary folders), and an e2e test with an accessibility check in both themes.
