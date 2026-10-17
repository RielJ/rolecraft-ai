import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import {
  BOARD_SLUG,
  checkBoard,
  dateOrNull,
  getBody,
  type Posting,
  readJson,
  type SourceAdapter,
  SourceError,
} from "./types";

/**
 * Workable career pages, through the public widget API
 * (`apply.workable.com/api/v1/widget/accounts/<account>?details=true`). One request returns the
 * account's name and every published job with its description, so the source is complete.
 * `telecommuting` marks remote jobs. The API states no pay.
 */

const API = "https://apply.workable.com/api/v1/widget/accounts";
const NAME = "Workable";

const Place = z.object({
  country: z.string().nullish(),
  city: z.string().nullish(),
  region: z.string().nullish(),
  hidden: z.boolean().nullish(),
});

const Job = z.object({
  title: z.string(),
  shortcode: z.string(),
  employment_type: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  department: z.string().nullish(),
  url: z.string(),
  application_url: z.string().nullish(),
  /** "2026-10-14". */
  published_on: z.string().nullish(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  function: z.string().nullish(),
  locations: z.array(Place).nullish(),
  description: z.string().nullish(),
});
const Account = z.object({ name: z.string(), jobs: z.array(Job) });

const apiOf = (board: string) => `${API}/${board}?details=true`;

/** The account in a Workable link (apply.workable.com/acme, acme.workable.com), or null. */
export function workableBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let slug: string | null = null;
  if (host === "apply.workable.com") slug = parts[0] && parts[0] !== "j" && parts[0] !== "api" ? parts[0] : null;
  else {
    const m = /^([a-z0-9][a-z0-9-]*)\.workable\.com$/.exec(host);
    slug = m?.[1] && !["www", "apply", "jobs"].includes(m[1]) ? m[1] : null;
  }
  return slug && BOARD_SLUG.test(slug) ? slug.toLowerCase() : null;
}

function locationOf(job: z.infer<typeof Job>): string {
  const places = (job.locations ?? [])
    .filter((p) => !p.hidden)
    .map((p) => [p.city, p.region, p.country].filter(Boolean).join(", "));
  const fallback = [job.city, job.state, job.country].filter(Boolean).join(", ");
  const text = decodeEntities([...new Set(places)].join("; ") || fallback).trim();
  if (!job.telecommuting) return text;
  return text ? `${text} (Remote)` : "Remote";
}

export function createWorkableAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "workable",
    name: NAME,
    complete: true,
    minIntervalMinutes: 30,
    board: {
      fromUrl: workableBoardFromUrl,
      async check(board) {
        const body = await checkBoard({ http, url: `${API}/${board}`, name: NAME, board });
        const { name } = readJson({ body, schema: Account, name: NAME });
        return { label: name.trim() || board };
      },
    },
    async fetch({ board }) {
      if (board === null) throw new SourceError({ kind: "failed", message: "This Workable source has no board." });
      const body = await getBody({ http, url: apiOf(board), name: NAME });
      const { name, jobs } = readJson({ body, schema: Account, name: NAME });
      const company = decodeEntities(name).trim() || board;
      const postings: Posting[] = jobs.map((job) => ({
        externalId: job.shortcode,
        title: decodeEntities(job.title).trim(),
        company,
        description: htmlToText(job.description ?? ""),
        locationText: locationOf(job),
        applyUrl: job.url,
        listingUrl: job.url,
        postedAt: dateOrNull(job.published_on),
        expiresAt: null,
        pay: null,
        restrictions: null,
        tags: [job.department, job.function, job.employment_type].map((t) => (t ?? "").trim()).filter(Boolean),
      }));
      return { complete: true, postings, unread: [] };
    },
  };
}
