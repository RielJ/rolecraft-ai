# ATS links in Add by link

- **Status:** frozen
- **Area:** Job intake

## Problem

Add by link reads every URL as a web page (`addJobFromLink` in `services/jobs.ts:152` calls `readPage`). A Greenhouse, Lever, Ashby, Workable, Recruitee or SmartRecruiters posting has a board API that gives cleaner text, pay and location, and the app already has adapters for all six (`src/server/adapters/sources/`).

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built".

## Pull into scope when

During the MVP a pasted ATS link gives a job with wrong or missing text, pay or location. The MVP takes jobs through Refresh, so this is unlikely to block.

## Acceptance

- A known ATS posting URL is read through its board adapter; any other URL still reads as a page.
- The job is stored the same way Refresh would store it, so a later Refresh merges instead of duplicating (decision 46).
- Adapter tests with recorded fixtures for each board.
