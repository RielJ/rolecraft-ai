/**
 * Posting text comes in as plain text: blank lines between paragraphs, "-" or "•" bullets, and
 * short lines like "What you'll do:" as section titles. This splits it into blocks so the page can
 * show real headings and lists. It only reads layout; it never changes or drops words.
 */
export type PostingBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const BULLET = /^[-•*·▪●◦–—]\s+/;
const NUMBERED = /^\d{1,2}[.)]\s+/;

/** A section title: short, one line, and either ends in a colon or has no closing punctuation. */
function headingText(line: string): string | null {
  if (line.length > 60) return null;
  if (line.endsWith(":")) return line.slice(0, -1).trim() || null;
  if (/[.!?,;)\]"'”’]$/.test(line)) return null;
  return line.split(/\s+/).length <= 6 ? line : null;
}

function bulletOf(line: string): { ordered: boolean; text: string } | null {
  if (BULLET.test(line)) return { ordered: false, text: line.replace(BULLET, "") };
  if (NUMBERED.test(line)) return { ordered: true, text: line.replace(NUMBERED, "") };
  return null;
}

export function postingBlocks(text: string): PostingBlock[] {
  const blocks: PostingBlock[] = [];
  const chunks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.split("\n"));

  for (const raw of chunks) {
    const lines = raw.map((l) => l.trim());
    if (lines.every((l) => l === "")) continue;
    let paragraph: string[] = [];
    let list: Extract<PostingBlock, { kind: "list" }> | null = null;
    const flushParagraph = () => {
      if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    };

    for (const [i, line] of lines.entries()) {
      if (line === "") continue;
      const bullet = bulletOf(line);
      if (bullet) {
        flushParagraph();
        if (!list || list.ordered !== bullet.ordered) {
          list = { kind: "list", ordered: bullet.ordered, items: [] };
          blocks.push(list);
        }
        list.items.push(bullet.text);
        continue;
      }
      // An indented line straight after a bullet is that bullet wrapping onto a new line.
      const last = list?.items.length ? list.items.length - 1 : -1;
      if (list && last >= 0 && /^\s+/.test(raw[i] ?? "") && paragraph.length === 0) {
        list.items[last] = `${list.items[last]} ${line}`;
        continue;
      }
      list = null;
      // A title on its own, or a title line sitting directly above bullets.
      const nextIsBullet = bulletOf(lines[i + 1] ?? "") !== null;
      const alone = lines.filter((l) => l !== "").length === 1;
      const heading = paragraph.length === 0 && (alone || nextIsBullet) ? headingText(line) : null;
      if (heading) {
        blocks.push({ kind: "heading", text: heading });
        continue;
      }
      paragraph.push(line);
    }
    flushParagraph();
  }
  return blocks;
}
