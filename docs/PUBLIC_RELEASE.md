# Prepare a public Rolecraft repository

This checklist covers publishing the source repository, not running a public service. Rolecraft has no login and is intended for one person on their own computer. See [SECURITY.md](../SECURITY.md).

## Before making the repository public

- [ ] Review the complete working tree and staged diff. Do not mix an unfinished feature into the release by accident.
- [ ] Run `bun install --frozen-lockfile`, `bun run check`, `bun run build`, and `bunx playwright test` with Postgres running.
- [ ] Run `bun run e2e:extension` separately. It shares and resets the web suite's E2E database.
- [ ] Run `bun run audit:public --history`. The scan rejects tracked private/runtime paths and common credential formats. It scans reachable Git history when requested, not remote pull-request refs or unreachable objects.
- [ ] Run `bun audit` and review all findings. `bun run audit:deps` is the CI gate, with the single documented esbuild exception in [SECURITY.md](../SECURITY.md).
- [ ] Review commit author names and email addresses with `git log --all --format='%an <%ae>'`. Existing history contains the author's personal email. Confirm that you want it published before changing repository visibility. Do not paste that output into an issue or audit report.
- [ ] Review historical files, binary fixtures, screenshots, PDFs and DOCX files manually. Pattern scanning cannot prove that personal information or secrets are absent. Current CV fixtures use synthetic identities, but new fixtures need the same review.
- [ ] Confirm you have permission to distribute every contribution and fixture. The extension's trimmed application-form HTML fixtures are documented as captured public markup for interoperability tests; assess their provenance before distributing them under a broader claim.
- [ ] Keep the MIT [LICENSE](../LICENSE), and preserve the [third-party notices](../public/THIRD_PARTY_NOTICES.txt). The MIT license does not relicense third-party fonts or copied components.
- [ ] Enable GitHub private vulnerability reporting, secret scanning and push protection where available. Review the first CI run on the remote. Local verification does not prove that GitHub Actions ran.
- [ ] Choose and confirm the repository name and visibility in GitHub. Update any remote URL yourself after renaming. A local package rename does not rename the remote repository.

If a real credential appears anywhere in history, rotate it before publication. Removing a file in a new commit does not remove earlier copies. Do not rewrite shared history without an agreed recovery plan. If publishing the existing history would reveal information you want private, stop and plan a separate clean publication with the owner.

## What stays named Hanapbuhay

Rolecraft replaces the product name in the web app, extension, package metadata, docs and outbound request agent. These existing identifiers remain intentionally:

| Identifier | Reason |
|---|---|
| `HB_*` environment variables | Existing `.env` files, scripts and deployments keep working. |
| `hanapbuhay`, `hanapbuhay_test`, `hanapbuhay_e2e`, and worker database names | Renaming does not create an empty replacement database or risk connecting tests to a real profile. |
| `hb_sync` and existing SQL migrations | Grants and migration history must remain valid. |
| Browser storage keys and legacy content-script install marker | Existing pairings and open tabs must not be reset or receive duplicate listeners. |
| Existing checkout folder and Compose project name | Compose derives volume names from its project name. Renaming the folder can select new empty volumes. |

The checkout directory and remote repository have not been renamed automatically. For an existing Compose installation, inspect `docker compose ls` and keep its project name with `docker compose -p <existing-project-name> ...` if you rename the folder. Do not use `down -v` to resolve a naming mismatch; it deletes data.

## Local verification for the rename

These results describe the working tree at the Rolecraft rename, not a published release or a remote CI run:

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed without dependency changes. |
| `bun run check` | Lint and app/extension types passed; 1,858 app tests, 2 budget tests and 370 extension tests passed. |
| `bunx playwright test` after `bun run build` | 61 web browser tests passed. |
| `bun run e2e:extension` | 9 extension browser tests passed. |
| `bun run audit:public --history` | No pattern findings in current files or 1,339 reachable historical blobs. |
| `bun run audit:deps` | Passed with the one documented moderate esbuild exception. Unfiltered `bun audit` still reports that advisory. |
| `docker compose build app` | Passed. Runtime runs as UID 1000, includes notices, and does not contain the checkout's `.env` or `.pi`. |

The patched test-only `happy-dom` dependency is 21.0.4. Browser test servers now use a dedicated launcher that ignores personal dotenv files and clears the inherited GitHub account before loading app configuration. A regression test covers that isolation.

## Audit boundaries

The automated scan is best effort. It does not inspect ignored runtime data, decode every binary format, detect all encoded secrets, scan container operating-system packages, or establish trademark availability. It is not a penetration test or legal opinion. The Rolecraft name has not received a trademark clearance check.

The current dependency exception and outbound DNS limitation are documented in [SECURITY.md](../SECURITY.md). Do not describe this release as safe for public hosting, globally configured eligibility, or a guarantee that AI output is accurate.
