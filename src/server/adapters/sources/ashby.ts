import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { PayPeriod } from "@/shared/enums";
import type { HttpClient } from "../http";
import {
  checkBoard,
  dateOrNull,
  getBody,
  labelFromSlug,
  type Posting,
  readJson,
  type SourceAdapter,
  SourceError,
  slugFromPath,
  structuredPay,
} from "./types";

/**
 * Ashby job boards (https://developers.ashbyhq.com/docs/public-job-posting-api). The posting API
 * returns the whole board, so the source is complete. Unlisted postings are skipped. Salary comes
 * from the compensation summary when the board publishes it. The API does not name the company,
 * so the board's slug becomes the label and the company.
 */

const API = "https://api.ashbyhq.com/posting-api/job-board";
const NAME = "Ashby";
const BOARD_HOSTS = new Set(["jobs.ashbyhq.com"]);

const Component = z.object({
  compensationType: z.string().nullish(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

const Job = z.object({
  id: z.string(),
  title: z.string(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  employmentType: z.string().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  publishedAt: z.string().nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  jobUrl: z.string(),
  applyUrl: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  compensation: z.object({ summaryComponents: z.array(Component).nullish() }).nullish(),
});
const Board = z.object({ jobs: z.array(Job) });

const INTERVALS: Readonly<Record<string, PayPeriod>> = {
  "1 HOUR": "hour",
  "1 DAY": "day",
  "1 WEEK": "week",
  "1 MONTH": "month",
  "1 YEAR": "year",
};

/** The board slug in an Ashby link (jobs.ashbyhq.com/acme), or null. */
export function ashbyBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (url?.hostname.toLowerCase() === "api.ashbyhq.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "posting-api" || parts[1] !== "job-board" || !parts[2]) return null;
    return slugFromPath({ raw: `https://jobs.ashbyhq.com/${parts[2]}`, hosts: BOARD_HOSTS });
  }
  return slugFromPath({ raw, hosts: BOARD_HOSTS });
}

function payOf(job: z.infer<typeof Job>) {
  const salary = job.compensation?.summaryComponents?.find((c) => c.compensationType === "Salary");
  if (!salary) return null;
  const period = salary.interval ? (INTERVALS[salary.interval] ?? null) : null;
  return structuredPay({ min: salary.minValue, max: salary.maxValue, currency: salary.currencyCode, period });
}

function locationOf(job: z.infer<typeof Job>): string {
  const places = [job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)]
    .map((p) => decodeEntities(p ?? "").trim())
    .filter(Boolean);
  const text = [...new Set(places)].join("; ");
  const remote = job.isRemote === true || job.workplaceType === "Remote";
  return remote && !/remote/i.test(text) ? (text ? `${text} (Remote)` : "Remote") : text;
}

export function createAshbyAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "ashby",
    name: NAME,
    complete: true,
    minIntervalMinutes: 30,
    board: {
      fromUrl: ashbyBoardFromUrl,
      async check(board) {
        const body = await checkBoard({ http, url: `${API}/${board}`, name: NAME, board });
        readJson({ body, schema: Board, name: NAME });
        return { label: labelFromSlug(board) };
      },
    },
    async fetch({ board }) {
      if (board === null) throw new SourceError({ kind: "failed", message: "This Ashby source has no board." });
      const body = await getBody({ http, url: `${API}/${board}?includeCompensation=true`, name: NAME });
      const { jobs } = readJson({ body, schema: Board, name: NAME });
      const company = labelFromSlug(board);
      const postings: Posting[] = jobs
        .filter((job) => job.isListed !== false)
        .map((job) => ({
          externalId: job.id,
          title: decodeEntities(job.title).trim(),
          company,
          description: job.descriptionHtml ? htmlToText(job.descriptionHtml) : (job.descriptionPlain ?? "").trim(),
          locationText: locationOf(job),
          applyUrl: job.jobUrl,
          listingUrl: job.jobUrl,
          postedAt: dateOrNull(job.publishedAt),
          expiresAt: null,
          pay: payOf(job),
          restrictions: null,
          tags: [job.department, job.team].map((t) => (t ?? "").trim()).filter(Boolean),
        }));
      return { complete: true, postings, unread: [] };
    },
  };
}
