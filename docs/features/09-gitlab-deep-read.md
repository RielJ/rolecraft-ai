# GitLab deep read

- **Status:** frozen
- **Area:** Projects

## Problem

GitHub repos and local folders get a deep read from commits and their changes, which yields facts and a project role. GitLab links only fill the add-on form (decision 80). Picking which features to read before their changes are read is also not built, for any host.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built"; DECISIONS.md "Later". `src/server/adapters/gitlab.ts` reads only project metadata.

## Pull into scope when

A project you want on a resume lives only on GitLab.

## Acceptance

- A GitLab project gets the same deep read as a GitHub repo, through the same domain code.
- Tests with recorded GitLab fixtures.
