import { z } from "zod";
import { parsePay } from "@/domain/pay";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import { dateOrNull, getBody, type Posting, readJson, type SourceAdapter } from "./types";

/**
 * Remotive (https://github.com/remotive-com/remote-jobs-api). Remotive asks for at most about four
 * requests a day and two a minute, so the source runs at most every six hours and reads one
 * window of the newest postings in a single request. Listings are delayed 24 hours. The terms ask
 * for credit and a link back: jobs keep the Remotive URL and show "via Remotive".
 */

const API = "https://remotive.com/api/remote-jobs";
const NAME = "Remotive";
/** Six hours between runs: four a day at most. */
export const REMOTIVE_MIN_INTERVAL_MINUTES = 360;
const LIMIT = 100;

const Job = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string(),
  title: z.string(),
  company_name: z.string().nullish(),
  category: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  job_type: z.string().nullish(),
  /** ISO without an offset; Remotive means UTC. */
  publication_date: z.string().nullish(),
  candidate_required_location: z.string().nullish(),
  salary: z.string().nullish(),
  description: z.string().nullish(),
});
const Feed = z.object({ jobs: z.array(Job) });

/** "Worldwide" is no restriction; otherwise the listed places. */
export function remotiveRestrictions(location: string | null | undefined): string[] | null {
  const text = decodeEntities(location ?? "").trim();
  if (!text) return null;
  const places = text
    .split(/[,;/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return places.some((p) => /^(?:worldwide|anywhere)$/i.test(p)) ? [] : places;
}

const utc = (value: string | null | undefined) =>
  value ? dateOrNull(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) : null;

export function createRemotiveAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "remotive",
    name: NAME,
    complete: false,
    minIntervalMinutes: REMOTIVE_MIN_INTERVAL_MINUTES,
    async fetch() {
      const body = await getBody({ http, url: `${API}?limit=${LIMIT}`, name: NAME });
      const { jobs } = readJson({ body, schema: Feed, name: NAME });
      const postings: Posting[] = jobs.map((job) => {
        const location = decodeEntities(job.candidate_required_location ?? "").trim();
        return {
          externalId: String(job.id),
          title: decodeEntities(job.title).trim(),
          company: decodeEntities(job.company_name ?? "").trim() || "Unknown company",
          description: htmlToText(job.description ?? ""),
          locationText: location,
          applyUrl: job.url,
          listingUrl: job.url,
          postedAt: utc(job.publication_date),
          expiresAt: null,
          // Free text ("$90,000 - $120,000 a year"); read it like a description would be.
          pay: job.salary ? parsePay(decodeEntities(job.salary)) : null,
          restrictions: remotiveRestrictions(location),
          tags: [job.category ?? "", ...(job.tags ?? [])].filter(Boolean),
        };
      });
      return { complete: false, postings, unread: [] };
    },
  };
}
