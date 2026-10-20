import { dirname, join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { getDocumentProxy } from "unpdf";
import { parseRoleHeader } from "@/domain/work-roles";
import type { Contact } from "@/shared/api";

export type PdfDocument = {
  contact: Contact;
  /** Used for the PDF's metadata title only. */
  title: string;
  /**
   * Marker-free body in the small Markdown subset: `#`, `##`, `-`, `**`, and `### Title | Company,
   * Location | Dates` role headers (decision 71). A `[[...]]` blank renders
   * as a highlighted box (the preview shows blanks; exports are gated so they have none).
   */
  body: string;
};

export type PdfRenderer = {
  render(doc: PdfDocument): Promise<Uint8Array>;
  close(): Promise<void>;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[\[([^\]]*)\]\]/g, '<span class="blank">$1</span>');
}

type Block = { kind: "heading" | "role" | "ul"; html: string } | { kind: "p"; lines: string[] };

/** A line that is only a web link: a link, shown without its scheme, `www.` or trailing slash. */
function linkLine(line: string): string {
  if (!/^https?:\/\/\S+$/i.test(line)) return inline(line);
  const shown = line.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
  return `<a class="entry-link" href="${escapeHtml(line)}">${escapeHtml(shown)}</a>`;
}

function blockHtml(block: Block, title: boolean): string {
  if (block.kind !== "p") return block.html;
  const [first = "", ...rest] = block.lines.map(linkLine);
  // A paragraph that opens an entry with bullets is its name (a project): bold, like a role title,
  // with its link and other lines below in the smaller muted style of a role's company line.
  if (!title) return `<p>${[first, ...rest].join("<br>")}</p>`;
  return `<p class="entry-head">${[`<strong class="entry-title">${first}</strong>`, ...rest].join("<br>")}</p>`;
}

/**
 * Wrap the blocks under each heading in `.entry` divs that the PDF never splits, so every page
 * starts on a heading or an entry's first line (a role title, a project name), never mid-bullets.
 * An entry starts at a role header or at a paragraph, and runs until the next heading or role, or
 * until a paragraph that follows a list (the next project). An entry taller than a page still splits.
 */
function groupEntries(blocks: Block[]): string[] {
  const out: string[] = [];
  let entry: Block[] = [];
  const close = () => {
    const titled = entry[0]?.kind === "p" && entry.some((b) => b.kind === "ul");
    if (entry.length)
      out.push(`<div class="entry">${entry.map((b, i) => blockHtml(b, titled && i === 0)).join("")}</div>`);
    entry = [];
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      close();
      out.push(blockHtml(block, false));
      continue;
    }
    const startsEntry = block.kind === "role" || (block.kind === "p" && entry.some((b) => b.kind === "ul"));
    if (startsEntry) close();
    entry.push(block);
  }
  close();
  return out;
}

/** The Markdown subset to HTML. Everything is escaped first, so the body can't inject markup. */
export function bodyHtml(body: string): string {
  const html: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push({ kind: "p", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) {
      html.push({ kind: "ul", html: `<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>` });
    }
    list = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const role = parseRoleHeader(line);
    if (line === "") {
      flushParagraph();
      flushList();
    } else if (role) {
      // Like the CV: the title in bold with the dates on the right, the company and location below.
      flushParagraph();
      flushList();
      const dates = role.dates ? `<span class="role-dates">${inline(role.dates)}</span>` : "";
      html.push({
        kind: "role",
        html: `<div class="role"><p class="role-line"><strong class="role-title">${inline(role.title)}</strong>${dates}</p><p class="role-org">${inline(role.org)}</p></div>`,
      });
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1] === "#" ? "h2" : "h3";
      html.push({ kind: "heading", html: `<${level}>${inline(heading[2] ?? "")}</${level}>` });
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? "");
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return groupEntries(html).join("\n");
}

function fontFace(): string {
  // Self-hosted Literata, inlined so Chromium needs no file or network access.
  const pkg = dirname(Bun.resolveSync("@fontsource-variable/literata", import.meta.dir));
  return join(pkg, "files", "literata-latin-wght-normal.woff2");
}

let fontCss: Promise<string> | null = null;
function loadFontCss(): Promise<string> {
  fontCss ??= Bun.file(fontFace())
    .arrayBuffer()
    .then(
      (buf) =>
        `@font-face{font-family:"Literata";font-weight:200 900;font-style:normal;src:url(data:font/woff2;base64,${Buffer.from(buf).toString("base64")}) format("woff2");}`,
    );
  return fontCss;
}

/**
 * Layout densities, loosest first. The renderer uses the first one, and steps tighter only when
 * the last page holds a few rows and a tighter step saves that page (`fitPages`). The last step is
 * the floor: 10pt body text, the usual minimum for a resume. Once text reaches 10pt, later steps only tighten line
 * height, gaps and margins.
 */
export const DENSITIES = [
  { fontPt: 10.5, lineHeight: 1.5, marginMm: [18, 20], space: 1 },
  { fontPt: 10.5, lineHeight: 1.44, marginMm: [16, 18], space: 0.85 },
  { fontPt: 10.25, lineHeight: 1.4, marginMm: [15, 17], space: 0.75 },
  { fontPt: 10, lineHeight: 1.38, marginMm: [14, 16], space: 0.65 },
  { fontPt: 10, lineHeight: 1.34, marginMm: [13, 15], space: 0.55 },
] as const;

/** A last page filled less than this (of its height) is worth trying to pull onto the pages before it. */
export const SHORT_LAST_PAGE = 0.3;

export async function documentHtml(doc: PdfDocument, density = 0): Promise<string> {
  const { contact } = doc;
  const details = [contact.email, contact.phone, contact.location, ...contact.links].filter((d) => d.trim() !== "");
  const d = DENSITIES[density] ?? DENSITIES[0];
  const sp = (pt: number) => `${Math.round(pt * d.space * 100) / 100}pt`;
  const small = `${d.fontPt - 1}pt`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title>
<style>
${await loadFontCss()}
@page { size: A4; margin: ${d.marginMm[0]}mm ${d.marginMm[1]}mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Literata", Georgia, serif; font-size: ${d.fontPt}pt; line-height: ${d.lineHeight}; color: #1d1b18; }
header { margin-bottom: ${sp(14)}; padding-bottom: ${sp(8)}; border-bottom: 0.75pt solid #b9b2a7; }
h1 { margin: 0 0 2pt; font-size: 20pt; font-weight: 600; letter-spacing: -0.01em; }
.contact { margin: 0; font-size: ${small}; color: #4a453e; font-variant-numeric: tabular-nums; }
.contact span + span::before { content: " · "; }
h2 { margin: ${sp(14)} 0 ${sp(4)}; font-size: ${d.fontPt + 2}pt; font-weight: 600; break-after: avoid; }
h3 { margin: ${sp(10)} 0 ${sp(3)}; font-size: ${d.fontPt + 0.5}pt; font-weight: 600; break-after: avoid; }
p { margin: 0 0 ${sp(7)}; }
ul { margin: 0 0 ${sp(7)}; padding-left: 14pt; }
li { margin: 0 0 ${sp(2)}; break-inside: avoid; }
.entry { break-inside: avoid; }
.role { margin: ${sp(10)} 0 ${sp(3)}; break-inside: avoid; break-after: avoid; }
.role-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; margin: 0; }
.role-title, .entry-title { font-weight: 600; }
.entry-head { margin: ${sp(10)} 0 ${sp(3)}; font-size: ${d.fontPt - 0.5}pt; color: #4a453e; }
.entry-head .entry-title { font-size: ${d.fontPt}pt; color: #1d1b18; }
.entry-link { color: inherit; text-decoration: none; }
.role-dates { flex: none; white-space: nowrap; font-size: ${small}; color: #4a453e; font-variant-numeric: tabular-nums; }
.role-org { margin: 0; font-size: ${d.fontPt - 0.5}pt; color: #4a453e; }
.blank { border-radius: 2pt; box-shadow: 0 0 0 1.5pt #ffedd5, 0 0 0 2.25pt #c2410c; background: #ffedd5; color: #7c2d12; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
</style></head>
<body>
<header>
<h1>${escapeHtml(contact.fullName)}</h1>
<p class="contact">${details.map((d) => `<span>${escapeHtml(d)}</span>`).join("")}</p>
</header>
<main>
${bodyHtml(doc.body)}
</main>
</body></html>`;
}

/** Headless Chromium through playwright-core (decision 47). One browser, launched on first use. */
export function createChromiumPdf({ executablePath }: { executablePath?: string | undefined }): PdfRenderer {
  let browser: Promise<Browser> | null = null;

  const getBrowser = async (): Promise<Browser> => {
    if (browser) {
      const current = await browser.catch(() => null);
      if (current?.isConnected()) return current;
    }
    browser = chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    return browser;
  };

  const render = async (doc: PdfDocument): Promise<Uint8Array> => {
    const context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) => route.abort());
      return await fitPages(async (density) => {
        await page.setContent(await documentHtml(doc, density), { waitUntil: "load" });
        return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      });
    } finally {
      await context.close();
    }
  };

  return {
    render,
    async close() {
      const current = await browser?.catch(() => null);
      browser = null;
      await current?.close();
    },
  };
}

/** The page count, and how far down the last page its text reaches (0 = top, 1 = bottom). */
export async function pageFill(bytes: Uint8Array): Promise<{ pages: number; lastFill: number }> {
  // pdfjs takes ownership of the buffer it is given, so it reads a copy.
  const doc = await getDocumentProxy(bytes.slice());
  const last = await doc.getPage(doc.numPages);
  const height = last.view[3] ?? 0;
  const { items } = await last.getTextContent();
  const baselines = items.flatMap((item) => ("transform" in item ? [Number(item.transform[5])] : []));
  const lowest = baselines.length > 0 ? Math.min(...baselines) : height;
  return { pages: doc.numPages, lastFill: height > 0 ? (height - lowest) / height : 1 };
}

/**
 * Render at the loosest density. When the result runs past one page and its last page holds only
 * a few rows (`SHORT_LAST_PAGE`), look for the loosest tighter density that needs fewer pages. The
 * tightest is tried first: if even it saves no page, none can (tighter never adds pages), so the
 * loosest render stands after one extra try. Tighter type is only worth a page saved.
 */
export async function fitPages(renderAt: (density: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  const first = await renderAt(0);
  const { pages, lastFill } = await pageFill(first);
  if (pages <= 1 || lastFill >= SHORT_LAST_PAGE) return first;
  const tightest = DENSITIES.length - 1;
  const fitted = await renderAt(tightest);
  if ((await pageFill(fitted)).pages >= pages) return first;
  for (let density = 1; density < tightest; density++) {
    const tighter = await renderAt(density);
    if ((await pageFill(tighter)).pages < pages) return tighter;
  }
  return fitted;
}
