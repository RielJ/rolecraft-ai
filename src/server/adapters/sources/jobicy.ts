import { z } from "zod";
import { payPhrase } from "@/domain/pay";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import { dateOrNull, type Posting, readJson, type SourceAdapter, SourceError, sourceErrorFrom } from "./types";

/**
 * Jobicy remote jobs (https://jobicy.com/jobs-rss-feed). The feed returns a window of the most
 * recent postings, so the source is incomplete: absence from a run does not mean closed. The
 * feed's tag search matches one tag, so the adapter fetches the window once and sync filters on
 * the user's keywords locally (`matchesKeywords`). Jobicy asks for at most one request an hour.
 */

const API = "https://jobicy.com/api/v2/remote-jobs";
const NAME = "Jobicy";
const COUNT = 100;

const numberish = z.union([z.number(), z.string()]).nullish();

const Job = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string(),
  jobTitle: z.string(),
  companyName: z.string().nullish(),
  jobIndustry: z.array(z.string()).nullish(),
  jobGeo: z.string().nullish(),
  jobDescription: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  pubDate: z.string().nullish(),
  annualSalaryMin: numberish,
  annualSalaryMax: numberish,
  salaryCurrency: z.string().nullish(),
});
const Feed = z.object({ jobs: z.array(Job).nullish() });

/** "Anywhere" means no restriction; otherwise the listed regions. */
export function jobicyRestrictions(geo: string | null | undefined): string[] | null {
  if (!geo) return null;
  const regions = geo
    .split(",")
    .map((r) => decodeEntities(r).trim())
    .filter(Boolean);
  return regions.some((r) => /^anywhere$/i.test(r)) ? [] : regions;
}

function amount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function createJobicyAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "jobicy",
    name: NAME,
    complete: false,
    minIntervalMinutes: 60,
    async fetch() {
      let body: string;
      try {
        body = (await http.getText(`${API}?count=${COUNT}`, { accept: "application/json" })).body;
      } catch (error) {
        throw sourceErrorFrom(error, NAME);
      }
      const feed = readJson({ body, schema: Feed, name: NAME });
      if (!feed.jobs) throw new SourceError({ kind: "parse", message: "Jobicy answered without a job list." });
      const postings: Posting[] = feed.jobs.map((job) => {
        const min = amount(job.annualSalaryMin);
        const max = amount(job.annualSalaryMax);
        const currency = job.salaryCurrency?.trim().toUpperCase();
        const pay =
          min !== null && currency
            ? { min, max, currency, period: "year" as const, phrase: payPhrase({ min, max, currency, period: "year" }) }
            : null;
        return {
          externalId: String(job.id),
          title: decodeEntities(job.jobTitle).trim(),
          company: decodeEntities(job.companyName ?? "").trim() || "Unknown company",
          description: htmlToText(job.jobDescription || job.jobExcerpt || ""),
          locationText: decodeEntities(job.jobGeo ?? "").trim(),
          applyUrl: job.url,
          listingUrl: job.url,
          postedAt: dateOrNull(job.pubDate ? `${job.pubDate.replace(" ", "T")}Z` : null),
          expiresAt: null,
          pay,
          restrictions: jobicyRestrictions(job.jobGeo),
          tags: (job.jobIndustry ?? []).map((t) => decodeEntities(t)),
        };
      });
      return { complete: false, postings };
    },
  };
}
