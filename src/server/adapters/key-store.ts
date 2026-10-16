import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UserId } from "@/shared/api";

/**
 * The AI key lives in a 0600 file in the app data directory, never in Postgres (open question 3).
 * A database dump can never leak it.
 */
export type KeyStore = {
  read(userId: UserId): Promise<string | null>;
  write(userId: UserId, key: string): Promise<void>;
  remove(userId: UserId): Promise<void>;
  pathFor(userId: UserId): string;
};

export function createFileKeyStore({ dir }: { dir: string }): KeyStore {
  const pathFor = (userId: UserId) => join(dir, `ai-key-${userId}`);
  return {
    pathFor,
    async read(userId) {
      const file = Bun.file(pathFor(userId));
      if (!(await file.exists())) return null;
      const key = (await file.text()).trim();
      return key === "" ? null : key;
    },
    async write(userId, key) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = pathFor(userId);
      // Write to a temp file created 0600, then rename, so a reader never sees a partial key
      // and the key is never world-readable, even for a moment.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, key, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
    async remove(userId) {
      await rm(pathFor(userId), { force: true });
    },
  };
}
