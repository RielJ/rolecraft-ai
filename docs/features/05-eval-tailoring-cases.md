# Tailoring cases in the eval set

- **Status:** frozen
- **Area:** Drafting quality

## Problem

`eval/drafting/` has two cases (`missing-stack.json`, `numbers-and-names.json`) and none for tailoring the base CV to a backend, frontend or contract posting. A prompt change can make tailoring worse without any check failing.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built".

## Pull into scope when

A change to the drafting prompt or the drafting guide is planned, or a real MVP resume came out badly tailored.

## Acceptance

- Three cases (backend, frontend, contract) built from real postings, each with the facts that must appear and the claims that must not.
- `bun run eval` runs them.
