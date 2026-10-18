/**
 * `Content-Disposition: inline` for a file the user named (decision 69). `filename` is an ASCII
 * stand-in: every character outside printable ASCII, and `"`, `\` and `%`, become `_`, so no quote
 * or newline can end the header early and no browser decodes a `%xx` in it. `filename*` (RFC 6266,
 * RFC 8187) carries the exact name, UTF-8 and percent-encoded.
 */
export function inlineDisposition(fileName: string): string {
  // A lone surrogate would make encodeURIComponent throw; under /u only lone ones match \p{Cs}.
  const name = fileName.replace(/\p{Cs}/gu, "\uFFFD") || "cv.pdf";
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${exact}`;
}
