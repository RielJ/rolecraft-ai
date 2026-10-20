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
3. **Rules, no AI.** Detection makes no AI call and costs nothing.
   - Hidden on GitHub: forks, the profile README repo (`<user>/<user>`), and repos under 5 KB. Archived repos stay.
   - Order: most recent push first, then more stars, then name.
   - A repo that an add-on already links (same owner and name, any case) is shown as Added and can't be picked again.
   - The list shows how many repos each rule hid, so nothing disappears silently.
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
  - The list hides forks, the profile repo and repos under 5 KB, and says how many of each it hid.
  - Repos already linked by an add-on show as Added.
  - Without `HB_GITHUB=gh` the Find button is hidden and the route answers 409.
  - A scan on the wrong gh account is refused before any list request; private repos are listed with a lock.
  - Add creates one `open_source` add-on per picked repo, starts its split, and ignores names not in the fresh list.
  - A private repo added from the list is excluded from exports before any read.
- **Verify**: `bun test test/github.test.ts src/domain/repo-scan.test.ts`, `bun run check`.

## Later (not planned)

- **Public API listing**, for Docker or users without gh: `users/<user>/repos?type=owner`, public repos only, 60 requests an hour.
- **Local folder scan** (`HB_PROJECTS_DIR`), to find repos with no remote (6 today, including `hanapbuhay` and `pi-adw`): own repos by commit authors (`git log --format=%ae` against `git config user.email`), at least 5 commits and half the commits yours; a repo with a github.com remote merges with the gh list by owner and name; a repo with none becomes a link-less add-on with the first README paragraph as text. Only works when the server runs on the user's machine.
