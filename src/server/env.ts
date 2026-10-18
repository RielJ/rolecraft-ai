import { z } from "zod";
import { PI_THINKING_LEVELS } from "./adapters/ai/pi";

const DEFAULT_DB = "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay";

/** A bare hostname or bracketed IPv6 address: no scheme, port, path, or wildcard. */
const HOSTNAME = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/;

const EnvSchema = z
  .object({
    DATABASE_URL: z.url().default(DEFAULT_DB),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The interface to listen on. Loopback by default, so nothing else on the network can reach
     * the app. The container image sets 0.0.0.0; Compose publishes the port on 127.0.0.1 only.
     */
    HB_HOST: z.string().min(1).default("127.0.0.1"),
    /**
     * Extra hostnames (comma-separated, no port) the app answers to besides localhost, 127.0.0.1
     * and [::1]. Any other Host header gets 403, which blocks DNS rebinding.
     */
    HB_ALLOWED_HOSTS: z
      .string()
      .transform((list) =>
        list
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== ""),
      )
      .pipe(z.array(z.string().regex(HOSTNAME, "a hostname without scheme or port")))
      .default([]),
    /** Chromium binary for PDF export. Unset uses Playwright's downloaded browser. */
    HB_CHROMIUM_PATH: z.string().min(1).optional(),
    /** Directory of the built SPA. */
    HB_STATIC_DIR: z.string().min(1).default("./dist"),
    /** App data directory. The AI key file lives here (open question 3). Compose mounts the appdata volume. */
    HB_DATA_DIR: z.string().min(1).default("./data"),
    /**
     * `live` uses the API key saved in Settings. `pi` runs AI through the local pi CLI and its own
     * sign-in (decision 48). `fake` swaps in the scriptable provider for tests and Playwright.
     */
    HB_AI: z.enum(["live", "pi", "fake"]).default("live"),
    /** The pi binary for `HB_AI=pi`. */
    HB_PI_BIN: z.string().min(1).default("pi"),
    /** Anthropic models pi runs for each tier. */
    HB_PI_MODEL_LIGHT: z.string().min(1).default("claude-haiku-5-5"),
    HB_PI_MODEL_WRITING: z.string().min(1).default("claude-opus-5-5"),
    /** Thinking level per tier; thinking tokens bill as output, so light calls skip it. */
    HB_PI_THINKING_LIGHT: z.enum(PI_THINKING_LEVELS).default("off"),
    HB_PI_THINKING_WRITING: z.enum(PI_THINKING_LEVELS).default("low"),
    /** `fixture` runs the real source adapters over files in HB_SOURCES_DIR instead of the network. */
    HB_SOURCES: z.enum(["live", "fixture"]).default("live"),
    HB_SOURCES_DIR: z.string().min(1).default("./test/fixtures/sources"),
    /** With `HB_SOURCES=fixture`, a file that gets one line per fixture request (for e2e). */
    HB_SOURCES_LOG: z.string().min(1).optional(),
    /**
     * How GitHub links on add-ons are read (decision 55). `public` (default) uses unauthenticated
     * REST. `gh` goes through the local gh CLI and refuses unless gh's active account is
     * HB_GITHUB_USER. `fixture` reads recorded snapshots from HB_GITHUB_DIR (tests and Playwright).
     */
    HB_GITHUB: z.enum(["public", "gh", "fixture"]).default("public"),
    /** Your GitHub account: whose commits count as yours, and the only account gh may be signed in as. */
    HB_GITHUB_USER: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "a GitHub user name")
      .optional(),
    HB_GH_BIN: z.string().min(1).default("gh"),
    HB_GITHUB_DIR: z.string().min(1).default("./test/fixtures/github"),
  })
  .refine((env) => env.HB_GITHUB !== "gh" || env.HB_GITHUB_USER !== undefined, {
    path: ["HB_GITHUB_USER"],
    message: "HB_GITHUB=gh needs HB_GITHUB_USER, the only account gh may be signed in as.",
  });
export type Env = z.infer<typeof EnvSchema>;

/** Parse process.env at boot; the process refuses to start on bad config. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Bad environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
