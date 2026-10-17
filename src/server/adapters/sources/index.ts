import type { SourceKind } from "@/shared/enums";
import type { HttpClient } from "../http";
import { createAshbyAdapter } from "./ashby";
import { createGreenhouseAdapter } from "./greenhouse";
import { createHimalayasAdapter } from "./himalayas";
import { createJobicyAdapter } from "./jobicy";
import { createLeverAdapter } from "./lever";
import { createRecruiteeAdapter } from "./recruitee";
import { createRemoteOkAdapter } from "./remoteok";
import { createRemotiveAdapter } from "./remotive";
import { createSmartRecruitersAdapter } from "./smartrecruiters";
import type { SourceAdapter, SourceAdapters } from "./types";
import { createWeWorkRemotelyAdapter } from "./weworkremotely";
import { createWorkableAdapter } from "./workable";

export type { FetchInput, FetchResult, Posting, SourceAdapter, SourceAdapters, SourceErrorKind } from "./types";
export { SourceError } from "./types";

/** Every source adapter, all sharing the polite fetch queue. Each kind has one. */
export function createSourceAdapters(http: HttpClient): Required<SourceAdapters> {
  return {
    jobicy: createJobicyAdapter(http),
    himalayas: createHimalayasAdapter(http),
    remoteok: createRemoteOkAdapter(http),
    weworkremotely: createWeWorkRemotelyAdapter(http),
    remotive: createRemotiveAdapter(http),
    greenhouse: createGreenhouseAdapter(http),
    lever: createLeverAdapter(http),
    ashby: createAshbyAdapter(http),
    smartrecruiters: createSmartRecruitersAdapter(http),
    recruitee: createRecruiteeAdapter(http),
    workable: createWorkableAdapter(http),
  };
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
