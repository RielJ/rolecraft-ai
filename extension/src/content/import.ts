import type { ScanNonce } from "@shared/extension";
import { z } from "zod";
import { IMPORT_LIMITS, ImportContentReply, type ImportDraft } from "../messages-import";
import type { Box, Measure } from "./scan";

// Read the visible job page for "Import this page" (docs/EXTENSION.md). Runs
// only when the worker asks, which it does only after the user's click. Visible text only: hidden
// elements, scripts, forms, navigation and footers never reach the preview. A JobPosting JSON-LD
// block is used only when the page visibly shows the same title.

/** Skipped everywhere: never visible text, or a control whose value is not page text. */
const NEVER_TEXT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "head",
  "input",
  "select",
  "textarea",
  "button",
  "option",
  "datalist",
]);

/** Also skipped for the description: page furniture and the application form itself. */
const NOT_DESCRIPTION: ReadonlySet<string> = new Set([...NEVER_TEXT, "nav", "footer", "form", "aside"]);

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

/** Job boards whose name is the site name, not the employer's. */
const ATS_SITE_NAMES = /^(?:greenhouse|lever|ashby|workday|smartrecruiters|workable|bamboohr|jobvite|icims)$/i;

/** ATS hosts whose first path segment is the employer's board slug. */
const ATS_BOARD_HOSTS: ReadonlySet<string> = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
]);

const MAX_DEPTH = 400;
const MAX_JSON_LD = 200_000;
/** Enough of the page to check JSON-LD against; the description has its own cap. */
const MAX_PAGE_TEXT = 200_000;

const noMeasure: Measure = () => null;

// ---------- Visibility ----------

/** The element itself is hidden by attribute or computed style. Ancestors are not checked. */
export function hiddenSelf(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.hasAttribute("inert")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;
  const style = view.getComputedStyle(element);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.opacity === "0"
  );
}

/**
 * The element is clipped out of sight: a tiny box with overflow hidden (the "visually hidden"
 * pattern), or a box placed wholly above or left of the page. A zero-height wrapper of floats is
 * not hidden, so a small box alone does not count.
 */
function clippedOut(element: Element, box: Box | null): boolean {
  if (box === null) return false;
  if ((box.width > 0 && box.left + box.width <= 0) || (box.height > 0 && box.top + box.height <= 0)) return true;
  if (box.width >= 2 && box.height >= 2) return false;
  const view = element.ownerDocument.defaultView;
  const overflow = view?.getComputedStyle(element).overflow ?? "";
  return /hidden|clip/.test(overflow);
}

/** The element and every ancestor are shown. */
export function isVisible(element: Element, measure: Measure = noMeasure): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (hiddenSelf(node) || clippedOut(node, measure(node))) return false;
  }
  return true;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/**
 * The visible text under `root`, one line per block, at most `max` characters. Hidden subtrees and
 * `skip` tags are left out. Stops walking once it has enough.
 */
export function visibleText({
  root,
  max,
  skip = NEVER_TEXT,
  measure = noMeasure,
}: {
  root: Element;
  max: number;
  skip?: ReadonlySet<string>;
  measure?: Measure;
}): string {
  if (!isVisible(root, measure)) return "";
  const parts: string[] = [];
  let length = 0;

  const walk = (element: Element, depth: number) => {
    for (const child of element.childNodes) {
      if (length > max) return;
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ");
        parts.push(text);
        length += text.length;
        continue;
      }
      if (!isElement(child) || depth >= MAX_DEPTH) continue;
      if (skip.has(child.localName) || hiddenSelf(child) || clippedOut(child, measure(child))) continue;
      const block = BLOCK_TAGS.has(child.localName);
      if (block) parts.push("\n");
      else if (child.localName === "td" || child.localName === "th") parts.push(" ");
      walk(child, depth + 1);
      if (block) parts.push("\n");
    }
  };
  walk(root, 0);

  return parts
    .join("")
    .split("\n")
    .map(collapse)
    .filter((line) => line !== "")
    .join("\n")
    .slice(0, max);
}

/** Lowercased, whitespace collapsed: for "does the page show this" checks only. */
function normalize(text: string): string {
  return collapse(text).toLowerCase();
}

// ---------- JSON-LD ----------

const LdName = z.union([z.string(), z.object({ name: z.string().optional() })]);
const LdAddress = z.union([
  z.string(),
  z.object({
    addressLocality: z.string().optional(),
    addressRegion: z.string().optional(),
    addressCountry: LdName.optional(),
  }),
]);
const LdPlace = z.object({ address: LdAddress.optional() });

/** The JobPosting properties the import reads. Unknown properties are dropped. */
const JobPostingLd = z.object({
  title: z.string().optional(),
  hiringOrganization: LdName.optional(),
  jobLocation: z.union([LdPlace, z.array(LdPlace)]).optional(),
  jobLocationType: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});
type JobPostingLd = z.infer<typeof JobPostingLd>;

const LdNode = z.object({ "@type": z.union([z.string(), z.array(z.string())]) });

function isJobPosting(value: unknown): boolean {
  const node = LdNode.safeParse(value);
  if (!node.success) return false;
  const types = typeof node.data["@type"] === "string" ? [node.data["@type"]] : node.data["@type"];
  return types.includes("JobPosting");
}

/** Every object in a JSON-LD value, through arrays and `@graph`. */
function ldNodes(value: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap((v) => ldNodes(v, depth + 1));
  const graph = z.object({ "@graph": z.array(z.unknown()) }).safeParse(value);
  return graph.success ? [value, ...ldNodes(graph.data["@graph"], depth + 1)] : [value];
}

function jobPostingLd(document: Document): JobPostingLd | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent ?? "";
    if (text.length > MAX_JSON_LD) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const node of ldNodes(parsed)) {
      if (!isJobPosting(node)) continue;
      const posting = JobPostingLd.safeParse(node);
      if (posting.success) return posting.data;
    }
  }
  return null;
}

function nameOf(value: z.infer<typeof LdName> | undefined): string {
  if (value === undefined) return "";
  return collapse(typeof value === "string" ? value : (value.name ?? ""));
}

function ldLocation(posting: JobPostingLd): string {
  const places = posting.jobLocation === undefined ? [] : [posting.jobLocation].flat();
  const first = places[0]?.address;
  if (first !== undefined) {
    if (typeof first === "string") return collapse(first);
    const parts = [first.addressLocality, first.addressRegion, nameOf(first.addressCountry)];
    return parts
      .map((p) => collapse(p ?? ""))
      .filter((p) => p !== "")
      .join(", ");
  }
  return posting.jobLocationType === "TELECOMMUTE" ? "Remote" : "";
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * JSON-LD descriptions are HTML (sometimes escaped twice). Turned into lines of text with string
 * operations only, so the page's markup is never parsed into a DOM.
 */
function htmlToText(html: string): string {
  let text = html.slice(0, MAX_JSON_LD);
  if (!/<[a-z]/i.test(text)) text = decodeEntities(text);
  return decodeEntities(
    text
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>|<\/?(?:p|div|li|ul|ol|h[1-6]|tr|section|article|blockquote|pre|dd|dt)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split("\n")
    .map(collapse)
    .filter((line) => line !== "")
    .join("\n")
    .slice(0, IMPORT_LIMITS.description);
}

// ---------- Page heuristics ----------

/** Elements whose class, id or test hook mentions `word` (lower or capitalized). */
export function byHint(document: Document, word: string): Element[] {
  const upper = word.charAt(0).toUpperCase() + word.slice(1);
  const selector = [word, upper]
    .flatMap((w) => [`[class*="${w}"]`, `[id*="${w}"]`, `[data-qa*="${w}"]`, `[data-testid*="${w}"]`])
    .join(", ");
  return [...document.querySelectorAll(selector)];
}

/** The first candidate with short visible text, a label like "Location:" removed. */
function shortText({
  candidates,
  max,
  label,
  measure,
}: {
  candidates: readonly Element[];
  max: number;
  label: RegExp;
  measure: Measure;
}): string {
  for (const element of candidates) {
    const text = collapse(visibleText({ root: element, max: max * 4, measure }).replaceAll("\n", ", ")).replace(
      label,
      "",
    );
    if (text.length >= 2 && text.length <= max) return text;
  }
  return "";
}

function meta(document: Document, property: string): string {
  const element = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  return collapse(element?.getAttribute("content") ?? "");
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function boardSlug(url: URL): string {
  if (!ATS_BOARD_HOSTS.has(url.hostname)) return "";
  const [, slug] = url.pathname.split("/");
  return slug === undefined ? "" : titleCase(decodeURIComponent(slug));
}

function headings(document: Document, measure: Measure): string[] {
  return [...document.querySelectorAll("h1, h2, h3")]
    .filter((h) => isVisible(h, measure))
    .map((h) => collapse(visibleText({ root: h, max: 1000, measure })));
}

function pageTitle(document: Document, measure: Measure): string {
  const [h1] = [...document.querySelectorAll("h1")].filter((h) => isVisible(h, measure));
  const fromHeading = h1 === undefined ? "" : collapse(visibleText({ root: h1, max: 1000, measure }));
  return fromHeading || meta(document, "og:title") || collapse(document.title);
}

function pageCompany(document: Document, url: URL, measure: Measure): string {
  const hinted = shortText({
    candidates: [...document.querySelectorAll('[itemprop="hiringOrganization"]'), ...byHint(document, "company")],
    max: IMPORT_LIMITS.company,
    label: /^company[:\s]*/i,
    measure,
  });
  if (hinted !== "") return hinted;
  const slug = boardSlug(url);
  if (slug !== "") return slug;
  const site = meta(document, "og:site_name");
  if (site !== "" && !ATS_SITE_NAMES.test(site)) return site;
  return collapse(/\bat\s+([^|–—-]+)/.exec(document.title)?.[1] ?? "");
}

function pageLocation(document: Document, measure: Measure): string {
  return shortText({
    candidates: [...document.querySelectorAll('[itemprop="jobLocation"]'), ...byHint(document, "location")],
    max: IMPORT_LIMITS.location,
    label: /^location[:\s]*/i,
    measure,
  });
}

function pageDescription(document: Document, measure: Measure): string {
  const roots = ['[itemprop="description"]', "main", '[role="main"]', "article"]
    .map((selector) => document.querySelector(selector))
    .filter((element) => element !== null);
  for (const root of [...roots, document.body]) {
    if (root === null) continue;
    const text = visibleText({ root, max: IMPORT_LIMITS.description, skip: NOT_DESCRIPTION, measure });
    if (text !== "") return text;
  }
  return "";
}

/** The JSON-LD `url` when it is http(s) on the page's own host; else the page address. */
function applyUrlOf(page: URL, posting: JobPostingLd | null): string {
  const declared = posting?.url === undefined ? null : URL.parse(posting.url, page);
  const sameHost = declared !== null && /^https?:$/.test(declared.protocol) && declared.hostname === page.hostname;
  return sameHost && declared.href.length <= IMPORT_LIMITS.url ? declared.href : page.href;
}

function cap(text: string, max: number): string {
  return text.slice(0, max).trim();
}

/**
 * Read the visible job posting. Null on a page that is not http(s). Every field is capped and may
 * be empty; the panel shows it all for editing before anything is saved.
 */
export function extractJob(
  document: Document,
  { measure = noMeasure }: { measure?: Measure } = {},
): ImportDraft | null {
  const page = URL.parse(document.location?.href ?? "");
  if (page === null || !/^https?:$/.test(page.protocol) || page.href.length > IMPORT_LIMITS.url) return null;

  const body = document.body;
  const shown = body === null ? "" : normalize(visibleText({ root: body, max: MAX_PAGE_TEXT, measure }));
  const shows = (text: string) => text !== "" && shown.includes(normalize(text));

  const posting = jobPostingLd(document);
  const ldTitle = collapse(posting?.title ?? "");
  // The JSON-LD title must be a visible heading, not just words somewhere on the page.
  const agrees = ldTitle !== "" && headings(document, measure).some((h) => normalize(h) === normalize(ldTitle));
  const ld = agrees ? posting : null;

  const ldCompany = ld === null ? "" : nameOf(ld.hiringOrganization);
  const ldLoc = ld === null ? "" : ldLocation(ld);
  const ldLocality = ldLoc.split(",")[0] ?? "";
  const ldDescription = ld?.description === undefined ? "" : htmlToText(ld.description);

  return {
    pageUrl: page.href,
    applyUrl: applyUrlOf(page, ld),
    title: cap(ld === null ? pageTitle(document, measure) : ldTitle, IMPORT_LIMITS.title),
    company: cap(shows(ldCompany) ? ldCompany : pageCompany(document, page, measure), IMPORT_LIMITS.company),
    location: cap(
      ldLoc !== "" && ldLoc.length <= IMPORT_LIMITS.location && shows(ldLocality)
        ? ldLoc
        : pageLocation(document, measure),
      IMPORT_LIMITS.location,
    ),
    description: cap(
      shows(ldDescription.slice(0, 120)) ? ldDescription : pageDescription(document, measure),
      IMPORT_LIMITS.description,
    ),
    source: ld === null ? "page" : "json_ld",
  };
}

/**
 * The content script's answer to `read_job`, parsed before it leaves. Null when the page is not
 * http(s) or the extract does not fit the schema; the worker treats no answer as `bad_reply`.
 */
export function readJobReply({
  document,
  nonce,
  measure = noMeasure,
}: {
  document: Document;
  nonce: ScanNonce;
  measure?: Measure;
}): ImportContentReply | null {
  const draft = extractJob(document, { measure });
  if (draft === null) return null;
  const reply = ImportContentReply.safeParse({ kind: "read_job_result", nonce, draft });
  return reply.success ? reply.data : null;
}
