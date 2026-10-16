import { applyUrlKey, companyKey, titleKey } from "./dedup";
import { classifyEligibility } from "./eligibility";
import { extractSkills, minYears, seniority } from "./features";
import { parseHours } from "./hours";
import { type Pay, parsePay } from "./pay";
import { contentHash, descriptionKey } from "./text";

// One normalizer for every way a job arrives: paste, link, and sync (section 3.1 step 4).

/** What a job is made from, however it arrived. */
export type JobFields = {
  title: string;
  company: string;
  description: string;
  locationText: string;
  applyUrl: string | null;
  postedAt: Date | null;
  expiresAt: Date | null;
  /** Pay the page gave as data; otherwise it is read from the description. */
  pay: Pay | null;
  restrictions: readonly string[] | null;
};

/** The stored columns derived from a job's fields (section 3.1 step 4): keys, features, pay, hours, eligibility. */
export function derive(fields: JobFields) {
  const pay = fields.pay ?? parsePay(fields.description);
  const eligibility = classifyEligibility({
    description: fields.description,
    locationText: fields.locationText,
    structured: fields.restrictions === null ? null : { restrictions: fields.restrictions },
  });
  const payPhrase = pay?.phrase ?? null;
  return {
    title: fields.title,
    company: fields.company,
    titleKey: titleKey(fields.title),
    companyKey: companyKey(fields.company),
    applyUrl: fields.applyUrl,
    applyUrlKey: fields.applyUrl === null ? null : applyUrlKey(fields.applyUrl),
    locationText: fields.locationText,
    description: fields.description,
    contentHash: contentHash({
      title: fields.title,
      company: fields.company,
      locationText: fields.locationText,
      description: fields.description,
      payPhrase,
    }),
    descriptionKey: descriptionKey(fields.description),
    postedAt: fields.postedAt,
    expiresAt: fields.expiresAt,
    payMin: pay ? String(pay.min) : null,
    payMax: pay?.max == null ? null : String(pay.max),
    payCurrency: pay?.currency ?? null,
    payPeriod: pay?.period ?? null,
    payPhrase,
    hours: parseHours(fields.description),
    skills: extractSkills(`${fields.title}\n${fields.description}`),
    seniority: seniority(fields.title),
    minYears: minYears(fields.description),
    eligibility: eligibility.verdict,
    eligibilityPhrase: eligibility.phrase,
    eligibilityBy: "rule" as const,
  };
}

export type Derived = ReturnType<typeof derive>;
