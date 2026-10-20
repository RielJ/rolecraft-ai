# Deleting saved prefill answers

- **Status:** frozen
- **Area:** Chrome extension

## Problem

Answers saved in the panel for prefill can't be deleted from any screen. A new save for the same question and scope replaces the old one, and deleting the job removes its job-scoped answers, but a wrong global answer stays until it is overwritten.

## Evidence

`DELETE /api/extension/preferences/:id` exists (`src/server/http/routes/extension/preferences.ts`, `deletePreference` in `services/extension-preferences.ts:140`), and `extension/src/api/client.ts:37` defines the call, but no panel screen calls it.

## Pull into scope when

The extension is back in scope and a saved answer turns out wrong.

## Acceptance

- The panel lists saved answers with a Delete action that calls the route.
- An extension test shows the answer no longer prefills after deletion.
