/**
 * Sites whose terms forbid automated access (section 3.2 step 1, open question 5). Add by link
 * never fetches these; it opens the paste form with the link kept as the apply URL. Shared so
 * the dialog can name the site in its message.
 */
const BLOCKED_SITES: readonly { name: string; domains: readonly string[] }[] = [
  { name: "LinkedIn", domains: ["linkedin.com", "lnkd.in"] },
  { name: "Indeed", domains: ["indeed.com", "indeed.co.uk", "indeed.ca", "indeed.com.ph", "indeed.com.au"] },
  { name: "JobStreet", domains: ["jobstreet.com", "jobstreet.com.ph", "jobstreet.com.sg", "jobstreet.com.my"] },
  { name: "Kalibrr", domains: ["kalibrr.com", "kalibrr.id"] },
  { name: "OnlineJobs.ph", domains: ["onlinejobs.ph"] },
  { name: "Upwork", domains: ["upwork.com"] },
  { name: "Glassdoor", domains: ["glassdoor.com", "glassdoor.co.uk", "glassdoor.ca", "glassdoor.com.au"] },
  { name: "Wellfound", domains: ["wellfound.com", "angel.co"] },
  { name: "Toptal", domains: ["toptal.com"] },
];

/** The site's name when `url` is on a host that forbids automation (any subdomain), else null. */
export function blockedSite(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const site = BLOCKED_SITES.find((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`)));
  return site?.name ?? null;
}
