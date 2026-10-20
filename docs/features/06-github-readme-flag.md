# Flag repos with no README

- **Status:** frozen
- **Area:** Projects

## Problem

Find my projects marks archived and stale repos, but not a repo with no README. The research says a linked repo with no README hurts more than it helps (`docs/research/projects.md`, item 5).

## Evidence

Checking needs one call per repo, which the public 60-calls-an-hour budget can't spare in the scan (decision 86).

## Pull into scope when

You link a repo from a resume and want the warning, or the repo read is changed anyway.

## Acceptance

- The deep read (or the add step) checks for a README and shows "No README" on the add-on.
- A test with a fixture repo without a README.
