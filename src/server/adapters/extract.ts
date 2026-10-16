import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * CV text extraction (section 3.3, step 1): `unpdf` for PDF, `mammoth` for DOCX. The file is
 * read once and never stored; only the text goes on.
 */

type ExtractFailure = "no_text_layer" | "empty" | "unreadable" | "unsupported";

export type ExtractResult =
  | { kind: "text"; format: "pdf" | "docx"; text: string }
  | { kind: "failed"; reason: ExtractFailure; message: string };

/** A PDF yielding fewer characters than this is treated as a scan without a text layer. */
const MIN_PDF_CHARS = 200;

export const EXTRACT_MESSAGES: Record<ExtractFailure, string> = {
  no_text_layer: "This PDF has no text layer. Paste the text instead.",
  empty: "This document has no text in it. Paste the text instead.",
  unreadable: "This file could not be read. Save it again as PDF or DOCX, or paste the text instead.",
  unsupported: "Only PDF and DOCX files can be read. Save it as one of those, or paste the text instead.",
};

const fail = (reason: ExtractFailure): ExtractResult => ({ kind: "failed", reason, message: EXTRACT_MESSAGES[reason] });

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4

/** Tidy extracted text: no NULs or trailing spaces, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readPdf(bytes: Uint8Array): Promise<ExtractResult> {
  let text: string;
  try {
    // pdf.js may transfer the buffer it is given, so it gets a copy.
    const doc = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
    text = (await extractText(doc, { mergePages: true })).text;
  } catch {
    return fail("unreadable");
  }
  const clean = tidy(text);
  if (clean.length < MIN_PDF_CHARS) return fail("no_text_layer");
  return { kind: "text", format: "pdf", text: clean };
}

async function readDocx(bytes: Uint8Array): Promise<ExtractResult> {
  let text: string;
  try {
    text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  } catch {
    return fail("unreadable");
  }
  // mammoth ends every paragraph with a blank line; one line per paragraph matches PDF and paste.
  const clean = tidy(text.replace(/\n\n/g, "\n"));
  if (clean === "") return fail("empty");
  return { kind: "text", format: "docx", text: clean };
}

/** Read a CV file. The format comes from the file's first bytes, not its name. */
export async function extractCvText({ bytes }: { bytes: Uint8Array }): Promise<ExtractResult> {
  if (startsWith(bytes, PDF_MAGIC)) return readPdf(bytes);
  if (startsWith(bytes, ZIP_MAGIC)) return readDocx(bytes);
  return fail("unsupported");
}
