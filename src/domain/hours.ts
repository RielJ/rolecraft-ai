/**
 * Working hours a posting states, converted to Philippine time (decision 8). Times are kept as
 * "HH:MM" in the posting's own zone; the zone is an IANA name so daylight saving is applied for
 * the posting's date when converting.
 */
export type JobHours =
  | { phrase: string; tz: string; start: string; end: string }
  | { phrase: string; tz: string; overlapHours: number };

const MANILA_OFFSET_MINUTES = 8 * 60; // Asia/Manila is UTC+8 all year; there is no DST.

type Zone = { tz: string; label: string };

const ZONES: readonly (readonly [RegExp, Zone])[] = [
  [/^(?:ET|EST|EDT|Eastern(?: Time)?|US Eastern|New York)$/i, { tz: "America/New_York", label: "ET" }],
  [/^(?:CT|CST|CDT|Central(?: Time)?|US Central|Chicago)$/i, { tz: "America/Chicago", label: "CT" }],
  [/^(?:MT|MST|MDT|Mountain(?: Time)?|US Mountain|Denver)$/i, { tz: "America/Denver", label: "MT" }],
  [
    /^(?:PT|PST|PDT|Pacific(?: Time)?|US Pacific|Los Angeles|San Francisco)$/i,
    { tz: "America/Los_Angeles", label: "PT" },
  ],
  [/^(?:GMT|UTC)$/i, { tz: "UTC", label: "UTC" }],
  [/^(?:BST|UK(?: time)?|London)$/i, { tz: "Europe/London", label: "UK time" }],
  [/^(?:CET|CEST|Central European(?: Time)?|Berlin|Amsterdam)$/i, { tz: "Europe/Berlin", label: "CET" }],
  [/^(?:AEST|AEDT|Sydney)$/i, { tz: "Australia/Sydney", label: "Sydney time" }],
  [/^(?:SGT|Singapore)$/i, { tz: "Asia/Singapore", label: "SGT" }],
  [/^(?:PHT|PHST|PST8|Manila|Philippine(?: time)?|Philippines)$/i, { tz: "Asia/Manila", label: "PHT" }],
  [/^(?:IST|India)$/i, { tz: "Asia/Kolkata", label: "IST" }],
];

const ZONE_WORDS = `(?:US Eastern|US Central|US Mountain|US Pacific|Eastern(?: Time)?|Central European(?: Time)?|Central(?: Time)?|Mountain(?: Time)?|Pacific(?: Time)?|New York|Chicago|Denver|Los Angeles|San Francisco|London|Berlin|Amsterdam|Sydney|Singapore|Manila|Philippine(?: time)?|India|UK(?: time)?|(?-i:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|GMT|UTC|BST|CET|CEST|AEST|AEDT|SGT|PHT|IST))`;

function zoneOf(word: string): Zone | null {
  const w = word.trim();
  for (const [re, zone] of ZONES) if (re.test(w)) return zone;
  return null;
}

function labelOf(tz: string): string {
  return ZONES.find(([, z]) => z.tz === tz)?.[1].label ?? tz;
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?`;
const RANGE_RE = new RegExp(
  String.raw`\b${TIME}\s*(?:-|–|—|to|until)\s*${TIME}\s*(?:\(\s*)?(?:in\s+)?(${ZONE_WORDS})\b`,
  "i",
);
const OVERLAP_RE = new RegExp(
  String.raw`\b(\d{1,2})\+?\s*(?:hours?|hrs?)\b[^.\n]{0,40}?\boverlap\b[^.\n]{0,30}?\b(${ZONE_WORDS})\b|\boverlap\b[^.\n]{0,30}?\b(\d{1,2})\+?\s*(?:hours?|hrs?)\b[^.\n]{0,30}?\b(${ZONE_WORDS})\b`,
  "i",
);

function clock(hourText: string, minuteText: string | undefined, meridiem: string | undefined): string | null {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (!Number.isInteger(hour) || minute > 59) return null;
  const m = meridiem?.toLowerCase().replace(/\./g, "");
  if (m !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (m === "pm" && hour < 12) hour += 12;
    if (m === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * "1 - 5pm" means 1 PM; "9 to 5pm" means 9 AM: the start takes the end's am/pm unless that
 * would put it after the end.
 */
function inferredMeridiem({ h1, h2, ap2 }: { h1: string; h2: string; ap2: string | undefined }): string | undefined {
  if (ap2 === undefined) return undefined;
  const flips = Number(h1) > Number(h2) && Number(h1) !== 12;
  if (!flips) return ap2;
  return /p/i.test(ap2) ? "am" : "pm";
}

/**
 * The first stated working-hours range ("9am to 5pm ET", "09:00-17:00 CET") or overlap
 * requirement ("at least 4 hours of overlap with PST") in `text`, or null.
 */
export function parseHours(text: string): JobHours | null {
  const range = RANGE_RE.exec(text);
  if (range) {
    const [whole, h1 = "", m1, ap1, h2 = "", m2, ap2, zoneWord = ""] = range;
    const zone = zoneOf(zoneWord);
    const start = clock(h1, m1, ap1 ?? inferredMeridiem({ h1, h2, ap2 }));
    const end = clock(h2, m2, ap2);
    if (zone && start && end) return { phrase: whole.trim(), tz: zone.tz, start, end };
  }
  const overlap = OVERLAP_RE.exec(text);
  if (overlap) {
    const hours = Number(overlap[1] ?? overlap[3]);
    const zone = zoneOf(overlap[2] ?? overlap[4] ?? "");
    if (zone && hours > 0 && hours <= 12) return { phrase: overlap[0].trim(), tz: zone.tz, overlapHours: hours };
  }
  return null;
}

/** Minutes east of UTC for `tz` at `instant`, from the runtime's time zone data. */
export function offsetMinutes({ tz, instant }: { tz: string; instant: Date }): number {
  if (tz === "Asia/Manila") return MANILA_OFFSET_MINUTES;
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** The calendar date (year, month, day) of `instant` in `tz`. */
function dateIn({ tz, instant }: { tz: string; instant: Date }): { y: number; m: number; d: number } {
  const local = new Date(instant.getTime() + offsetMinutes({ tz, instant }) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
}

/** The instant when the wall clock in `tz` reads `hhmm` on the date `on` has there. */
function wallTime({ tz, on, hhmm }: { tz: string; on: Date; hhmm: string }): Date {
  const { y, m, d } = dateIn({ tz, instant: on });
  const [h = 0, min = 0] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, m, d, h, min);
  // Two passes settle the offset even when the guess lands on the other side of a DST change.
  let utc = naive - offsetMinutes({ tz, instant: new Date(naive) }) * 60_000;
  utc = naive - offsetMinutes({ tz, instant: new Date(utc) }) * 60_000;
  return new Date(utc);
}

function manilaClock(instant: Date): string {
  const t = new Date(instant.getTime() + MANILA_OFFSET_MINUTES * 60_000);
  const h = t.getUTCHours();
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** "9:00 AM" style for a "HH:MM" clock in the posting's zone. */
function plainClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function windowInManila({ tz, on, start, end }: { tz: string; on: Date; start: string; end: string }): string {
  return `${manilaClock(wallTime({ tz, on, hhmm: start }))} to ${manilaClock(wallTime({ tz, on, hhmm: end }))} PHT`;
}

/**
 * The hours in Philippine time on the date `on` (the posting date), e.g. "9am to 5pm ET" on a
 * January date is "10:00 PM to 6:00 AM PHT". For an overlap requirement, the zone's 9 AM to
 * 5 PM working day is shown in PHT, labelled as such.
 */
export function toManila({ hours, on }: { hours: JobHours; on: Date }): string {
  if ("overlapHours" in hours) {
    const day = windowInManila({ tz: hours.tz, on, start: "09:00", end: "17:00" });
    const n = hours.overlapHours;
    return `${n} ${n === 1 ? "hour" : "hours"} of overlap with ${labelOf(hours.tz)}; their 9:00 AM to 5:00 PM is ${day}`;
  }
  if (hours.tz === "Asia/Manila") return `${plainClock(hours.start)} to ${plainClock(hours.end)} PHT`;
  return windowInManila({ tz: hours.tz, on, start: hours.start, end: hours.end });
}
