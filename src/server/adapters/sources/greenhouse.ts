import { z } from "zod";
import { htmlToText } from "@/domain/text";
import { type HttpClient, HttpError } from "../http";
import { dateOrNull, type Posting, readJson, type SourceAdapter, SourceError, sourceErrorFrom } from "./types";

/**
 * Greenhouse job boards (https://developers.greenhouse.io/job-board.html). The public board API
 * returns the whole board, so the source is complete: a posting missing from a good run closed.
 */

const API = "https://boards-api.greenhouse.io/v1/boards";
const NAME = "Greenhouse";
const BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const BOARD_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.eu.greenhouse.io",
]);

const Board = z.object({ name: z.string() });

const Job = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  company_name: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  /** Entity-escaped HTML when `?content=true`. */
  content: z.string().nullish(),
  departments: z.array(z.object({ name: z.string() })).nullish(),
});
const JobsPage = z.object({ jobs: z.array(Job) });

/** The board slug in a Greenhouse careers link, or null. */
export function greenhouseBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let slug: string | null = null;
  if (host === "boards-api.greenhouse.io" && parts[0] === "v1" && parts[1] === "boards") slug = parts[2] ?? null;
  else if (BOARD_HOSTS.has(host)) {
    // Embedded boards: /embed/job_board?for=acme
    slug = parts[0] === "embed" ? url.searchParams.get("for") : (parts[0] ?? null);
  }
  return slug && BOARD_SLUG.test(slug) ? slug.toLowerCase() : null;
}

export function createGreenhouseAdapter(http: HttpClient): SourceAdapter {
  async function getText(url: string): Promise<string> {
    try {
      return (await http.getText(url, { accept: "application/json" })).body;
    } catch (error) {
      throw sourceErrorFrom(error, NAME);
    }
  }

  return {
    kind: "greenhouse",
    name: NAME,
    complete: true,
    minIntervalMinutes: 15,
    board: {
      fromUrl: greenhouseBoardFromUrl,
      async check(board) {
        let body: string;
        try {
          body = (await http.getText(`${API}/${board}`, { accept: "application/json" })).body;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            throw new SourceError({
              kind: "failed",
              message: `Greenhouse said the board "${board}" does not exist. Check the link, or open the company's careers page and copy the link of its job list.`,
            });
          }
          throw sourceErrorFrom(error, NAME);
        }
        const { name } = readJson({ body, schema: Board, name: NAME });
        return { label: name.trim() || board };
      },
    },
    async fetch({ board }) {
      if (board === null) throw new SourceError({ kind: "failed", message: "This Greenhouse source has no board." });
      const body = await getText(`${API}/${board}/jobs?content=true`);
      const { jobs } = readJson({ body, schema: JobsPage, name: NAME });
      const postings: Posting[] = jobs.map((job) => ({
        externalId: String(job.id),
        title: job.title.trim(),
        company: job.company_name?.trim() || board,
        description: htmlToText(job.content ?? ""),
        locationText: job.location?.name?.trim() ?? "",
        applyUrl: job.absolute_url,
        listingUrl: job.absolute_url,
        postedAt: dateOrNull(job.first_published) ?? dateOrNull(job.updated_at),
        expiresAt: null,
        pay: null,
        restrictions: null,
        tags: (job.departments ?? []).map((d) => d.name),
      }));
      return { complete: true, postings };
    },
  };
}
