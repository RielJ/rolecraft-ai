import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { type Pay, payPhrase } from "@/domain/pay";
import { htmlToText } from "@/domain/text";
import { PayPeriod } from "@/shared/enums";

/**
 * What one job page says, read once (section 3.2 step 4). A JSON-LD `JobPosting` block wins;
 * otherwise Readability on linkedom pulls the main text. Every field may be missing; the service
 * decides whether there is enough to create a job.
 */
export type PageRead = {
  via: "json-ld" | "readability";
  title: string | null;
  company: string | null;
  /** Plain text, paragraphs and bullets kept. */
  description: string;
  locationText: string;
  postedAt: Date | null;
  expiresAt: Date | null;
  pay: Pay | null;
  /** JSON-LD `applicantLocationRequirements` names, or null when the page gives none. */
  restrictions: string[] | null;
};

// ---------- JSON-LD ----------

const Text = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const Named = z.union([Text, z.object({ name: Text.optional() }).passthrough()]);
const OneOrMany = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema)]).transform((v): z.infer<T>[] => (Array.isArray(v) ? v : [v]));

const Address = z
  .object({ addressLocality: Text.optional(), addressRegion: Text.optional(), addressCountry: Named.optional() })
  .passthrough();
const Place = z.object({ address: z.union([Address, Text]).optional() }).passthrough();

const UNIT_PERIODS: Readonly<Record<string, PayPeriod>> = {
  HOUR: "hour",
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
};

const Amount = z.union([z.number(), z.string()]).transform((v) => Number(String(v).replace(/,/g, "")));
const Salary = z
  .object({
    currency: Text.optional(),
    value: z
      .union([
        Amount,
        z
          .object({
            value: Amount.optional(),
            minValue: Amount.optional(),
            maxValue: Amount.optional(),
            unitText: Text.optional(),
          })
          .passthrough(),
      ])
      .optional(),
    unitText: Text.optional(),
  })
  .passthrough();

const JobPosting = z
  .object({
    title: Text.optional(),
    name: Text.optional(),
    description: Text.optional(),
    hiringOrganization: Named.optional(),
    datePosted: Text.optional(),
    validThrough: Text.optional(),
    baseSalary: Salary.optional(),
    jobLocation: OneOrMany(Place).optional(),
    jobLocationType: Text.optional(),
    applicantLocationRequirements: OneOrMany(Named).optional(),
  })
  .passthrough();
type JobPosting = z.infer<typeof JobPosting>;

function nameOf(value: z.infer<typeof Named> | undefined): string | null {
  if (value === undefined) return null;
  const name = typeof value === "string" ? value : (value.name ?? "");
  return name.trim() === "" ? null : name.trim();
}

function isJobPosting(node: unknown): boolean {
  if (typeof node !== "object" || node === null || !("@type" in node)) return false;
  const type = node["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** Every object in a JSON-LD value, through arrays and `@graph`. */
function* nodes(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) {
    for (const v of value) yield* nodes(v);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  yield value;
  if ("@graph" in value) yield* nodes(value["@graph"]);
}

/** The slice of a DOM document this reader queries; linkedom's and the browser's both fit. */
type Queryable = {
  querySelector(selector: string): { textContent: string | null; getAttribute(name: string): string | null } | null;
  querySelectorAll(selector: string): Iterable<{ textContent: string | null }>;
};

function findJobPosting(document: Queryable): JobPosting | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let json: unknown;
    try {
      json = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    for (const node of nodes(json)) {
      if (!isJobPosting(node)) continue;
      const parsed = JobPosting.safeParse(node);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

function dateOf(text: string | undefined): Date | null {
  if (text === undefined || text === "") return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function salaryOf(salary: z.infer<typeof Salary> | undefined): Pay | null {
  if (!salary?.currency || salary.value === undefined) return null;
  const currency = salary.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const v = salary.value;
  const [low, high, unit] =
    typeof v === "number"
      ? [v, undefined, salary.unitText]
      : [v.minValue ?? v.value, v.maxValue, v.unitText ?? salary.unitText];
  if (low === undefined || !(low > 0)) return null;
  const max = high !== undefined && high > low ? high : null;
  const period = PayPeriod.safeParse(UNIT_PERIODS[(unit ?? "").toUpperCase()]);
  const pay = { min: low, max, currency, period: period.success ? period.data : null };
  return { ...pay, phrase: payPhrase(pay) };
}

function locationOf(posting: JobPosting): string {
  const places = (posting.jobLocation ?? []).map((place) => {
    const address = place.address;
    if (address === undefined) return "";
    if (typeof address === "string") return address;
    return [address.addressLocality, address.addressRegion, nameOf(address.addressCountry) ?? undefined]
      .filter((p): p is string => p !== undefined && p !== "")
      .join(", ");
  });
  const remote = posting.jobLocationType?.toUpperCase() === "TELECOMMUTE" ? ["Remote"] : [];
  return [...remote, ...places.filter((p) => p !== "")].join("; ");
}

function fromJsonLd(posting: JobPosting): PageRead {
  const restrictions = posting.applicantLocationRequirements?.map(nameOf).filter((n): n is string => n !== null);
  return {
    via: "json-ld",
    title: posting.title || posting.name || null,
    company: nameOf(posting.hiringOrganization),
    description: htmlToText(posting.description ?? ""),
    locationText: locationOf(posting),
    postedAt: dateOf(posting.datePosted),
    expiresAt: dateOf(posting.validThrough),
    pay: salaryOf(posting.baseSalary),
    restrictions: restrictions === undefined ? null : restrictions,
  };
}

// ---------- Readability fallback ----------

function meta(document: Queryable, selector: string): string | null {
  const content = document.querySelector(selector)?.getAttribute("content")?.trim();
  return content ? content : null;
}

function fromReadability(html: string): PageRead {
  const { document } = parseHTML(html);
  const heading = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() || null;
  const ogTitle = meta(document, 'meta[property="og:title"]');
  const siteName = meta(document, 'meta[property="og:site_name"]');
  // Readability rewrites the document, so it gets its own copy.
  // SAFETY: linkedom implements the DOM subset Readability reads (querySelectorAll, element
  // tree walking, attributes, textContent); its own Document type is not declared as lib.dom's.
  const article = new Readability(parseHTML(html).document as unknown as Document).parse();
  return {
    via: "readability",
    title: heading ?? ogTitle ?? article?.title?.trim() ?? null,
    company: siteName ?? article?.siteName?.trim() ?? null,
    description: article?.content ? htmlToText(article.content) : "",
    locationText: "",
    postedAt: dateOf(article?.publishedTime ?? undefined),
    expiresAt: null,
    pay: null,
    restrictions: null,
  };
}

/** Read one job page's HTML. Never throws on odd markup; missing fields come back null or empty. */
export function readPage({ html }: { html: string }): PageRead {
  const { document } = parseHTML(html);
  const posting = findJobPosting(document);
  if (posting) {
    const read = fromJsonLd(posting);
    // A JSON-LD block with an empty description still names the job; take the page text.
    if (read.description.trim() !== "") return read;
    const fallback = fromReadability(html);
    return { ...read, description: fallback.description };
  }
  return fromReadability(html);
}
