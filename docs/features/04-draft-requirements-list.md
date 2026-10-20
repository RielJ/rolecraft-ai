# Requirements list in the drafts tab

- **Status:** frozen
- **Area:** Drafting

## Problem

The drafts tab doesn't show which posting requirements the resume covers. The plan had Shown, Not shown and Gap rows, with "redraft with this" to push a missing one into the next draft.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built". Depends on `03-draft-saved-coverage`.

## Pull into scope when

During the MVP you can't tell why a tailored resume missed a requirement, and that costs you more than the 5-minute edit budget.

## Acceptance

- The drafts tab lists each requirement as Shown, Not shown (you have a fact) or Gap (no fact).
- "Redraft with this" redrafts with that requirement marked must-cover.
- An e2e test covers the list and one redraft.
