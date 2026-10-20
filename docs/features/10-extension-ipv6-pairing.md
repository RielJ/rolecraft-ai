# Pairing the extension with http://[::1]

- **Status:** frozen
- **Area:** Chrome extension

## Problem

The pairing screen accepts `http://[::1]:<port>` as the app address, but `extension/manifest.json` has no optional host permission for it. Chrome refuses the permission request, so pairing fails with no clear message.

## Evidence

Found while merging the extension docs (2026-10-20). `LOOPBACK_HOSTS` in `src/shared/extension.ts:52` and the regex at line 828 allow `[::1]`. `extension/manifest.json` does not list it.

## Pull into scope when

The extension is back in scope (it is out of the MVP), or someone runs the app on IPv6 loopback.

## Acceptance

- Either the manifest grants `http://[::1]/*`, or `ExtensionEndpoint` rejects `[::1]` with a message naming localhost and 127.0.0.1.
- A test covers the chosen path (`extension/test/manifest.test.ts` or the endpoint schema test).
