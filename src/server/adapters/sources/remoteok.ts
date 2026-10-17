import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import { dateOrNull, getBody, type Posting, readJson, type SourceAdapter, SourceError, structuredPay } from "./types";

/**
 * RemoteOK (https://remoteok.com/api). One request returns the newest postings as a JSON array
 * whose first element is the legal notice, so the source is incomplete. The terms ask for credit
 * and a link back to the listing: jobs keep `url` as their listing link and show "via RemoteOK".
 * Salaries are annual USD, and 0 means not stated.
 */

const API = "https://remoteok.com/api";
const NAME = "RemoteOK";

const Notice = z.object({ legal: z.string() });
const Job = z.object({
  id: z.union([z.string(), z.number()]),
  position: z.string(),
  company: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  date: z.string().nullish(),
  epoch: z.number().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  apply_url: z.string().nullish(),
  url: z.string(),
});
/** The notice first, then the jobs. */
const Feed = z.tuple([Notice], z.unknown());

export function createRemoteOkAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "remoteok",
    name: NAME,
    complete: false,
    minIntervalMinutes: 30,
    async fetch() {
      const body = await getBody({ http, url: API, name: NAME });
      const [, ...rest] = readJson({ body, schema: Feed, name: NAME });
      const jobs = z.array(Job).safeParse(rest);
      if (!jobs.success)
        throw new SourceError({ kind: "parse", message: `${NAME} answered in a format we do not read.` });
      const postings: Posting[] = jobs.data.map((job) => ({
        externalId: String(job.id),
        title: decodeEntities(job.position).trim(),
        company: decodeEntities(job.company ?? "").trim() || "Unknown company",
        description: htmlToText(job.description ?? ""),
        locationText: decodeEntities(job.location ?? "").trim(),
        applyUrl: job.apply_url?.trim() || job.url,
        listingUrl: job.url,
        postedAt: dateOrNull(job.date) ?? (job.epoch ? new Date(job.epoch * 1000) : null),
        expiresAt: null,
        pay: structuredPay({ min: job.salary_min, max: job.salary_max, currency: "USD", period: "year" }),
        restrictions: null,
        tags: job.tags ?? [],
      }));
      return { complete: false, postings, unread: [] };
    },
  };
}
