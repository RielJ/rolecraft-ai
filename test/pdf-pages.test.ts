import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { extractText, getDocumentProxy } from "unpdf";
import {
  bodyHtml,
  createChromiumPdf,
  DENSITIES,
  documentHtml,
  fitPages,
  pageFill,
  SHORT_LAST_PAGE,
} from "@/server/adapters/pdf";

// Page breaks in the resume PDF: every page starts on a heading or an entry's first line (a role
// title or a project name), never on a bullet or the middle of a role. And a last page with only a
// few rows is pulled onto the pages before it with tighter spacing, when that saves the page.

const pdf = createChromiumPdf({ executablePath: process.env.HB_CHROMIUM_PATH || undefined });
afterAll(() => pdf.close());

describe("bodyHtml entries", () => {
  test("a role and its bullets are one entry; the heading stays outside", () => {
    const html = bodyHtml("## Experience\n### Engineer | Acme, Remote | 2024 – 2025\n- Built a thing\n- Ran a thing");
    expect(html).toBe(
      [
        "<h3>Experience</h3>",
        '<div class="entry"><div class="role"><p class="role-line"><strong class="role-title">Engineer</strong><span class="role-dates">2024 – 2025</span></p><p class="role-org">Acme, Remote</p></div><ul><li>Built a thing</li><li>Ran a thing</li></ul></div>',
      ].join("\n"),
    );
  });

  test("each project (a name paragraph with bullets) is its own entry, with its name in bold", () => {
    const html = bodyHtml("## Projects\nNyx - Formatter\nhttps://x.dev/nyx\n- Sorts classes.\nKit\n- Builds kits.");
    expect(html).toBe(
      [
        "<h3>Projects</h3>",
        '<div class="entry"><p class="entry-head"><strong class="entry-title">Nyx - Formatter</strong><br><a class="entry-link" href="https://x.dev/nyx">x.dev/nyx</a></p><ul><li>Sorts classes.</li></ul></div>',
        '<div class="entry"><p class="entry-head"><strong class="entry-title">Kit</strong></p><ul><li>Builds kits.</li></ul></div>',
      ].join("\n"),
    );
  });

  test("a link line shows without its scheme, www or trailing slash, and only http(s) links are links", () => {
    expect(bodyHtml("Kit\nhttps://www.github.com/a/kit/\n- Builds kits.")).toContain(
      '<a class="entry-link" href="https://www.github.com/a/kit/">github.com/a/kit</a>',
    );
    expect(bodyHtml('Kit\njavascript:alert("x")\n- Builds kits.')).toContain("<br>javascript:alert(&quot;x&quot;)</p>");
    // A link inside a sentence stays text.
    expect(bodyHtml("See https://x.dev for more")).not.toContain("<a ");
  });

  test("a paragraph with no bullets is an entry but not a title", () => {
    expect(bodyHtml("## Education\nB.S. Computer Engineering (2022)\nSome University")).toBe(
      '<h3>Education</h3>\n<div class="entry"><p>B.S. Computer Engineering (2022)<br>Some University</p></div>',
    );
  });
});

const BULLET =
  "Built and ran a billing service in TypeScript and Postgres that handled invoices, refunds and reports for clinics across the region.";

/** A resume long enough for several pages: 8 roles of 5 long bullets, then 6 projects. */
function longResume(): { body: string; starts: string[] } {
  const starts = ["Summary", "Experience", "Projects"];
  const lines = ["## Summary", "Backend engineer with 7 years of production work.", "", "## Experience"];
  for (let i = 1; i <= 8; i++) {
    starts.push(`Engineer ${i}`);
    lines.push(`### Engineer ${i} | Company ${i}, Remote | 201${i} – 201${i + 1}`);
    for (let b = 0; b < 5; b++) lines.push(`- ${BULLET}`);
    lines.push("");
  }
  lines.push("## Projects");
  for (let i = 1; i <= 6; i++) {
    starts.push(`Project ${i} - Tool`);
    lines.push(`Project ${i} - Tool`, `https://example.com/p${i}`, `- ${BULLET}`, `- ${BULLET}`, "");
  }
  return { body: lines.join("\n"), starts };
}

test("every page after the first starts on a heading, a role title or a project name", async () => {
  const { body, starts } = longResume();
  const bytes = await pdf.render({
    contact: { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] },
    title: "Resume",
    body,
  });
  const { totalPages, text } = await extractText(await getDocumentProxy(bytes), { mergePages: false });
  expect(totalPages).toBeGreaterThanOrEqual(3);
  const tops = text.slice(1).map((page) => page.trim().split("\n")[0]?.trim() ?? "");
  for (const top of tops) {
    expect(starts.some((s) => top.toUpperCase().startsWith(s.toUpperCase()))).toBe(true);
  }
}, 30_000);

const CONTACT = { fullName: "Maria Santos", email: "maria@example.ph", phone: "", location: "Manila", links: [] };

/** `n` roles of three long bullets. Measured at the loosest density: 5 roles give 2 pages with the
 *  last 21% full (the tightest fits them on 1); 6 give 38%, past the threshold. */
function roles(n: number): string {
  const lines = ["## Experience"];
  for (let i = 1; i <= n; i++) {
    lines.push(
      `### Engineer ${i} | Company ${i}, Remote | 2019 – 2020`,
      `- ${BULLET}`,
      `- ${BULLET}`,
      `- ${BULLET}`,
      "",
    );
  }
  return lines.join("\n");
}

test("no layout sets body text under 10pt", () => {
  for (const density of DENSITIES) expect(density.fontPt).toBeGreaterThanOrEqual(10);
});

describe("fitting a short last page", () => {
  const render = async (n: number) => pageFill(await pdf.render({ contact: CONTACT, title: "Resume", body: roles(n) }));

  test("a last page with a few rows is pulled onto the page before it", async () => {
    expect((await render(5)).pages).toBe(1);
  }, 30_000);

  test("a last page filled past the threshold is left alone", async () => {
    const fill = await render(6);
    expect(fill.pages).toBe(2);
    expect(fill.lastFill).toBeGreaterThan(SHORT_LAST_PAGE);
  }, 30_000);
});

test("fitting tries the tightest layout first and stops when even it saves no page", async () => {
  const executablePath = process.env.HB_CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    /** The densities `fitPages` asks for. `ignoreDensity` renders every try at the loosest, so no try saves a page. */
    const tried = async (n: number, ignoreDensity = false) => {
      const densities: number[] = [];
      await fitPages(async (density) => {
        densities.push(density);
        const html = await documentHtml(
          { contact: CONTACT, title: "Resume", body: roles(n) },
          ignoreDensity ? 0 : density,
        );
        await page.setContent(html);
        return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      });
      return densities;
    };
    expect(await tried(6)).toEqual([0]);
    expect(await tried(5, true)).toEqual([0, DENSITIES.length - 1]);
    expect((await tried(5)).slice(0, 2)).toEqual([0, DENSITIES.length - 1]);
  } finally {
    await browser.close();
  }
}, 30_000);
