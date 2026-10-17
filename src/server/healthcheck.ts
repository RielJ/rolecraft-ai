// Container healthcheck: exit 0 only when GET /api/health answers 200, which needs Postgres up.
// The image has no curl, so Compose runs this with Bun.
const port = process.env.PORT ?? "3000";
const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
process.exit(res?.ok ? 0 : 1);
