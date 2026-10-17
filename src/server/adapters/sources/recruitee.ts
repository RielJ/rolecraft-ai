import { z } from "zod";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { PayPeriod } from "@/shared/enums";
import type { HttpClient } from "../http";
import {
  BOARD_SLUG,
  checkBoard,
  dateOrNull,
  getBody,
  labelFromSlug,
  type Posting,
  readJson,
  type SourceAdapter,
  SourceError,
  structuredPay,
} from "./types";

/**
 * Recruitee career sites (https://docs.recruitee.com/reference/offers). `GET
 * <company>.recruitee.com/api/offers` returns every published offer with its description, so
 * the source is complete. Offers carry `remote`/`hybrid`/`on_site` and an optional salary.
 */

const NAME = "Recruitee";

const Offer = z.object({
  id: z.number(),
  slug: z.string().nullish(),
  status: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  location: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  careers_url: z.string(),
  careers_apply_url: z.string().nullish(),
  company_name: z.string().nullish(),
  department: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  salary: z
    .object({
      min: z.union([z.string(), z.number()]).nullish(),
      max: z.union([z.string(), z.number()]).nullish(),
      currency: z.string().nullish(),
      period: z.string().nullish(),
    })
    .nullish(),
  /** "2026-10-14 08:00:00 UTC". */
  published_at: z.string().nullish(),
  close_at: z.string().nullish(),
});
const Offers = z.object({ offers: z.array(Offer) });

const PERIODS: Readonly<Record<string, PayPeriod>> = {
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

const apiOf = (board: string) => `https://${board}.recruitee.com/api/offers`;

/** Recruitee's "2026-10-14 08:00:00 UTC" as a date. */
function recruiteeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.trim().replace(" UTC", "Z").replace(" ", "T");
  return dateOrNull(iso);
}

/** The company subdomain in a Recruitee link (acme.recruitee.com), or null. */
export function recruiteeBoardFromUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (!url) return null;
  const m = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/i.exec(url.hostname);
  const slug = m?.[1] ?? null;
  return slug && slug.toLowerCase() !== "www" && slug.toLowerCase() !== "app" && BOARD_SLUG.test(slug)
    ? slug.toLowerCase()
    : null;
}

function locationOf(offer: z.infer<typeof Offer>): string {
  const place = decodeEntities(offer.location || [offer.city, offer.country].filter(Boolean).join(", ")).trim();
  const mode = offer.remote ? "Remote" : offer.hybrid ? "Hybrid" : "";
  if (!mode || place.toLowerCase().includes(mode.toLowerCase())) return place;
  return place ? `${place} (${mode})` : mode;
}

export function createRecruiteeAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "recruitee",
    name: NAME,
    complete: true,
    minIntervalMinutes: 30,
    board: {
      fromUrl: recruiteeBoardFromUrl,
      async check(board) {
        const body = await checkBoard({ http, url: apiOf(board), name: NAME, board });
        const { offers } = readJson({ body, schema: Offers, name: NAME });
        return { label: offers[0]?.company_name?.trim() || labelFromSlug(board) };
      },
    },
    async fetch({ board }) {
      if (board === null) throw new SourceError({ kind: "failed", message: "This Recruitee source has no board." });
      const body = await getBody({ http, url: apiOf(board), name: NAME });
      const { offers } = readJson({ body, schema: Offers, name: NAME });
      const postings: Posting[] = offers
        .filter((o) => !o.status || o.status === "published")
        .map((offer) => {
          const salary = offer.salary;
          const period = salary?.period ? (PERIODS[salary.period] ?? null) : null;
          return {
            externalId: String(offer.id),
            title: decodeEntities(offer.title).trim(),
            company: decodeEntities(offer.company_name ?? "").trim() || labelFromSlug(board),
            description: htmlToText(`${offer.description ?? ""}${offer.requirements ?? ""}`),
            locationText: locationOf(offer),
            applyUrl: offer.careers_url,
            listingUrl: offer.careers_url,
            postedAt: recruiteeDate(offer.published_at),
            expiresAt: recruiteeDate(offer.close_at),
            pay: salary ? structuredPay({ min: salary.min, max: salary.max, currency: salary.currency, period }) : null,
            restrictions: null,
            tags: [offer.department ?? "", ...(offer.tags ?? [])].map((t) => t.trim()).filter(Boolean),
          };
        });
      return { complete: true, postings, unread: [] };
    },
  };
}
