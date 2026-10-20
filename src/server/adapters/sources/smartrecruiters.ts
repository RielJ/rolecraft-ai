import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import { type HttpClient, HttpError } from "../http";
import {
  BOARD_SLUG,
  dateOrNull,
  getBody,
  type Posting,
  readJson,
  type SourceAdapter,
  SourceError,
  sourceErrorFrom,
} from "./types";

/**
 * SmartRecruiters (https://developers.smartrecruiters.com/docs/posting-api). The list endpoint
 * pages through the whole board, so the source is complete, but it carries no description: each
 * posting needs its own detail request. To stay polite, one run reads details for at most
 * `SMARTRECRUITERS_DETAIL_BUDGET` postings it has not stored yet. Stored postings and new ones past
 * the budget come back as `unread`: they are on the board, so nothing closes, and the new ones are
 * read on a later run. A stored posting's text is not re-read.
 */

const API = "https://api.smartrecruiters.com/v1/companies";
const NAME = "SmartRecruiters";
/** Polite fetching: at most 50 detail fetches of new postings per run. */
export const SMARTRECRUITERS_DETAIL_BUDGET = 50;
const PAGE = 100;
/** Ten pages: boards of up to 1,000 postings. */
const MAX_PAGES = 10;
const BOARD_HOSTS = new Set(["jobs.smartrecruiters.com", "careers.smartrecruiters.com"]);

const Label = z.object({ label: z.string().nullish() }).nullish();
const Location = z
  .object({
    city: z.string().nullish(),
    country: z.string().nullish(),
    remote: z.boolean().nullish(),
    fullLocation: z.string().nullish(),
  })
  .nullish();

const Summary = z.object({
  id: z.string(),
  name: z.string(),
  company: z.object({ name: z.string().nullish() }).nullish(),
  releasedDate: z.string().nullish(),
  location: Location,
  department: Label,
  function: Label,
});
const ListPage = z.object({ totalFound: z.number(), content: z.array(Summary) });

const Section = z.object({ title: z.string().nullish(), text: z.string().nullish() }).nullish();
const Detail = Summary.extend({
  postingUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  jobAd: z.object({
    sections: z.object({
      companyDescription: Section,
      jobDescription: Section,
      qualifications: Section,
      additionalInformation: Section,
    }),
  }),
});

/** The company identifier in a SmartRecruiters link (jobs.smartrecruiters.com/Acme), in lower case. */
export function smartRecruitersBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let slug: string | null = null;
  if (BOARD_HOSTS.has(host)) slug = parts[0] ?? null;
  else if (host === "api.smartrecruiters.com" && parts[0] === "v1" && parts[1] === "companies") slug = parts[2] ?? null;
  return slug && BOARD_SLUG.test(slug) ? slug.toLowerCase() : null;
}

function locationOf(location: z.infer<typeof Location>): string {
  const place = decodeEntities(location?.fullLocation ?? location?.city ?? "").trim();
  if (location?.remote !== true) return place;
  return place ? `${place} (Remote)` : "Remote";
}

function descriptionOf(detail: z.infer<typeof Detail>): string {
  const { companyDescription, jobDescription, qualifications, additionalInformation } = detail.jobAd.sections;
  const html = [companyDescription, jobDescription, qualifications, additionalInformation]
    .filter((s) => s?.text?.trim())
    .map((s) => `${s?.title ? `<h3>${s.title}</h3>` : ""}${s?.text ?? ""}`)
    .join("");
  return htmlToText(html);
}

export function createSmartRecruitersAdapter(http: HttpClient): SourceAdapter {
  async function listPage(board: string, offset: number) {
    const body = await getBody({ http, url: `${API}/${board}/postings?limit=${PAGE}&offset=${offset}`, name: NAME });
    return readJson({ body, schema: ListPage, name: NAME });
  }

  /** One posting's detail, or null when it was taken down between the list and this request. */
  async function detail(board: string, id: string): Promise<z.infer<typeof Detail> | null> {
    let body: string;
    try {
      body = (await http.getText(`${API}/${board}/postings/${id}`, { accept: "application/json" })).body;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw sourceErrorFrom(error, NAME);
    }
    return readJson({ body, schema: Detail, name: NAME });
  }

  return {
    kind: "smartrecruiters",
    name: NAME,
    complete: true,
    minIntervalMinutes: 30,
    board: {
      fromUrl: smartRecruitersBoardFromUrl,
      async check(board) {
        // SmartRecruiters answers an unknown company with an empty list, not a 404.
        const { totalFound, content } = await listPage(board, 0);
        if (totalFound === 0) {
          throw new SourceError({
            kind: "failed",
            message: `SmartRecruiters lists no jobs for "${board}". Check the link, or add the board once it has openings.`,
          });
        }
        return { label: content[0]?.company?.name?.trim() || board };
      },
    },
    async fetch({ board, known }) {
      if (board === null)
        throw new SourceError({ kind: "failed", message: "This SmartRecruiters source has no board." });
      const listed: z.infer<typeof Summary>[] = [];
      let complete = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { totalFound, content } = await listPage(board, page * PAGE);
        listed.push(...content);
        if (content.length < PAGE || listed.length >= totalFound) {
          complete = true;
          break;
        }
      }

      const postings: Posting[] = [];
      const unread: string[] = [];
      let budget = SMARTRECRUITERS_DETAIL_BUDGET;
      for (const summary of listed) {
        if (known.has(summary.id) || budget === 0) {
          unread.push(summary.id);
          continue;
        }
        budget--;
        const full = await detail(board, summary.id);
        if (full === null) continue;
        const url = full.postingUrl?.trim() || `https://jobs.smartrecruiters.com/${board}/${full.id}`;
        postings.push({
          externalId: full.id,
          title: decodeEntities(full.name).trim(),
          company: decodeEntities(full.company?.name ?? "").trim() || board,
          description: descriptionOf(full),
          locationText: locationOf(full.location),
          applyUrl: url,
          listingUrl: url,
          postedAt: dateOrNull(full.releasedDate),
          expiresAt: null,
          pay: null,
          restrictions: null,
          tags: [full.department?.label, full.function?.label].map((t) => (t ?? "").trim()).filter(Boolean),
        });
      }
      // A board past the page cap is a window: nothing closes on absence.
      return { complete, postings, unread };
    },
  };
}
