/** Lowercase, drop punctuation, collapse whitespace. Letters and digits of any script are kept. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  const n = normalize(text);
  return n === "" ? [] : n.split(" ");
}

// ---------- HTML to plain text (no HTML is stored; section "What this plan cuts") ----------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  peso: "₱",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decode HTML character references. Unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const DROPPED_ELEMENTS = /<(script|style|noscript|template|head|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|table|tr|blockquote|pre|dl|dt|dd|hr|figure)\b[^>]*>/gi;

/**
 * Plain text from HTML, keeping paragraph and list breaks: blocks become blank-line breaks,
 * `<br>` a line break, and `<li>` a "- " bullet. Entity-escaped HTML (common in JSON-LD) is
 * decoded first.
 */
export function htmlToText(html: string): string {
  const source = /<[a-z!/]/i.test(html) || !/&lt;[a-z/]/i.test(html) ? html : decodeEntities(html);
  const marked = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROPPED_ELEMENTS, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n\n- ")
    .replace(/<\/li\s*>/gi, "\n\n")
    .replace(BLOCK_TAGS, "\n\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  const lines = decodeEntities(marked)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v \u00a0]+/g, " ").trim());
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (line === "") {
      blank = out.length > 0;
      continue;
    }
    const bullet = line.startsWith("- ");
    const previousBullet = out.at(-1)?.startsWith("- ") ?? false;
    // Consecutive bullets stay a tight list; anything else after a gap is a new paragraph.
    if (blank && !(bullet && previousBullet)) out.push("");
    out.push(line);
    blank = false;
  }
  return out.join("\n");
}

/** Sentences and lines of plain text, for rules that quote the sentence that decided them. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\d"“(])/u)
    .map((s) => s.replace(/^[-*•]\s+/, "").trim())
    .filter((s) => s !== "");
}

/**
 * The text that two copies of the same posting share: lowercased, URLs and dates removed,
 * whitespace collapsed. Tracking links and "posted 3 days ago" lines then don't differ.
 */
export function descriptionKey(description: string): string {
  const cleaned = description
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sha256Hex(cleaned);
}

export function contentHash(input: {
  title: string;
  company: string;
  locationText: string;
  description: string;
  payPhrase: string | null;
}): string {
  return sha256Hex(
    [input.title, input.company, input.locationText, input.description, input.payPhrase ?? ""].join("\u0000"),
  );
}

// ---------- SHA-256 (FIPS 180-4), pure so the domain needs no crypto import ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }

  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------- Sentences of a draft ----------

/** A sentence of a draft body, with its offsets so a caller can replace it in place. */
export type SentenceSpan = { text: string; start: number; end: number; line: number };

// A Markdown line prefix the drafting format allows: heading, bullet or numbered item.
const LINE_PREFIX = /^\s*(?:#{1,6}\s+|[-*•]\s+|\d{1,2}[.)]\s+)?/;
// A sentence ends at . ! or ? (plus any [FACT-n] markers right after it), then whitespace,
// then the next sentence's first character. "2.5M" and "e.g. this" do not split.
const BOUNDARY = /(?<=[.!?]["”’)]?(?:\s*\[FACT-[1-9]\d*\])*)\s+(?!\[FACT-)(?=[\p{Lu}\d"“[(])/gu;

/**
 * Split a draft into sentences: every Markdown line is its own unit, and prose lines split at
 * sentence ends. Markers after the full stop stay with the sentence they follow.
 */
export function sentenceSpans(body: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let offset = 0;
  body.split("\n").forEach((raw, line) => {
    const prefix = LINE_PREFIX.exec(raw)?.[0].length ?? 0;
    const content = raw.slice(prefix);
    let cursor = 0;
    const push = (from: number, to: number) => {
      const piece = content.slice(from, to);
      const lead = piece.length - piece.trimStart().length;
      const text = piece.trim();
      if (text === "") return;
      const start = offset + prefix + from + lead;
      spans.push({ text, start, end: start + text.length, line });
    };
    for (const m of content.matchAll(BOUNDARY)) {
      push(cursor, m.index);
      cursor = m.index + m[0].length;
    }
    push(cursor, content.length);
    offset += raw.length + 1;
  });
  return spans;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
