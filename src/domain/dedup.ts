import { tokens } from "./text";

const TITLE_SYNONYMS: Readonly<Record<string, string>> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  jnr: "junior",
};

/** Lowercased, parentheticals and punctuation dropped, sr -> senior, tokens sorted. */
export function titleKey(title: string): string {
  const withoutParens = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  return tokens(withoutParens)
    .map((t) => TITLE_SYNONYMS[t] ?? t)
    .sort()
    .join(" ");
}

const COMPANY_SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co"]);

/** Lowercased, punctuation and trailing legal suffixes (Inc, LLC, Ltd, Corp, Co) dropped. */
export function companyKey(company: string): string {
  const parts = tokens(company);
  while (parts.length > 1 && COMPANY_SUFFIXES.has(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(" ");
}

const TRACKING_PARAM = /^(utm_.*|ref|referrer|source)$/i;

/** Host lowercased, utm_* and ref params dropped, hash dropped, no trailing slash. Null if not http(s). */
export function applyUrlKey(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`;
}
