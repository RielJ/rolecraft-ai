import { dirname, join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import type { Contact } from "@/shared/api";

export type PdfDocument = {
  contact: Contact;
  /** Used for the PDF's metadata title only. */
  title: string;
  /** Marker-free body in the small Markdown subset: `#`, `##`, `-`, `**`. */
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
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** The Markdown subset to HTML. Everything is escaped first, so the body can't inject markup. */
export function bodyHtml(body: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (line === "") {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1] === "#" ? "h2" : "h3";
      html.push(`<${level}>${inline(heading[2] ?? "")}</${level}>`);
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
  return html.join("\n");
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

export async function documentHtml(doc: PdfDocument): Promise<string> {
  const { contact } = doc;
  const details = [contact.email, contact.phone, contact.location, ...contact.links].filter((d) => d.trim() !== "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title>
<style>
${await loadFontCss()}
@page { size: A4; margin: 18mm 20mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Literata", Georgia, serif; font-size: 10.5pt; line-height: 1.5; color: #1d1b18; }
header { margin-bottom: 14pt; padding-bottom: 8pt; border-bottom: 0.75pt solid #b9b2a7; }
h1 { margin: 0 0 2pt; font-size: 20pt; font-weight: 600; letter-spacing: -0.01em; }
.contact { margin: 0; font-size: 9.5pt; color: #4a453e; font-variant-numeric: tabular-nums; }
.contact span + span::before { content: " · "; }
h2 { margin: 14pt 0 4pt; font-size: 12.5pt; font-weight: 600; }
h3 { margin: 10pt 0 3pt; font-size: 11pt; font-weight: 600; }
p { margin: 0 0 7pt; }
ul { margin: 0 0 7pt; padding-left: 14pt; }
li { margin: 0 0 2pt; }
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

  return {
    async render(doc) {
      const html = await documentHtml(doc);
      const context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.route("**/*", (route) => route.abort());
        await page.setContent(html, { waitUntil: "load" });
        return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      } finally {
        await context.close();
      }
    },
    async close() {
      const current = await browser?.catch(() => null);
      browser = null;
      await current?.close();
    },
  };
}
