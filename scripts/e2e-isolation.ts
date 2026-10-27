/** Never load a developer's personal .env into a fixture server. */
export const E2E_SERVER_ARGS = ["--no-env-file", "scripts/e2e-server.ts"];

export const E2E_ISOLATION_ENV: Record<string, string> = {
  HB_HOST: "127.0.0.1",
  HB_ALLOWED_HOSTS: "",
};

/** Run inside the child, since Playwright merges its env with the parent's. */
export function isolateE2EEnvironment(env: Record<string, string | undefined>): void {
  delete env.HB_GITHUB_USER;
  Object.assign(env, E2E_ISOLATION_ENV);
}
