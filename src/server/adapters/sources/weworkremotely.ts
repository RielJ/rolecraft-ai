import { DOMParser } from "linkedom";
import { decodeEntities, htmlToText } from "@/domain/text";
import type { HttpClient } from "../http";
import { dateOrNull, getBody, type Posting, type SourceAdapter, SourceError } from "./types";

/**
 * We Work Remotely (https://weworkremotely.com/api-terms-and-guidelines). The RSS feed lists the
 * newest postings, so the source is incomplete. Item titles read "Company: Title". The terms ask
 * for attribution and that applicants apply on WWR, so the WWR listing is both the listing link
 * and the apply link, and jobs show "via We Work Remotely".
 */

const FEED = "https://weworkremotely.com/remote-jobs.rss";
const NAME = "We Work Remotely";

type Item = Record<string, string>;

/** Every `<item>` of an RSS 2.0 feed as a map of child element name to text, or null if it is not RSS. */
export function rssItems(xml: string): Item[] | null {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (root?.nodeName.toLowerCase() !== "rss") return null;
  const channel = [...root.children].find((c) => c.nodeName.toLowerCase() === "channel");
  if (!channel) return null;
  return [...channel.children]
    .filter((c) => c.nodeName.toLowerCase() === "item")
    .map((item) => Object.fromEntries([...item.children].map((c) => [c.nodeName.toLowerCase(), c.textContent ?? ""])));
}

/** "Hooli: Senior Rails Developer" as company and title. A title with no company keeps it all. */
export function splitWwrTitle(raw: string): { company: string; title: string } {
  const text = decodeEntities(raw).trim();
  const at = text.indexOf(": ");
  if (at <= 0) return { company: "Unknown company", title: text };
  return { company: text.slice(0, at).trim(), title: text.slice(at + 2).trim() };
}

export function createWeWorkRemotelyAdapter(http: HttpClient): SourceAdapter {
  return {
    kind: "weworkremotely",
    name: NAME,
    complete: false,
    minIntervalMinutes: 30,
    async fetch() {
      const body = await getBody({
        http,
        url: FEED,
        name: NAME,
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      });
      const items = rssItems(body);
      if (items === null)
        throw new SourceError({ kind: "parse", message: `${NAME} answered with something that is not RSS.` });
      const postings: Posting[] = [];
      for (const item of items) {
        const link = (item.link ?? item.guid ?? "").trim();
        const raw = item.title ?? "";
        if (!link || !raw.trim()) {
          throw new SourceError({ kind: "parse", message: `${NAME} listed a job with no title or link.` });
        }
        const { company, title } = splitWwrTitle(raw);
        postings.push({
          externalId: (item.guid ?? "").trim() || link,
          title,
          company,
          description: htmlToText(item.description ?? ""),
          locationText: (item.region ?? "").trim(),
          applyUrl: link,
          listingUrl: link,
          postedAt: dateOrNull(item.pubdate),
          expiresAt: dateOrNull(item.expires_at),
          pay: null,
          restrictions: null,
          tags: [item.category, item.type].map((t) => (t ?? "").trim()).filter(Boolean),
        });
      }
      return { complete: false, postings, unread: [] };
    },
  };
}
