import { z } from "zod";

const DEFAULT_DB = "postgres://hanapbuhay:hanapbuhay@localhost:5432/hanapbuhay";

const EnvSchema = z.object({
  DATABASE_URL: z.url().default(DEFAULT_DB),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Chromium binary for PDF export. Unset uses Playwright's downloaded browser. */
  HB_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Directory of the built SPA. */
  HB_STATIC_DIR: z.string().min(1).default("./dist"),
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
