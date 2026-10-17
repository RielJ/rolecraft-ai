import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { PayPeriod } from "@/shared/enums";
import type { HttpClient } from "../http";
import {
  checkBoard,
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
 * Lever job boards (https://github.com/lever/postings-api). `GET /v0/postings/<company>?mode=json`
 * returns every published posting as an array, so the source is complete. Lever has
 * `workplaceType` and an optional structured `salaryRange`. The API does not name the company,
 * so the board's slug becomes the label and the company.
 */

const API = "https://api.lever.co/v0/postings";
const NAME = "Lever";
const BOARD_HOSTS = new Set(["jobs.lever.co", "api.lever.co"]);

const Job = z.object({
  id: z.string(),
  text: z.string(),
  categories: z
    .object({
      commitment: z.string().nullish(),
      department: z.string().nullish(),
      location: z.string().nullish(),
      team: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  /** Unix milliseconds. */
  createdAt: z.number().nullish(),
  description: z.string().nullish(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  additional: z.string().nullish(),
  workplaceType: z.string().nullish(),
  salaryRange: z
    .object({
      currency: z.string().nullish(),
      interval: z.string().nullish(),
      min: z.number().nullish(),
      max: z.number().nullish(),
    })
    .nullish(),
  hostedUrl: z.string(),
  applyUrl: z.string().nullish(),
});
const Board = z.array(Job);

const INTERVALS: Readonly<Record<string, PayPeriod>> = {
  "per-hour-wage": "hour",
  "per-day-wage": "day",
  "per-week-salary": "week",
  "per-month-salary": "month",
  "per-year-salary": "year",
};

/** The company slug in a Lever link (jobs.lever.co/acme, api.lever.co/v0/postings/acme), or null. */
export function leverBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (url?.hostname.toLowerCase() === "api.lever.co") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v0" || parts[1] !== "postings" || !parts[2]) return null;
    return slugFromPath({ raw: `https://jobs.lever.co/${parts[2]}`, hosts: BOARD_HOSTS });
  }
  return slugFromPath({ raw, hosts: BOARD_HOSTS });
}

/** The posting's HTML parts as one text: description, each list under its heading, then the rest. */
function leverDescription(job: z.infer<typeof Job>): string {
  const lists = (job.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`).join("");
  return htmlToText(`${job.description ?? ""}${lists}${job.additional ?? ""}`);
}

function locationOf(job: z.infer<typeof Job>): string {
  const place = decodeEntities(job.categories?.location ?? "").trim();
  const workplace = job.workplaceType && job.workplaceType !== "unspecified" ? job.workplaceType : "";
  if (workplace && !place.toLowerCase().includes(workplace.toLowerCase())) {
    const label = workplace.charAt(0).toUpperCase() + workplace.slice(1);
    return place ? `${place} (${label})` : label;
  }
  return place;
}

export function createLeverAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "lever",
    name: NAME,
    complete: true,
    minIntervalMinutes: 30,
    board: {
      fromUrl: leverBoardFromUrl,
      async check(board) {
        const body = await checkBoard({ http, url: `${API}/${board}?mode=json&limit=1`, name: NAME, board });
        readJson({ body, schema: Board, name: NAME });
        return { label: labelFromSlug(board) };
      },
    },
    async fetch({ board }) {
      if (board === null) throw new SourceError({ kind: "failed", message: "This Lever source has no board." });
      const body = await getBody({ http, url: `${API}/${board}?mode=json`, name: NAME });
      const jobs = readJson({ body, schema: Board, name: NAME });
      const company = labelFromSlug(board);
      const postings: Posting[] = jobs.map((job) => {
        const range = job.salaryRange;
        const period = range?.interval ? (INTERVALS[range.interval] ?? null) : null;
        return {
          externalId: job.id,
          title: decodeEntities(job.text).trim(),
          company,
          description: leverDescription(job),
          locationText: locationOf(job),
          applyUrl: job.hostedUrl,
          listingUrl: job.hostedUrl,
          postedAt: typeof job.createdAt === "number" ? new Date(job.createdAt) : null,
          expiresAt: null,
          pay: range ? structuredPay({ min: range.min, max: range.max, currency: range.currency, period }) : null,
          restrictions: null,
          tags: [job.categories?.department, job.categories?.team, job.categories?.commitment]
            .map((t) => (t ?? "").trim())
            .filter(Boolean),
        };
      });
      return { complete: true, postings, unread: [] };
    },
  };
}
