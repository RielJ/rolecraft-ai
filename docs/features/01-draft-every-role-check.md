# Every-role check on resume drafts

- **Status:** frozen
- **Area:** Drafting

## Problem

A resume draft can leave out one of the user's roles, and nothing retries it. The retry step only adds back REQUIRED facts the draft dropped (decision 74).

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built". The retry in `services/workspace.ts` ("Steps 2 to 4") checks REQUIRED facts, not roles.

## Pull into scope when

A real resume during the MVP leaves out a role you needed, and fixing it takes more than the 5-minute edit budget.

## Acceptance

- After the check, a draft missing any role from `roles` is retried once with the missing roles named.
- A role still missing after the retry shows as a blank, never silently.
- A service test with a stubbed AI shows the retry.
