# Security policy

## Supported version

Security fixes target the current default branch. There is no supported hosted service or multi-user deployment.

## Keep Rolecraft local

Rolecraft is a single-user application with no login. Anyone who can reach the API may read your profile, CV, drafts and saved answers, change your data, or spend your configured AI budget.

- Keep the server on its default `127.0.0.1` interface. Compose publishes both the app and Postgres on loopback only.
- Do not expose the API through port forwarding, a public tunnel, a shared reverse proxy, or an unrestricted `docker run -p` binding.
- The image listens on `0.0.0.0` inside its container. Use the provided Compose configuration, or explicitly publish to `127.0.0.1`.
- `HB_ALLOWED_HOSTS` prevents DNS rebinding. It is not authentication and does not make a network deployment safe.
- The extension uses bearer-token pairing. Keep pairing codes and tokens private. Revoke a pairing in Settings if a browser or profile is lost.

Host and origin checks reduce browser-based attacks against localhost. They do not protect against other processes or users on your computer, a malicious browser extension, or someone who can reach an exposed API directly.

## Data and external services

Your database contains personal information. The AI key is stored in the configured `HB_DATA_DIR`, with file permissions `0600`. File permissions do not encrypt the key or database. Protect your machine, backups and Docker volumes.

AI drafting sends relevant profile facts, posting text and other prompt context to your chosen provider. `HB_AI=pi` uses `HB_PI_PROVIDER` and the pi CLI's existing sign-in. It does not mean inference runs offline. Reading project links can send selected repository content to the AI provider as well. Review private project material before using those features.

Job-source, GitHub, GitLab and exchange-rate adapters contact external services. Review their terms and rate limits. Never use the extension to bypass a site's restrictions. It does not submit applications; you must review drafts and form fields before submitting yourself.

Never include a real CV, contact details, application history, API key, `.env`, database dump, browser profile, pairing token, or runtime `data/` file in a commit, issue, screenshot, trace or test fixture. Use synthetic examples instead.

## Known limitations

The add-by-link HTTP adapter checks URL syntax, local hostname patterns and private IP literals on each redirect. It does not resolve DNS results or pin connections to a verified public address. A permitted DNS name can resolve to a private address. Treat pasted job links as untrusted; these checks are not a complete SSRF defense. This is another reason not to run Rolecraft on a cloud server or shared network.

The lockfile retains the moderate esbuild advisory `GHSA-67mh-4wv8-2f99` through Drizzle Kit's `@esbuild-kit/core-utils` development dependency. It concerns esbuild's development server. Rolecraft does not start that server: Vite has a newer esbuild dependency, and Drizzle Kit is used for local migration generation only. `bun run audit:deps` ignores only this advisory, not a whole package or severity level. Plain `bun audit` continues to report it. Revisit the exception when updating Drizzle Kit; never expose its tooling as a network service.

## Report a vulnerability

Do not post credentials, personal data or working exploit details in a public issue. On the repository's **Security** tab, use **Report a vulnerability** if private vulnerability reporting is enabled. Maintainers must enable that option before inviting private reports. If it is unavailable, open an issue requesting a private reporting channel without disclosing the vulnerability.

Include the affected revision, a synthetic reproduction, expected behavior and impact. No response-time or bounty commitment is currently offered.

## Before publishing or upgrading

Follow [the release checklist](docs/PUBLIC_RELEASE.md). Run `bun run audit:public --history` and `bun audit`. The repository scan is a best-effort guard, not a guarantee that credentials or personal information are absent. Review binary fixtures and Git history separately.
