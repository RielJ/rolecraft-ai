# Requirement coverage on Matches

- **Status:** frozen
- **Area:** Matching

## Problem

Matches shows a rule-based skill percentage (decision 76), not "6 of 9 requirements" from an AI map per job.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built". Needs `03-draft-saved-coverage` or a separate per-job AI map, which costs one AI call per job.

## Pull into scope when

The skill percentage proves misleading on real matches during the MVP.

## Acceptance

- Decide first: an AI map per job (cost per Refresh) or coverage only for saved jobs.
- Matches shows the coverage where it exists and the skill percentage elsewhere.
