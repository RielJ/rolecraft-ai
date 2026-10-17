import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import { getBody, type Posting, readJson, type SourceAdapter, structuredPay } from "./types";

/**
 * Himalayas remote jobs (https://himalayas.app/api). The browse API pages through the newest
 * postings, 20 at a time, so the source is incomplete: the adapter reads a window of the first
 * pages and sync filters it on the user's keywords. Pay is annual. An empty
 * `locationRestrictions` means the job is open worldwide.
 */

const API = "https://himalayas.app/jobs/api";
const NAME = "Himalayas";
const PAGE = 20;
/** Five pages: the newest 100 postings, five polite requests a run. */
const MAX_PAGES = 5;

const Restriction = z.union([z.string(), z.object({ name: z.string() })]);

const Job = z.object({
  title: z.string(),
  companyName: z.string().nullish(),
  description: z.string().nullish(),
  excerpt: z.string().nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  currency: z.string().nullish(),
  locationRestrictions: z.array(Restriction).nullish(),
  categories: z.array(z.string()).nullish(),
  parentCategories: z.array(z.string()).nullish(),
  /** Unix seconds. */
  pubDate: z.number().nullish(),
  expiryDate: z.number().nullish(),
  applicationLink: z.string().nullish(),
  /** The posting's page on Himalayas; stable, so it is the external id. */
  guid: z.string(),
});
const Page = z.object({ jobs: z.array(Job), total_count: z.number().nullish() });

const fromUnix = (seconds: number | null | undefined): Date | null =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null;

function restrictionsOf(list: z.infer<typeof Restriction>[] | null | undefined): string[] | null {
  if (!list) return null;
  return list.map((r) => (typeof r === "string" ? r : r.name).trim()).filter(Boolean);
}

export function createHimalayasAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "himalayas",
    name: NAME,
    complete: false,
    minIntervalMinutes: 30,
    async fetch() {
      const jobs: z.infer<typeof Job>[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await getBody({ http, url: `${API}?limit=${PAGE}&offset=${page * PAGE}`, name: NAME });
        const { jobs: batch, total_count: total } = readJson({ body, schema: Page, name: NAME });
        jobs.push(...batch);
        if (batch.length < PAGE || (typeof total === "number" && jobs.length >= total)) break;
      }
      const postings: Posting[] = jobs.map((job) => ({
        externalId: job.guid,
        title: decodeEntities(job.title).trim(),
        company: decodeEntities(job.companyName ?? "").trim() || "Unknown company",
        description: htmlToText(job.description || job.excerpt || ""),
        locationText: restrictionsOf(job.locationRestrictions)?.join(", ") || "Worldwide",
        applyUrl: job.applicationLink?.trim() || job.guid,
        listingUrl: job.guid,
        postedAt: fromUnix(job.pubDate),
        expiresAt: fromUnix(job.expiryDate),
        pay: structuredPay({ min: job.minSalary, max: job.maxSalary, currency: job.currency, period: "year" }),
        restrictions: restrictionsOf(job.locationRestrictions),
        tags: [...(job.categories ?? []), ...(job.parentCategories ?? [])],
      }));
      return { complete: false, postings, unread: [] };
    },
  };
}
