import { isolateE2EEnvironment } from "./e2e-isolation";

// Do this before importing env.ts or creating services. No personal account is pinned in fixtures.
isolateE2EEnvironment(process.env);
await import("../src/server/main");
