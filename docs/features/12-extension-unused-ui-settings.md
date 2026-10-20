# The unused `ui` storage key

- **Status:** frozen
- **Area:** Chrome extension

## Problem

`saveUi` in `extension/src/state/storage.ts:92` has no callers, so the `ui` key in `chrome.storage.local` is never written and the Diagnostics tab always shows.

## Evidence

Found while merging the extension docs (2026-10-20). `docs/EXTENSION.md` no longer lists the key.

## Pull into scope when

The extension is back in scope, or Diagnostics needs to be hidden.

## Acceptance

- Either a setting writes it through `saveUi` (with a test), or `saveUi` and `UiSettings` are deleted.
