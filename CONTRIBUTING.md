# Contributing to Rolecraft

Rolecraft is a local, single-user job-search workspace. Its current eligibility rules focus on people applying from the Philippines. Contributions must keep confirmed facts, application records and private information intact.

## Set up development

Follow [the README](README.md#run-it-for-development). Use Bun 1.4.3 and Docker Compose. Install the locked dependencies with `bun install --frozen-lockfile`, copy `.env.example` to `.env`, and start Postgres with `bun run db:up`.

Keep personal data outside the repository. If you use local agent tools, add their private directories, including `.pi/`, to your global Git ignore file or `.git/info/exclude`. The public audit rejects these directories if they become tracked.

## Make a change

1. Read [the architecture](docs/ARCHITECTURE.md) and the relevant [decisions](docs/DECISIONS.md).
2. Keep the change focused. Add a failing regression test for a bug when a local test can reproduce it.
3. Run `bun run check`, `bun run build` and `bunx playwright test`. Browser tests need `bunx playwright install --with-deps chromium` on Linux, or `bunx playwright install chromium` on macOS.
4. For extension changes, also run `bun run e2e:extension`. Do not run the web and extension browser suites at the same time: both reset the E2E database.
5. Run `bun run audit:public` before opening a pull request. Review every file in `git diff --cached`, including new files.

Tests create and reset the databases configured by `DATABASE_URL_TEST` and `DATABASE_URL_E2E`. Never point either variable at your everyday application database. The live eval command makes paid AI calls; normal CI and browser tests use fixtures and fake AI instead.

Describe what changed, why, tests run and any migration or compatibility impact in your pull request. Do not attach a real resume, application form, contact details, pairing token, `.env`, browser profile or database dump. Screenshots and Playwright traces can contain personal information too.

## Compatibility and safety

- `HB_*` settings and the default `hanapbuhay` database names remain for existing installations. A branding change must not silently move a user's data or revoke a pairing.
- Do not edit an existing database migration. Add a new migration and keep its Drizzle metadata in sync.
- Refresh must not change profile facts, board records, notes or drafted files. Keep the database-enforced sync grants and their tests intact.
- AI output is untrusted. Keep citation checks, placeholder gates and private-link filtering in the server. Never make generated answers submit an application automatically.
- Do not add network access or model calls to tests without an explicit opt-in.

## Security and licensing

Follow [SECURITY.md](SECURITY.md) for private vulnerability reports. Rolecraft is licensed under [MIT](LICENSE). Only contribute material you have permission to distribute. Preserve dependency and asset license notices.
