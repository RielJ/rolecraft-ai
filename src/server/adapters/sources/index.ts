import type { SourceKind } from "@/shared/enums";
import type { HttpClient } from "../http";
import { createGreenhouseAdapter } from "./greenhouse";
import { createJobicyAdapter } from "./jobicy";
import type { SourceAdapter, SourceAdapters } from "./types";

export type { FetchResult, Posting, SourceAdapter, SourceAdapters, SourceErrorKind } from "./types";
export { SourceError } from "./types";

/** Every source adapter that exists so far, all sharing the polite fetch queue. */
export function createSourceAdapters(http: HttpClient): SourceAdapters {
  return { greenhouse: createGreenhouseAdapter(http), jobicy: createJobicyAdapter(http) };
}

/** The company-board adapter whose careers links match `url`, with the board slug it names. */
export function boardFromUrl({
  adapters,
  url,
}: {
  adapters: SourceAdapters;
  url: string;
}): { adapter: SourceAdapter & { board: NonNullable<SourceAdapter["board"]> }; board: string } | null {
  for (const adapter of Object.values(adapters)) {
    const reader = adapter.board;
    if (!reader) continue;
    const board = reader.fromUrl(url);
    if (board !== null) return { adapter: { ...adapter, board: reader }, board };
  }
  return null;
}

export function adapterFor({ adapters, kind }: { adapters: SourceAdapters; kind: SourceKind }): SourceAdapter | null {
  return adapters[kind] ?? null;
}
