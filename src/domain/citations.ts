import { FactKey } from "@/shared/api";

// [FACT-n] with n >= 1, not part of a [[...]] placeholder.
const MARKER = /(?<!\[)\[FACT-([1-9]\d*)\](?!\])/g;
const PLACEHOLDER = /\[\[([^\]]*)\]\]/g;

export function factKey(no: number): FactKey {
  // The only place a FactKey is built from a number; the schema checks the format.
  return FactKey.parse(`FACT-${no}`);
}

/** Distinct cited keys, in order of first use. */
export function parseCitations(body: string): FactKey[] {
  const seen = new Set<string>();
  const keys: FactKey[] = [];
  for (const match of body.matchAll(MARKER)) {
    const no = Number(match[1]);
    const key = factKey(no);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** The inner text of every `[[...]]` placeholder. */
export function findPlaceholders(body: string): string[] {
  return Array.from(body.matchAll(PLACEHOLDER), (m) => m[1] ?? "");
}

/** Remove `[FACT-n]` markers (and the spaces before them) for PDF and Copy as text. */
export function stripMarkers(body: string): string {
  return body.replace(/[ \t]*(?<!\[)\[FACT-[1-9]\d*\](?!\])/g, "");
}
