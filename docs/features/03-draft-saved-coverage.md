# Saving requirement coverage with the output

- **Status:** frozen
- **Area:** Drafting

## Problem

The requirement map is built during drafting, but which requirements the draft covers is not stored with the output. Nothing later can show coverage without asking the AI again.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built". This blocks `04-draft-requirements-list` and `07-matches-requirement-coverage`.

## Pull into scope when

Either of those two items is pulled into scope.

## Acceptance

- Each drafted output stores its covered and uncovered requirements (a nullable column or table, with a migration).
- A redraft replaces it; an edit marks it stale.
- A service test checks the stored coverage for a stubbed draft.
