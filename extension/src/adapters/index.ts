import type { ScanAdapter } from "../content/scan";
import { ASHBY_HOSTS, ASHBY_MARKER, ashby } from "./ashby";
import { GREENHOUSE_HOSTS, GREENHOUSE_MARKER, greenhouse } from "./greenhouse";
import { LEVER_HOSTS, LEVER_MARKER, lever } from "./lever";

// ATS adapter detection: the page's host and the ATS's own form markup must both match.
// Anything else (a company site embedding a form, a redesigned page) uses the generic scan.

const ADAPTERS: readonly { hosts: ReadonlySet<string>; marker: string; adapter: ScanAdapter }[] = [
  { hosts: GREENHOUSE_HOSTS, marker: GREENHOUSE_MARKER, adapter: greenhouse },
  { hosts: LEVER_HOSTS, marker: LEVER_MARKER, adapter: lever },
  { hosts: ASHBY_HOSTS, marker: ASHBY_MARKER, adapter: ashby },
];

/** The adapter for this page, or null for the generic scan. `host` is `location.hostname`. */
export function detect(host: string, document: Document): ScanAdapter | null {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  const found = ADAPTERS.find((a) => a.hosts.has(normalized) && document.querySelector(a.marker) !== null);
  return found?.adapter ?? null;
}
