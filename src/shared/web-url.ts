/**
 * `raw` as an absolute http(s) URL, or null. Job sources send apply URLs as plain strings; anything
 * else (`javascript:`, `data:`, a relative path) must never be opened from the app, because a tab the
 * app opens starts out with the app's own origin.
 */
export function webUrl(raw: string): string | null {
  const url = URL.parse(raw);
  if (url === null) return null;
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
