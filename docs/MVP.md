# MVP: apply with Hanapbuhay

Agreed on 2026-10-21. This file sets what the MVP is, how work stays on course, and the log of real applications. Read it before starting any change.

## Goal

Use the app for real job applications: find jobs, draft tailored files, apply by hand. The app must be stable and give a resume tailored to each posting.

## The loop

| Step | Where | Must work |
|---|---|---|
| 1. Refresh | Matches, **Refresh** | The built-in boards and your company boards sync without errors. |
| 2. Pick | Matches | Good jobs rank as Strong or Good, and you can save one. |
| 3. Draft | The job's page, **Draft** | A tailored resume, a cover letter and answers to the form's questions, cited to your facts. |
| 4. Review | The job's page | You fix blanks and edit text, then mark each file reviewed. |
| 5. Export | **Download PDF**, **Copy text** | The PDF and text are clean, with no fact markers. |
| 6. Apply | The employer's site | You submit by hand. The extension is not part of the MVP. |
| 7. Track | Board | You mark the job Applied and its files freeze. |

## Done when

Three real applications went out through the loop, each resume needed **5 minutes of edits or less**, and **no bug blocked** any of them. Each application gets a row in the log below.

## Out of scope

- The Chrome extension.
- Everything in `docs/features/`. Each item stays frozen until a real application needs it (see "Triage").
- Backups. The data can be rebuilt from the CV.

## Daily app

Apply with the app started by `bun run app`, on **http://localhost:3300**. It uses the real database and pi, and builds into its own `dist-app/` folder. The dev server (port 3200), the tests and `bun run e2e` don't change what it serves.

- It starts only from a committed tree, and refuses when files have changes.
- Restart it (Ctrl-C, then `bun run app`) only after a commit that passed `bun run check`.
- Migrations run when it starts.

Before the first application, add your projects with **Find my projects** in Profile (your GitHub and `~/personal/projects`). This is recommended, not required. Without project add-ons, tailoring can't add a project the CV lacks.

## Rules

**Drift check.** Every commit names what it serves, in its message: an MVP step above, a log row, or a feature doc in `docs/features/`. A change that serves none of these is drift. Raise it and ask before doing it.

**Triage.** When a problem shows up during a real application:

- **It blocks or corrupts an application:** fix it now, with a failing test first, and note the fix commit in the log.
- **Anything else:** add or update a feature doc in `docs/features/` with status `frozen`, then keep applying.

A feature doc moves from `frozen` to `next` only when a log row shows it cost an application time or quality. Its status changes to `in progress` and then `done` as the work lands.

## Features

Ranked by how much each helps the MVP goal: a tailored resume that needs 5 minutes of edits or less, from jobs found by Refresh. The two-digit prefix of each filename is its rank, and rank 01 is pulled in first when a log row shows a need. Re-rank after each application by renaming the files with `git mv` and updating this table. A new feature doc takes the number of its rank, and the docs after it move down one.

| Doc | Area | Status | Why this rank |
|---|---|---|---|
| [01-draft-every-role-check](features/01-draft-every-role-check.md) | Drafting | frozen | A resume that leaves out a role fails the tailoring bar outright. |
| [02-skills-skip-boilerplate-sections](features/02-skills-skip-boilerplate-sections.md) | Matching | frozen | Refresh is the MVP's intake. Skills read from About us and Benefits skew which jobs rank high. |
| [03-draft-saved-coverage](features/03-draft-saved-coverage.md) | Drafting | frozen | Stores what a draft covers. 04 and 07 depend on it. |
| [04-draft-requirements-list](features/04-draft-requirements-list.md) | Drafting | frozen | Shows why a resume missed a requirement, which saves edit minutes. |
| [05-eval-tailoring-cases](features/05-eval-tailoring-cases.md) | Drafting quality | frozen | Catches a prompt change that makes tailoring worse. |
| [06-github-readme-flag](features/06-github-readme-flag.md) | Projects | frozen | Keeps a weak repo off a resume. Matters once projects are added. |
| [07-matches-requirement-coverage](features/07-matches-requirement-coverage.md) | Matching | frozen | Better ranking than the skill percentage, but it costs AI calls per job. |
| [08-ats-links-add-by-link](features/08-ats-links-add-by-link.md) | Job intake | frozen | The MVP takes jobs through Refresh, so pasted links are rare. |
| [09-gitlab-deep-read](features/09-gitlab-deep-read.md) | Projects | frozen | Matters only for a project that lives only on GitLab. |
| [10-extension-ipv6-pairing](features/10-extension-ipv6-pairing.md) | Chrome extension | frozen | The extension is out of the MVP. This one is a real failure, so it leads the three. |
| [11-extension-delete-saved-answers](features/11-extension-delete-saved-answers.md) | Chrome extension | frozen | Out of the MVP. A wrong saved answer can be overwritten for now. |
| [12-extension-unused-ui-settings](features/12-extension-unused-ui-settings.md) | Chrome extension | frozen | Out of the MVP. Dead code, no user effect. |
| [13-deferred](features/13-deferred.md) | Five 13-deferred ideas | frozen | No MVP step needs any of them. |

## Log

One row per real application. "Edits" is the minutes spent editing the resume before sending it.

| # | Date | Job | Edits | What was wrong | Bugs and fixes |
|---|---|---|---|---|---|
