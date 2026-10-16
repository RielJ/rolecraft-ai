/**
 * Writes the CV upload fixtures: cv.pdf (a text layer), cv.docx (Word paragraphs) and
 * cv-scanned.pdf (one image, no text layer). Each is a few hundred bytes, built by hand so no
 * generator becomes a dependency. Run with `bun test/fixtures/make-fixtures.ts`.
 */
import { join } from "node:path";

export const CV_LINES = [
  "Maria Santos",
  "Backend Engineer, Cebu City",
  "EXPERIENCE",
  "- Built a billing service in TypeScript and Postgres at Lakbay Labs",
  "- Cut invoice processing time from 40 minutes to 6 minutes",
  "- Mentored 3 junior engineers through code review",
  "EDUCATION",
  "- BS Computer Science, University of San Carlos, 2018",
];

const encoder = new TextEncoder();

// ---------- PDF ----------

function pdf(objects: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

function stream(content: string, dict = ""): string {
  return `<< ${dict}/Length ${content.length} >>\nstream\n${content}\nendstream`;
}

const escapePdf = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function textPdf(lines: readonly string[]): Uint8Array {
  const content = ["BT", "/F1 11 Tf", "15 TL", "72 720 Td", ...lines.map((l) => `(${escapePdf(l)}) Tj T*`), "ET"].join(
    "\n",
  );
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    stream(content),
  ]);
}

/** A page that is one 8x8 grey image, like a scan with no OCR. */
function scannedPdf(): Uint8Array {
  const pixels = Array.from({ length: 64 }, (_, i) => ((i * 37) % 256).toString(16).padStart(2, "0")).join("");
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    stream(
      `${pixels}>`,
      "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode ",
    ),
    stream("q 468 0 0 600 72 100 cm /Im1 Do Q"),
  ]);
}

// ---------- DOCX (a stored, uncompressed ZIP) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: { name: string; text: string }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function docx(lines: readonly string[]): Uint8Array {
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r></w:p>`).join("");
  return zip([
    {
      name: "[Content_Types].xml",
      text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: "word/document.xml",
      text: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

if (import.meta.main) {
  const dir = import.meta.dir;
  await Bun.write(join(dir, "cv.pdf"), textPdf(CV_LINES));
  await Bun.write(join(dir, "cv.docx"), docx(CV_LINES));
  await Bun.write(join(dir, "cv-scanned.pdf"), scannedPdf());
  console.info("wrote cv.pdf, cv.docx and cv-scanned.pdf");
}
